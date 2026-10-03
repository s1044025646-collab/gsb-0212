import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { solve } from '../src/solve';
import { validateNetlist } from '../src/network';
import { buildYbus } from '../src/ybus';
import { buildJacobian, injections } from '../src/powerflow';
import { PfDb } from '../src/db';
import { Netlist } from '../src/types';

/** 独立复数反算注入（不经过求解器代码），用于构造基准。 */
function manualInjection(
  branches: { from: number; to: number; r: number; x: number; b: number }[],
  volts: Map<number, { vm: number; va: number }>,
  bus: number,
): { P: number; Q: number } {
  const v = (id: number) => {
    const t = volts.get(id)!;
    return { re: t.vm * Math.cos(t.va), im: t.vm * Math.sin(t.va) };
  };
  let sRe = 0;
  let sIm = 0;
  for (const br of branches) {
    if (br.from !== bus && br.to !== bus) continue;
    const other = br.from === bus ? br.to : br.from;
    const denom = br.r * br.r + br.x * br.x;
    const g = br.r / denom;
    const bSer = -br.x / denom;
    const bc = br.b / 2;
    const a = v(bus);
    const c = v(other);
    const dRe = a.re - c.re;
    const dIm = a.im - c.im;
    const iRe = dRe * g - dIm * bSer - a.im * bc;
    const iIm = dRe * bSer + dIm * g + a.re * bc;
    sRe += a.re * iRe + a.im * iIm;
    sIm += a.im * iRe - a.re * iIm;
  }
  return { P: sRe, Q: sIm };
}

test('两母线：已知电压反算注入构造基准，求解恢复电压', () => {
  const branches = [{ id: 1, from: 1, to: 2, r: 0.02, x: 0.1, b: 0.04 }];
  const volts = new Map([
    [1, { vm: 1.02, va: 0 }],
    [2, { vm: 0.97, va: -0.08 }],
  ]);
  const { P, Q } = manualInjection(branches, volts, 2);
  const net: Netlist = {
    sbase: 100,
    buses: [
      { id: 1, type: 'slack', vm: 1.02, va: 0, pl: 0, ql: 0, pg: 0, qg: 0 },
      { id: 2, type: 'pq', vm: 1.0, va: 0, pl: -P, ql: -Q, pg: 0, qg: 0 },
    ],
    branches,
  };
  const r = solve(net);
  assert.equal(r.converged, true);
  assert.equal(r.stopReason, 'converged');
  const b2 = r.buses.find((b) => b.id === 2)!;
  assert.ok(Math.abs(b2.vm - 0.97) < 1e-8, `vm=${b2.vm}`);
  assert.ok(Math.abs(b2.va + 0.08) < 1e-8, `va=${b2.va}`);
  const br = r.branches[0];
  assert.ok(br.pLoss > 0);
  assert.ok(Math.abs(r.residualP - br.pLoss) < 1e-9);
});

function threeBusNet(): Netlist {
  return {
    sbase: 100,
    buses: [
      { id: 1, type: 'slack', vm: 1.03, va: 0, pl: 0, ql: 0, pg: 0, qg: 0 },
      { id: 2, type: 'pv', vm: 1.01, va: 0, pl: 0.2, ql: 0.1, pg: 0.8, qg: 0, qmin: -0.5, qmax: 0.9 },
      { id: 3, type: 'pq', vm: 1.0, va: 0, pl: 0.9, ql: 0.4, pg: 0, qg: 0 },
    ],
    branches: [
      { id: 1, from: 1, to: 2, r: 0.02, x: 0.08, b: 0.06 },
      { id: 2, from: 1, to: 3, r: 0.03, x: 0.12, b: 0.05 },
      { id: 3, from: 2, to: 3, r: 0.025, x: 0.1, b: 0.04 },
      { id: 4, from: 2, to: 3, r: 0.04, x: 0.15, b: 0.03 },
    ],
  };
}

