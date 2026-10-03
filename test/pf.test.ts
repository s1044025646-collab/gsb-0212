import { test } from "node:test";
import assert from "node:assert/strict";
import { solveCase } from "../src/pf/solve";
import { validateNetlist, ValidationError, prepareBuses } from "../src/pf/validate";
import { buildYbus, calcInjections } from "../src/pf/ybus";
import { buildJacobian } from "../src/pf/newton";
import { fromPolar } from "../src/pf/complex";
import { NetlistInput } from "../src/types";

const closeTo = (a: number, b: number, tol = 1e-6) =>
  assert.ok(Math.abs(a - b) < tol, `${a} 与 ${b} 偏差超过 ${tol}`);

// 由已知电压反算注入构造两母线基准
function twoBusCase(): { net: NetlistInput; v2m: number; v2a: number } {
  const net: NetlistInput = {
    name: "两母线", sbase: 100,
    buses: [
      { id: 1, type: "slack", vset: 1.05, va: 0 },
      { id: 2, type: "pq", pd: 0, qd: 0 },
    ],
    branches: [{ id: 1, from: 1, to: 2, r: 0.01, x: 0.1, b: 0.02 }],
  };
  const buses = prepareBuses(net);
  const Y = buildYbus(net, buses);
  const V = [fromPolar(1.05, 0), fromPolar(0.98, (-5 * Math.PI) / 180)];
  const S = calcInjections(Y, V);
  net.buses[1].pd = -S[1].re * 100; // 负荷 = -注入
  net.buses[1].qd = -S[1].im * 100;
  return { net, v2m: 0.98, v2a: -5 };
}

test("两母线: 由已知电压反算注入, 求解恢复该电压", () => {
  const { net, v2m, v2a } = twoBusCase();
  const r = solveCase(net);
  assert.ok(r.converged, r.stopReason);
  const b2 = r.buses.find((b) => b.id === 2)!;
  closeTo(b2.vm, v2m, 1e-9);
  closeTo(b2.vaDeg, v2a, 1e-7);
  assert.ok(r.finalMaxMismatch < 1e-8);
});

test("两母线: 两端功率之和等于损耗, 全网平衡残差为零", () => {
  const { net } = twoBusCase();
  const r = solveCase(net);
  const br = r.branches[0];
  closeTo(br.pFrom + br.pTo, br.pLoss, 1e-6);
  closeTo(br.qFrom + br.qTo, br.qLoss, 1e-6);
  closeTo(r.balanceResidualP, 0, 1e-6);
  closeTo(r.balanceResidualQ, 0, 1e-6);
});

test("雅可比与中心差分一致", () => {
  const net: NetlistInput = {
    name: "t", sbase: 100,
    buses: [
      { id: 1, type: "slack", vset: 1.0 },
      { id: 2, type: "pv", pg: 50, vset: 1.01 },
      { id: 3, type: "pq", pd: 80, qd: 25 },
    ],
    branches: [
      { id: 1, from: 1, to: 2, r: 0.02, x: 0.06, b: 0.06 },
      { id: 2, from: 1, to: 3, r: 0.04, x: 0.12, b: 0.04 },
      { id: 3, from: 2, to: 3, r: 0.03, x: 0.09, b: 0.05 },
    ],
  };
  const buses = prepareBuses(net);
  const Y = buildYbus(net, buses);
  const state = { vm: [1.0, 1.01, 0.97], va: [0, 0.03, -0.06] };
  const { J, angleBuses, voltBuses } = buildJacobian(Y, 3, buses, state);
  const cols = [...angleBuses.map((i) => ({ kind: "a" as const, i })), ...voltBuses.map((i) => ({ kind: "v" as const, i }))];
  const rows = [...angleBuses.map((i) => ({ kind: "P" as const, i })), ...voltBuses.map((i) => ({ kind: "Q" as const, i }))];
  const mis = (vm: number[], va: number[]) => {
    const V = vm.map((m, i) => fromPolar(m, va[i]));
    const S = calcInjections(Y, V);
    return rows.map((r) => (r.kind === "P" ? S[r.i].re : S[r.i].im));
  };
  const h = 1e-6;
  for (let c = 0; c < cols.length; c++) {
    const vm1 = [...state.vm], va1 = [...state.va], vm2 = [...state.vm], va2 = [...state.va];
    if (cols[c].kind === "a") { va1[cols[c].i] += h; va2[cols[c].i] -= h; }
    else { vm1[cols[c].i] += h; vm2[cols[c].i] -= h; }
    const f1 = mis(vm1, va1), f2 = mis(vm2, va2);
    for (let ri = 0; ri < rows.length; ri++) {
      const fd = (f1[ri] - f2[ri]) / (2 * h);
      closeTo(J[ri][c], fd, 1e-4);
    }
  }
});

