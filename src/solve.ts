import { EffType, injections, newtonRaphson } from './powerflow';
import { buildYbus } from './ybus';
import { indexBuses, validateNetlist } from './network';
import {
  BranchResult,
  BusResult,
  Netlist,
  PvSwitchRecord,
  SolveOptions,
  SolveResult,
} from './types';

/**
 * 完整潮流求解：结构校验 -> 导纳矩阵 -> NR -> PV 无功限值切换（确定性）-> 结果汇总。
 * 切换策略：每轮收敛后按母线编号升序找出全部越限 PV 母线，一次性转为 PQ 并固定在
 * 被越的限值上，转换不可逆（不回切），轮数不超过 PV 母线数，保证确定性与终止性。
 */
export function solve(net: Netlist, opts: SolveOptions = {}): SolveResult {
  const tol = opts.tol ?? 1e-8;
  const maxIter = opts.maxIter ?? 50;
  const qTol = opts.qTol ?? 1e-6;
  const enforceQ = opts.enforceQLimits ?? true;

  const errors = validateNetlist(net);
  if (errors.length) {
    throw new Error(`网表校验失败: ${errors.join('; ')}`);
  }

  const { ids, indexOf } = indexBuses(net);
  const n = ids.length;
  const byId = new Map(net.buses.map((b) => [b.id, b] as const));
  const { G, B } = buildYbus(n, net.branches, indexOf);

  const types: EffType[] = ids.map((id) => byId.get(id)!.type);
  const pSpec = ids.map((id) => {
    const b = byId.get(id)!;
    return b.pg - b.pl;
  });
  const qSpec = ids.map((id) => {
    const b = byId.get(id)!;
    return b.qg - b.ql;
  });
  const vSet = ids.map((id) => byId.get(id)!.vm);
  const vm0 = ids.map((id) => byId.get(id)!.vm);
  const va0 = ids.map((id) => byId.get(id)!.va);

  const pvSwitches: PvSwitchRecord[] = [];
  const allIterations: SolveResult['iterations'] = [];
  let switchRounds = 0;
  let finalOut: ReturnType<typeof newtonRaphson> | null = null;
  const switched = new Set<number>();

  const maxRounds = types.filter((t) => t === 'pv').length + 1;
  for (let round = 0; round < maxRounds; round++) {
    const out = newtonRaphson({ G, B, types, pSpec, qSpec, vSet, vm0, va0, tol, maxIter });
    for (const rec of out.iterations) {
      allIterations.push({ ...rec, iter: allIterations.length });
    }
    finalOut = out;
    if (!out.converged || !enforceQ) break;
    // 收敛后检查 PV 无功限值
    const { Q } = injections(G, B, out.vm, out.va);
    const violators: { idx: number; q: number; limit: 'qmin' | 'qmax'; fixed: number }[] = [];
    for (let i = 0; i < n; i++) {
      if (types[i] !== 'pv' || switched.has(i)) continue;
      const spec = byId.get(ids[i])!;
      const qGen = Q[i] + spec.ql; // 注入 Q = Qg - Ql
      if (spec.qmax !== undefined && qGen > spec.qmax + qTol) {
        violators.push({ idx: i, q: qGen, limit: 'qmax', fixed: spec.qmax });
      } else if (spec.qmin !== undefined && qGen < spec.qmin - qTol) {
        violators.push({ idx: i, q: qGen, limit: 'qmin', fixed: spec.qmin });
      }
    }
    if (!violators.length) break;
    switchRounds++;
    for (const v of violators) {
      const id = ids[v.idx];
      const spec = byId.get(id)!;
      pvSwitches.push({
        busId: id,
        qFixed: v.fixed,
        limit: v.limit,
        originalVSet: spec.vm,
        qComputed: v.q,
      });
      switched.add(v.idx);
      types[v.idx] = 'pq';
      qSpec[v.idx] = v.fixed - spec.ql;
    }
  }

  const out = finalOut!;
  const { P, Q } = injections(G, B, out.vm, out.va);
  const buses: BusResult[] = ids.map((id, i) => {
    const spec = byId.get(id)!;
    const sw = pvSwitches.find((s) => s.busId === id);
    const qg = Q[i] + spec.ql;
    return {
      id,
      type: spec.type,
      effectiveType: types[i],
      vm: out.vm[i],
      va: out.va[i],
      pInj: P[i],
      qInj: Q[i],
      pg: spec.pg,
      qg,
      pl: spec.pl,
      ql: spec.ql,
    };
  });

  const branches: BranchResult[] = net.branches.map((br) => {
    const i = indexOf(br.from);
    const j = indexOf(br.to);
    const denom = br.r * br.r + br.x * br.x;
    const g = br.r / denom;
    const bSer = -br.x / denom;
    const bc = br.b / 2;
    const flow = (a: number, c: number): { p: number; q: number } => {
      const vaR = out.vm[a] * Math.cos(out.va[a]);
      const vaI = out.vm[a] * Math.sin(out.va[a]);
      const vcR = out.vm[c] * Math.cos(out.va[c]);
      const vcI = out.vm[c] * Math.sin(out.va[c]);
      // I = (Va - Vc)*(g + j*bSer) + Va*(j*bc)
      const dR = vaR - vcR;
      const dI = vaI - vcI;
      const iR = dR * g - dI * bSer - vaI * bc;
      const iI = dR * bSer + dI * g + vaR * bc;
      // S = V * conj(I)
      return { p: vaR * iR + vaI * iI, q: vaI * iR - vaR * iI };
    };
    const sFrom = flow(i, j);
    const sTo = flow(j, i);
    return {
      id: br.id,
      from: br.from,
      to: br.to,
      pFrom: sFrom.p,
      qFrom: sFrom.q,
      pTo: sTo.p,
      qTo: sTo.q,
      pLoss: sFrom.p + sTo.p,
      qLoss: sFrom.q + sTo.q,
    };
  });

  let residualP = 0;
  let residualQ = 0;
  for (let i = 0; i < n; i++) {
    residualP += P[i];
    residualQ += Q[i];
  }

  return {
    converged: out.converged,
    stopReason: out.stopReason,
    iterations: allIterations,
    finalMismatch: out.finalMismatch,
    buses,
    branches,
    residualP,
    residualQ,
    pvSwitches,
    switchRounds,
  };
}