test('三母线（含并联线路与充电电纳）：收敛、残差与损耗一致', () => {
  const r = solve(threeBusNet());
  assert.equal(r.converged, true, r.stopReason);
  assert.ok(Math.abs(r.residualP) > 0);
  const sumPLoss = r.branches.reduce((s, b) => s + b.pLoss, 0);
  const sumQLoss = r.branches.reduce((s, b) => s + b.qLoss, 0);
  assert.ok(Math.abs(r.residualP - sumPLoss) < 1e-9);
  assert.ok(Math.abs(r.residualQ - sumQLoss) < 1e-9);
  for (const br of r.branches) {
    assert.ok(Math.abs(br.pFrom + br.pTo - br.pLoss) < 1e-12);
    assert.ok(br.pLoss > 0);
  }
  const b2 = r.buses.find((b) => b.id === 2)!;
  assert.ok(Math.abs(b2.vm - 1.01) < 1e-8);
  assert.ok(r.finalMismatch < 1e-8);
  assert.ok(r.iterations.length >= 2);
  assert.ok(r.iterations.every((it) => Number.isFinite(it.maxMismatch)));
});

test('PV 无功越限：转 PQ 并固定限值，原电压设定失效', () => {
  const net = threeBusNet();
  net.buses[1].qmax = -0.1; // 该工况 Qg≈-0.08，收紧上限至 -0.1 迫使越限
  const r = solve(net);
  assert.equal(r.converged, true);
  assert.equal(r.pvSwitches.length, 1);
  const sw = r.pvSwitches[0];
  assert.equal(sw.busId, 2);
  assert.equal(sw.limit, 'qmax');
  assert.equal(sw.qFixed, -0.1);
  assert.equal(sw.originalVSet, 1.01);
  const b2 = r.buses.find((b) => b.id === 2)!;
  assert.equal(b2.effectiveType, 'pq');
  assert.ok(Math.abs(b2.qg + 0.1) < 1e-6, `Qg=${b2.qg}`);
  assert.ok(Math.abs(b2.vm - 1.01) > 1e-4);
  assert.ok(r.finalMismatch < 1e-8);
});

test('零阻抗支路非法', () => {
  const net = threeBusNet();
  net.branches[0].r = 0;
  net.branches[0].x = 0;
  assert.ok(validateNetlist(net).some((e) => e.includes('阻抗为零')));
  assert.throws(() => solve(net), /阻抗为零/);
});

test('孤岛网络非法', () => {
  const net = threeBusNet();
  net.buses.push({ id: 9, type: 'pq', vm: 1, va: 0, pl: 0.1, ql: 0, pg: 0, qg: 0 });
  const errors = validateNetlist(net);
  assert.ok(errors.some((e) => e.includes('不连通')));
});

test('无平衡母线或双平衡母线非法', () => {
  const net = threeBusNet();
  net.buses[0].type = 'pq';
  assert.ok(validateNetlist(net).some((e) => e.includes('恰有一个平衡母线')));
  net.buses[0].type = 'slack';
  net.buses[1].type = 'slack';
  assert.ok(validateNetlist(net).some((e) => e.includes('恰有一个平衡母线')));
});

test('明确不收敛：过重负荷耗尽迭代预算且不作为有效潮流', () => {
  const net = threeBusNet();
  net.buses[2].pl = 50;
  const r = solve(net, { maxIter: 30 });
  assert.equal(r.converged, false);
  assert.ok(['max_iter_exceeded', 'non_finite_state', 'jacobian_singular'].includes(r.stopReason));
  assert.ok(r.iterations.length > 0);
});

test('雅可比与有限差分一致', () => {
  const net = threeBusNet();
  const ids = [1, 2, 3];
  const indexOf = (id: number) => ids.indexOf(id);
  const { G, B } = buildYbus(3, net.branches, indexOf);
  const vm = [1.03, 1.0, 0.98];
  const va = [0, -0.03, -0.07];
  const angBuses = [1, 2];
  const pqBuses = [2];
  const { P, Q } = injections(G, B, vm, va);
  const J = buildJacobian(G, B, vm, va, P, Q, angBuses, pqBuses);
  const mismatch = (vmV: number[], vaV: number[]) => {
    const ij = injections(G, B, vmV, vaV);
    return [...angBuses.map((i) => ij.P[i]), ...pqBuses.map((i) => ij.Q[i])];
  };
  const f0 = mismatch(vm, va);
  const eps = 1e-6;
  for (let col = 0; col < 3; col++) {
    const vm2 = [...vm];
    const va2 = [...va];
    if (col < 2) va2[angBuses[col]] += eps;
    else vm2[pqBuses[col - 2]] += eps * vm2[pqBuses[col - 2]];
    const f1 = mismatch(vm2, va2);
    for (let row = 0; row < 3; row++) {
      const fd = (f1[row] - f0[row]) / eps;
      assert.ok(Math.abs(fd - J[row][col]) < 1e-4, `J[${row}][${col}]: 解析=${J[row][col]} 差分=${fd}`);
    }
  }
});