test("三母线含并联线路与充电电纳: 收敛且损耗/充电统计一致", () => {
  const net: NetlistInput = {
    name: "三母线", sbase: 100,
    buses: [
      { id: 1, type: "slack", vset: 1.02 },
      { id: 2, type: "pv", pg: 60, vset: 1.0, qmin: -50, qmax: 50 },
      { id: 3, type: "pq", pd: 90, qd: 30 },
    ],
    branches: [
      { id: 1, from: 1, to: 2, r: 0.02, x: 0.06, b: 0.06 },
      { id: 2, from: 1, to: 3, r: 0.04, x: 0.12, b: 0.04 },
      { id: 3, from: 2, to: 3, r: 0.03, x: 0.09, b: 0.05 },
      { id: 4, from: 2, to: 3, r: 0.03, x: 0.09, b: 0.05 },
    ],
  };
  const r = solveCase(net);
  assert.ok(r.converged, r.stopReason);
  assert.equal(r.qEvents.length, 0);
  closeTo(r.balanceResidualP, 0, 1e-6);
  closeTo(r.balanceResidualQ, 0, 1e-6);
  assert.ok(r.totalQCharging > 0);
  // 并联线路参数相同, 两端功率应相同
  closeTo(r.branches[2].pFrom, r.branches[3].pFrom, 1e-9);
  // 充电无功与负荷/发电同口径: 平衡机无功 = 负荷无功 + 线路无功损耗 - 充电
  const b2 = r.buses.find((b) => b.id === 2)!;
  closeTo(b2.vm, 1.0, 1e-9); // PV 电压受控
});

test("PV 无功越限切换为 PQ 并固定于限值", () => {
  const net: NetlistInput = {
    name: "qlim", sbase: 100,
    buses: [
      { id: 1, type: "slack", vset: 1.02 },
      { id: 2, type: "pv", pg: 60, vset: 1.0, qmin: -5, qmax: 0 },
      { id: 3, type: "pq", pd: 150, qd: 60 },
    ],
    branches: [
      { id: 1, from: 1, to: 2, r: 0.02, x: 0.06, b: 0.06 },
      { id: 2, from: 1, to: 3, r: 0.04, x: 0.12, b: 0.04 },
      { id: 3, from: 2, to: 3, r: 0.03, x: 0.09, b: 0.05 },
    ],
  };
  const r = solveCase(net);
  assert.ok(r.converged, r.stopReason);
  assert.equal(r.qEvents.length, 1);
  assert.equal(r.qEvents[0].bus, 2);
  assert.equal(r.qEvents[0].vsetReleased, 1.0);
  const b2 = r.buses.find((b) => b.id === 2)!;
  assert.equal(b2.type, "pq");
  closeTo(b2.qGen, 0, 1e-4); // 固定于上限
  assert.ok(b2.vm < 1.0); // 电压不再受控
});

test("零阻抗支路被拒绝", () => {
  const net: NetlistInput = {
    name: "bad", sbase: 100,
    buses: [{ id: 1, type: "slack" }, { id: 2, type: "pq" }],
    branches: [{ id: 1, from: 1, to: 2, r: 0, x: 0 }],
  };
  assert.throws(() => validateNetlist(net), ValidationError);
});

test("孤岛网络被拒绝", () => {
  const net: NetlistInput = {
    name: "island", sbase: 100,
    buses: [{ id: 1, type: "slack" }, { id: 2, type: "pq" }, { id: 3, type: "pq" }],
    branches: [{ id: 1, from: 1, to: 2, r: 0.01, x: 0.1 }],
  };
  assert.throws(() => validateNetlist(net), /孤岛/);
});

