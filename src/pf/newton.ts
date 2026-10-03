import { Cx, fromPolar, isFiniteCx } from "./complex";
import { calcInjections } from "./ybus";
import { IterationRecord } from "../types";
import { PreparedBus } from "./validate";

export interface NrState {
  vm: number[]; // per bus index
  va: number[]; // radians
}

export interface NrOutcome {
  ok: boolean;
  stopReason: string;
  iterations: IterationRecord[];
  state: NrState;
  finalMaxMismatch: number;
}

// 高斯消元 (部分主元), 奇异时返回 null
export function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++)
      if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let c = r + 1; c < n; c++) s -= M[r][c] * x[c];
    x[r] = s / M[r][r];
  }
  return x;
}

export interface BusKind { type: "slack" | "pv" | "pq"; }

// 解析雅可比 (极坐标): 行 = [非平衡P, PQ的Q], 列 = [非平衡相角, PQ幅值]
export function buildJacobian(
  Y: Cx[],
  n: number,
  buses: BusKind[],
  state: NrState
): { J: number[][]; angleBuses: number[]; voltBuses: number[] } {
  const angleBuses: number[] = [];
  const voltBuses: number[] = [];
  buses.forEach((b, i) => {
    if (b.type !== "slack") angleBuses.push(i);
    if (b.type === "pq") voltBuses.push(i);
  });
  const na = angleBuses.length, nv = voltBuses.length, m = na + nv;
  const G = (i: number, j: number) => Y[i * n + j].re;
  const B = (i: number, j: number) => Y[i * n + j].im;
  const J: number[][] = Array.from({ length: m }, () => new Array(m).fill(0));
  const dth = (i: number, k: number) => state.va[i] - state.va[k];
  for (let a = 0; a < na; a++) {
    const i = angleBuses[a];
    for (let b2 = 0; b2 < na; b2++) {
      const j = angleBuses[b2];
      if (i === j) {
        let s = 0;
        for (let k = 0; k < n; k++)
          if (k !== i) s += state.vm[k] * (G(i, k) * Math.sin(dth(i, k)) - B(i, k) * Math.cos(dth(i, k)));
        J[a][b2] = -state.vm[i] * s;
      } else {
        J[a][b2] = state.vm[i] * state.vm[j] * (G(i, j) * Math.sin(dth(i, j)) - B(i, j) * Math.cos(dth(i, j)));
      }
    }
    for (let b2 = 0; b2 < nv; b2++) {
      const j = voltBuses[b2];
      if (i === j) {
        let s = 2 * state.vm[i] * G(i, i);
        for (let k = 0; k < n; k++)
          if (k !== i) s += state.vm[k] * (G(i, k) * Math.cos(dth(i, k)) + B(i, k) * Math.sin(dth(i, k)));
        J[a][na + b2] = s;
      } else {
        J[a][na + b2] = state.vm[i] * (G(i, j) * Math.cos(dth(i, j)) + B(i, j) * Math.sin(dth(i, j)));
      }
    }
  }
  for (let a = 0; a < nv; a++) {
    const i = voltBuses[a];
    for (let b2 = 0; b2 < na; b2++) {
      const j = angleBuses[b2];
      if (i === j) {
        let s = 0;
        for (let k = 0; k < n; k++)
          if (k !== i) s += state.vm[k] * (G(i, k) * Math.cos(dth(i, k)) + B(i, k) * Math.sin(dth(i, k)));
        J[na + a][b2] = state.vm[i] * s;
      } else {
        J[na + a][b2] = -state.vm[i] * state.vm[j] * (G(i, j) * Math.cos(dth(i, j)) + B(i, j) * Math.sin(dth(i, j)));
      }
    }
    for (let b2 = 0; b2 < nv; b2++) {
      const j = voltBuses[b2];
      if (i === j) {
        let s = -2 * state.vm[i] * B(i, i);
        for (let k = 0; k < n; k++)
          if (k !== i) s += state.vm[k] * (G(i, k) * Math.sin(dth(i, k)) - B(i, k) * Math.cos(dth(i, k)));
        J[na + a][na + b2] = s;
      } else {
        J[na + a][na + b2] = state.vm[i] * (G(i, j) * Math.sin(dth(i, j)) - B(i, j) * Math.cos(dth(i, j)));
      }
    }
  }
  return { J, angleBuses, voltBuses };
}