test('母线编号重排不影响结果', () => {
  const a = solve(threeBusNet());
  const net = threeBusNet();
  const map = new Map([
    [1, 30],
    [2, 10],
    [3, 20],
  ]);
  net.buses = net.buses.map((b) => ({ ...b, id: map.get(b.id)! }));
  net.branches = net.branches.map((br) => ({ ...br, from: map.get(br.from)!, to: map.get(br.to)! }));
  const b = solve(net);
  assert.equal(b.converged, true);
  for (const ba of a.buses) {
    const bb = b.buses.find((x) => x.id === map.get(ba.id))!;
    assert.ok(Math.abs(ba.vm - bb.vm) < 1e-10);
    assert.ok(Math.abs(ba.va - bb.va) < 1e-10);
  }
});

test('标幺基准一致换算：不同 sbase 下物理量相同', () => {
  const base = threeBusNet();
  const r100 = solve(base);
  const conv: Netlist = {
    sbase: 50,
    buses: base.buses.map((b) => ({
      ...b,
      pl: b.pl * 2,
      ql: b.ql * 2,
      pg: b.pg * 2,
      qg: b.qg * 2,
      qmin: b.qmin === undefined ? undefined : b.qmin * 2,
      qmax: b.qmax === undefined ? undefined : b.qmax * 2,
    })),
    // 阻抗标幺 ∝ Sbase（/2），电纳标幺 ∝ 1/Sbase（×2）
    branches: base.branches.map((br) => ({ ...br, r: br.r / 2, x: br.x / 2, b: br.b * 2 })),
  };
  const r50 = solve(conv);
  assert.equal(r50.converged, true);
  for (const b1 of r100.buses) {
    const b2 = r50.buses.find((x) => x.id === b1.id)!;
    assert.ok(Math.abs(b1.vm - b2.vm) < 1e-9, `母线${b1.id} 电压不一致`);
    assert.ok(Math.abs(b1.va - b2.va) < 1e-9);
    assert.ok(Math.abs(b1.pInj * 100 - b2.pInj * 50) < 1e-7);
  }
});

test('SQLite 冻结工况：重启后复核结果一致', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfdb-'));
  const dbPath = path.join(dir, 'test.sqlite');
  const net = threeBusNet();
  let caseId = 0;
  let first: ReturnType<typeof solve>;
  {
    const db = new PfDb(dbPath);
    caseId = db.createCase('三母线', net, { tol: 1e-10 });
    const c = db.getCase(caseId)!;
    first = solve(c.netlist, c.options);
    db.saveRun(caseId, '首次', first);
    db.close();
  }
  {
    const db = new PfDb(dbPath);
    const c = db.getCase(caseId)!;
    assert.equal(c.netlist.buses.length, 3);
    assert.equal(c.options.tol, 1e-10);
    const second = solve(c.netlist, c.options);
    assert.equal(second.converged, first.converged);
    for (let i = 0; i < 3; i++) {
      assert.equal(second.buses[i].vm, first.buses[i].vm);
      assert.equal(second.buses[i].va, first.buses[i].va);
    }
    assert.equal(db.listRuns(caseId).length, 1);
    db.close();
  }
});

test('PV 母线不同时强制给定无功：PV 的 qg 字段被忽略', () => {
  const net = threeBusNet();
  net.buses[1].qg = 999;
  const r = solve(net);
  assert.equal(r.converged, true);
  const b2 = r.buses.find((b) => b.id === 2)!;
  assert.ok(Math.abs(b2.qg) < 10, 'PV 无功由求解决定而非给定值');
});