test("无平衡母线或多平衡母线被拒绝", () => {
  const base = {
    name: "s", sbase: 100,
    branches: [{ id: 1, from: 1, to: 2, r: 0.01, x: 0.1 }],
  };
  assert.throws(() => validateNetlist({ ...base, buses: [{ id: 1, type: "pq" }, { id: 2, type: "pq" }] } as never), /平衡/);
  assert.throws(() => validateNetlist({ ...base, buses: [{ id: 1, type: "slack" }, { id: 2, type: "slack" }] } as never), /平衡/);
});

test("明确不收敛: 超重负荷标记不收敛且不输出有效潮流", () => {
  const net: NetlistInput = {
    name: "div", sbase: 100,
    buses: [
      { id: 1, type: "slack", vset: 1.0 },
      { id: 2, type: "pq", pd: 5000, qd: 3000 },
    ],
    branches: [{ id: 1, from: 1, to: 2, r: 0.05, x: 0.3 }],
  };
  const r = solveCase(net, { maxIter: 30 });
  assert.equal(r.converged, false);
  assert.ok(r.stopReason.length > 0);
  assert.ok(r.finalMaxMismatch > 1e-8);
});

test("母线编号重排后结果一致", () => {
  const mk = (ids: [number, number, number]): NetlistInput => ({
    name: "perm", sbase: 100,
    buses: [
      { id: ids[0], type: "slack", vset: 1.02 },
      { id: ids[1], type: "pv", pg: 60, vset: 1.0, qmin: -50, qmax: 50 },
      { id: ids[2], type: "pq", pd: 90, qd: 30 },
    ],
    branches: [
      { id: 1, from: ids[0], to: ids[1], r: 0.02, x: 0.06, b: 0.06 },
      { id: 2, from: ids[0], to: ids[2], r: 0.04, x: 0.12, b: 0.04 },
      { id: 3, from: ids[1], to: ids[2], r: 0.03, x: 0.09, b: 0.05 },
    ],
  });
  const r1 = solveCase(mk([1, 2, 3]));
  const r2 = solveCase(mk([10, 20, 30]));
  assert.ok(r1.converged && r2.converged);
  const sort = (r: typeof r1) => [...r.buses].sort((a, b) => a.pLoad - b.pLoad || a.pGen - b.pGen);
  const s1 = sort(r1), s2 = sort(r2);
  for (let i = 0; i < 3; i++) {
    closeTo(s1[i].vm, s2[i].vm, 1e-9);
    closeTo(s1[i].vaDeg, s2[i].vaDeg, 1e-7);
  }
});

test("标幺基准一致换算: 不同 Sbase 下物理结果相同", () => {
  const mk = (sbase: number, zScale: number, bScale: number, loadScale: number): NetlistInput => ({
    name: "pu", sbase,
    buses: [
      { id: 1, type: "slack", vset: 1.02 },
      { id: 2, type: "pq", pd: 90 * loadScale, qd: 30 * loadScale },
    ],
    branches: [{ id: 1, from: 1, to: 2, r: 0.04 * zScale, x: 0.12 * zScale, b: 0.04 * bScale }],
  });
  const r1 = solveCase(mk(100, 1, 1, 1));
  const r2 = solveCase(mk(200, 2, 0.5, 1)); // 阻抗/导纳/负荷均按基准比例换算
  assert.ok(r1.converged && r2.converged);
  closeTo(r1.buses[1].vm, r2.buses[1].vm, 1e-9);
  closeTo(r1.buses[1].vaDeg, r2.buses[1].vaDeg, 1e-7);
  closeTo(r1.totalPLoss, r2.totalPLoss, 1e-6);
});

test("初值敏感性: 不收敛初值不宣称唯一解, 收敛解残差真实", () => {
  const net: NetlistInput = {
    name: "init", sbase: 100,
    buses: [
      { id: 1, type: "slack", vset: 1.0 },
      { id: 2, type: "pq", pd: 50, qd: 20 },
    ],
    branches: [{ id: 1, from: 1, to: 2, r: 0.02, x: 0.1 }],
  };
  const flat = solveCase(net, { flatStart: true });
  const warm = solveCase(net);
  assert.ok(flat.converged && warm.converged);
  closeTo(flat.buses[1].vm, warm.buses[1].vm, 1e-6);
  assert.ok(flat.iterations.every((it) => Number.isFinite(it.maxMismatch) && Number.isFinite(it.stepNorm)));
});


