import { IterationRecord, StopReason } from './types';

export type EffType = 'slack' | 'pq' | 'pv';

export interface PfInput {
  G: number[][];
  B: number[][];
  types: EffType[];
  /** 指定净注入有功 Pg-Pl（非平衡母线），标幺 */
  pSpec: number[];
  /** 指定净注入无功（仅 PQ 母线），标幺 */
  qSpec: number[];
  /** 电压设定（slack、PV 母线），标幺 */
  vSet: number[];
  vm0: number[];
  va0: number[];
  tol: number;
  maxIter: number;
}

export interface PfOutput {
  converged: boolean;
  stopReason: StopReason;
  iterations: IterationRecord[];
  vm: number[];
  va: number[];
  finalMismatch: number;
}

/** 计算各母线净注入 P、Q（标幺），注入为正（发电方向）。 */
export function injections(
  G: number[][],
  B: number[][],
  vm: number[],
  va: number[],
): { P: number[]; Q: number[] } {
  const n = vm.length;
  const P = new Array(n).fill(0);
  const Q = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let p = 0;
    let q = 0;
    for (let j = 0; j < n; j++) {
      const g = G[i][j];
      const b = B[i][j];
      if (g === 0 && b === 0) continue;
      const th = va[i] - va[j];
      const c = Math.cos(th);
      const s = Math.sin(th);
      p += vm[i] * vm[j] * (g * c + b * s);
      q += vm[i] * vm[j] * (g * s - b * c);
    }
    P[i] = p;
    Q[i] = q;
  }
  return { P, Q };
}

/** 高斯消元（部分主元）解线性方程组；奇异返回 null。 */
export function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    }
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i][n];
    for (let c = i + 1; c < n; c++) s -= M[i][c] * x[c];
    x[i] = s / M[i][i];
  }
  return x;
}

/** 组装极坐标 Newton–Raphson 雅可比（ΔV 以 ΔV/V 归一）。 */
export function buildJacobian(
  G: number[][],
  B: number[][],
  vm: number[],
  va: number[],
  P: number[],
  Q: number[],
  angBuses: number[],
  pqBuses: number[],
): number[][] {
  const na = angBuses.length;
  const nv = pqBuses.length;
  const n = vm.length;
  const J: number[][] = Array.from({ length: na + nv }, () => new Array(na + nv).fill(0));
  const angPos = new Map(angBuses.map((b, k) => [b, k] as const));
  const vPos = new Map(pqBuses.map((b, k) => [b, k] as const));
  for (let i = 0; i < n; i++) {
    const rowP = angPos.get(i);
    const rowQ = vPos.get(i);
    if (rowP === undefined && rowQ === undefined) continue;
    for (let j = 0; j < n; j++) {
      const th = va[i] - va[j];
      const c = Math.cos(th);
      const s = Math.sin(th);
      let Hij: number;
      let Nij: number;
      if (i === j) {
        Hij = -Q[i] - B[i][i] * vm[i] * vm[i];
        Nij = P[i] + G[i][i] * vm[i] * vm[i];
      } else {
        if (G[i][j] === 0 && B[i][j] === 0) continue;
        Hij = vm[i] * vm[j] * (G[i][j] * s - B[i][j] * c);
        Nij = vm[i] * vm[j] * (G[i][j] * c + B[i][j] * s);
      }
      const colT = angPos.get(j);
      const colV = vPos.get(j);
      if (rowP !== undefined) {
        if (colT !== undefined) J[rowP][colT] = Hij;
        if (colV !== undefined) J[rowP][na + colV] = Nij;
      }
      if (rowQ !== undefined) {
        if (colT !== undefined) J[na + rowQ][colT] = i === j ? P[i] - G[i][i] * vm[i] * vm[i] : -Nij;
        if (colV !== undefined) J[na + rowQ][na + colV] = i === j ? Q[i] - B[i][i] * vm[i] * vm[i] : Hij;
      }
    }
  }
  return J;
}

/** 单次 Newton–Raphson 潮流求解（不做无功限值切换）。 */
export function newtonRaphson(inp: PfInput): PfOutput {
  const n = inp.vm0.length;
  const vm = [...inp.vm0];
  const va = [...inp.va0];
  const angBuses: number[] = [];
  const pqBuses: number[] = [];
  for (let i = 0; i < n; i++) {
    if (inp.types[i] !== 'slack') angBuses.push(i);
    if (inp.types[i] === 'pq') pqBuses.push(i);
  }
  for (let i = 0; i < n; i++) {
    if (inp.types[i] !== 'pq') vm[i] = inp.vSet[i];
  }
  const iterations: IterationRecord[] = [];
  let stopReason: StopReason = 'max_iter_exceeded';
  let finalMismatch = Infinity;
  for (let iter = 0; iter < inp.maxIter; iter++) {
    const { P, Q } = injections(inp.G, inp.B, vm, va);
    const mis: number[] = [];
    for (const i of angBuses) mis.push(inp.pSpec[i] - P[i]);
    for (const i of pqBuses) mis.push(inp.qSpec[i] - Q[i]);
    let maxMis = 0;
    for (const m of mis) maxMis = Math.max(maxMis, Math.abs(m));
    finalMismatch = maxMis;
    if (!Number.isFinite(maxMis)) {
      stopReason = 'non_finite_state';
      return { converged: false, stopReason, iterations, vm, va, finalMismatch };
    }
    if (maxMis < inp.tol) {
      stopReason = 'converged';
      iterations.push({ iter, maxMismatch: maxMis, stepNorm: 0 });
      return { converged: true, stopReason, iterations, vm, va, finalMismatch };
    }
    if (mis.length === 0) {
      // 无未知量（单平衡母线网络）：直接以注入校验为准
      stopReason = 'converged';
      return { converged: true, stopReason, iterations, vm, va, finalMismatch };
    }
    const J = buildJacobian(inp.G, inp.B, vm, va, P, Q, angBuses, pqBuses);
    const dx = solveLinear(J, mis);
    if (dx === null) {
      stopReason = 'jacobian_singular';
      iterations.push({ iter, maxMismatch: maxMis, stepNorm: NaN });
      return { converged: false, stopReason, iterations, vm, va, finalMismatch };
    }
    let stepNorm = 0;
    let k = 0;
    for (const i of angBuses) {
      va[i] += dx[k];
      stepNorm += dx[k] * dx[k];
      k++;
    }
    for (const i of pqBuses) {
      const dv = dx[k] * vm[i];
      vm[i] += dv;
      stepNorm += dv * dv;
      k++;
    }
    stepNorm = Math.sqrt(stepNorm);
    iterations.push({ iter, maxMismatch: maxMis, stepNorm });
    if (!vm.every(Number.isFinite) || !va.every(Number.isFinite)) {
      stopReason = 'non_finite_state';
      return { converged: false, stopReason, iterations, vm, va, finalMismatch };
    }
  }
  return { converged: false, stopReason, iterations, vm, va, finalMismatch };
}