// 极坐标 NR: 未知量 = 非平衡母线相角 + PQ 母线电压幅值
export function newtonRaphson(
  Y: Cx[],
  buses: PreparedBus[],
  pSpec: number[], // 指定注入 P (发电-负荷), pu, 仅非平衡母线使用
  qSpec: number[], // 指定注入 Q, pu, 仅 PQ 母线使用
  init: NrState,
  tolerance: number,
  maxIter: number
): NrOutcome {
  const n = buses.length;
  const angleBuses: number[] = [];
  const voltBuses: number[] = [];
  buses.forEach((b, i) => {
    if (b.type !== "slack") angleBuses.push(i);
    if (b.type === "pq") voltBuses.push(i);
  });
  const na = angleBuses.length, nv = voltBuses.length, m = na + nv;
  const state: NrState = { vm: [...init.vm], va: [...init.va] };
  const iterations: IterationRecord[] = [];

  if (m === 0) {
    return { ok: true, stopReason: "仅含平衡母线, 无需求解", iterations, state, finalMaxMismatch: 0 };
  }

  for (let iter = 0; iter < maxIter; iter++) {
    const V = state.vm.map((m_, i) => fromPolar(m_, state.va[i]));
    const S = calcInjections(Y, V);
    // 失配向量
    const mis = new Array(m).fill(0);
    angleBuses.forEach((bi, k) => (mis[k] = pSpec[bi] - S[bi].re));
    voltBuses.forEach((bi, k) => (mis[na + k] = qSpec[bi] - S[bi].im));
    let maxMis = 0;
    for (const v of mis) maxMis = Math.max(maxMis, Math.abs(v));
    if (!Number.isFinite(maxMis))
      return { ok: false, stopReason: "功率不平衡出现非有限值", iterations, state, finalMaxMismatch: Infinity };
    if (maxMis < tolerance)
      return { ok: true, stopReason: `收敛: 最大不平衡 ${maxMis.toExponential(3)} < 容差 ${tolerance}`, iterations, state, finalMaxMismatch: maxMis };

    // 解析雅可比
    const { J } = buildJacobian(Y, n, buses, state);

    const dx = solveLinear(J, mis);
    if (dx === null)
      return { ok: false, stopReason: "雅可比矩阵奇异, 无法求解修正量", iterations, state, finalMaxMismatch: maxMis };

    // 阻尼: 限制单步电压幅值变化, 避免数值爆炸
    let stepNorm = 0;
    for (const d of dx) stepNorm = Math.max(stepNorm, Math.abs(d));
    const damp = stepNorm > 5 ? 5 / stepNorm : 1;
    angleBuses.forEach((bi, k) => (state.va[bi] += damp * dx[k]));
    voltBuses.forEach((bi, k) => (state.vm[bi] += damp * dx[na + k]));
    iterations.push({ iter, maxMismatch: maxMis, stepNorm: stepNorm * damp });

    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(state.vm[i]) || !Number.isFinite(state.va[i]))
        return { ok: false, stopReason: "迭代产生非有限电压", iterations, state, finalMaxMismatch: maxMis };
    }
    if (state.vm.some((v) => v <= 0))
      return { ok: false, stopReason: "电压幅值非正, 迭代发散", iterations, state, finalMaxMismatch: maxMis };
  }
  const V = state.vm.map((m_, i) => fromPolar(m_, state.va[i]));
  const S = calcInjections(Y, V);
  let maxMis = 0;
  angleBuses.forEach((bi) => (maxMis = Math.max(maxMis, Math.abs(pSpec[bi] - S[bi].re))));
  voltBuses.forEach((bi) => (maxMis = Math.max(maxMis, Math.abs(qSpec[bi] - S[bi].im))));
  return { ok: false, stopReason: `迭代预算耗尽 (${maxIter} 次), 最大不平衡 ${maxMis.toExponential(3)}`, iterations, state, finalMaxMismatch: maxMis };
}
