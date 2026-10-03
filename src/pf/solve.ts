import { Cx, add, conj, cx, div, fromPolar, mul, sub } from "./complex";
import { buildYbus, calcInjections } from "./ybus";
import { newtonRaphson, NrState } from "./newton";
import { activeBranches, prepareBuses, PreparedBus, validateNetlist } from "./validate";
import { BranchResult, BusResult, NetlistInput, QLimitEvent, SolveOptions, SolveResult } from "../types";

export function solveCase(net: NetlistInput, opts: SolveOptions = {}): SolveResult {
  validateNetlist(net);
  const tolerance = opts.tolerance ?? 1e-8;
  const maxIter = opts.maxIter ?? 50;
  const enforceQ = opts.enforceQLimits ?? true;
  const sbase = net.sbase;
  const buses = prepareBuses(net);
  const n = buses.length;
  const idToIdx = new Map<number, number>();
  buses.forEach((b, i) => idToIdx.set(b.id, i));
  const Y = buildYbus(net, buses);

  // 初值: 平衡/PV 用设定值, 其余 1∠0 (或用户给定)
  const init: NrState = {
    vm: buses.map((b) => (b.type === "pq" ? (opts.flatStart ? 1 : b.vm) : b.vset)),
    va: buses.map((b) => (b.type === "pq" ? (opts.flatStart ? 0 : b.va) : b.va)),
  };
  buses.forEach((b, i) => {
    if (b.type !== "pq" && !opts.flatStart) init.va[i] = b.va;
    if (b.type === "slack") { init.vm[i] = b.vset; init.va[i] = b.va; }
    if (b.type === "pv") init.vm[i] = b.vset;
  });

  // 注入约定: 发电为正注入, 负荷为负注入 (标幺)
  const pSpec = buses.map((b) => b.pg - b.pd);
  const qSpec = buses.map((b) => -b.qd);

  const allIterations: { iter: number; maxMismatch: number; stepNorm: number }[] = [];
  const qEvents: QLimitEvent[] = [];
  const switched = new Set<number>();
  let effTypes = buses.map((b) => b.type);
  let finalState: NrState = init;
  let converged = false;
  let stopReason = "";
  let finalMaxMismatch = Infinity;

  for (let round = 0; round <= n; round++) {
    const effBuses = buses.map((b, i) => ({ ...b, type: effTypes[i] }));
    const out = newtonRaphson(Y, effBuses, pSpec, qSpec, finalState, tolerance, maxIter);
    finalState = out.state;
    finalMaxMismatch = out.finalMaxMismatch;
    out.iterations.forEach((r) => allIterations.push({ ...r, iter: allIterations.length }));
    if (!out.ok) {
      stopReason = out.stopReason;
      converged = false;
      break;
    }
    if (!enforceQ) {
      converged = true;
      stopReason = out.stopReason;
      break;
    }
    // 检查 PV 无功限值 (确定性: 取越限最大者, 一次切换一个)
    const V = finalState.vm.map((m, i) => fromPolar(m, finalState.va[i]));
    const S = calcInjections(Y, V);
    let worst = -1, worstViol = 0, worstLimit = 0, worstQ = 0;
    buses.forEach((b, i) => {
      if (effTypes[i] !== "pv" || switched.has(i)) return;
      const q = S[i].im + b.qd; // 发电无功 = 注入 + 负荷
      let viol = 0, lim = 0;
      if (q > b.qmax) { viol = q - b.qmax; lim = b.qmax; }
      else if (q < b.qmin) { viol = b.qmin - q; lim = b.qmin; }
      if (viol > worstViol + 1e-12) { worstViol = viol; worst = i; worstLimit = lim; worstQ = q; }
    });
    if (worst < 0) {
      converged = true;
      stopReason = out.stopReason + "; 所有 PV 无功在限值内";
      break;
    }
    // 切换: PV -> PQ, 固定无功于限值, 释放电压设定
    switched.add(worst);
    effTypes = effTypes.map((t, i) => (i === worst ? "pq" : t));
    qSpec[worst] = worstLimit - buses[worst].qd;
    qEvents.push({
      bus: buses[worst].id,
      qCalc: worstQ,
      limit: worstLimit,
      vsetReleased: buses[worst].vset,
    });
  }
  if (!converged && stopReason === "") stopReason = "无功限值切换次数耗尽仍未稳定";

  // 汇总结果
  const V = finalState.vm.map((m, i) => fromPolar(m, finalState.va[i]));
  const S = calcInjections(Y, V);
  const busResults: BusResult[] = buses.map((b, i) => {
    const pInj = S[i].re, qInj = S[i].im;
    const pGen = pInj + b.pd, qGen = qInj + b.qd;
    return {
      id: b.id,
      type: effTypes[i],
      vm: finalState.vm[i],
      vaDeg: (finalState.va[i] * 180) / Math.PI,
      pInj, qInj,
      pGen: pGen * sbase, qGen: qGen * sbase,
      pLoad: b.pd * sbase, qLoad: b.qd * sbase,
    };
  });

  const branchResults: BranchResult[] = [];
  let totPLoss = 0, totQLoss = 0, totQCh = 0;
  for (const br of activeBranches(net)) {
    const i = idToIdx.get(br.from)!, j = idToIdx.get(br.to)!;
    const y = div(cx(1, 0), cx(br.r, br.x));
    const bc = (br.b ?? 0) / 2;
    const ifrom = add(mul(y, sub(V[i], V[j])), mul(cx(0, bc), V[i]));
    const ito = add(mul(y, sub(V[j], V[i])), mul(cx(0, bc), V[j]));
    const sFrom = mul(V[i], conj(ifrom));
    const sTo = mul(V[j], conj(ito));
    const loss = add(sFrom, sTo);
    totPLoss += loss.re; totQLoss += loss.im;
    totQCh += bc * (V[i].re ** 2 + V[i].im ** 2) + bc * (V[j].re ** 2 + V[j].im ** 2);
    branchResults.push({
      id: br.id, from: br.from, to: br.to,
      pFrom: sFrom.re * sbase, qFrom: sFrom.im * sbase,
      pTo: sTo.re * sbase, qTo: sTo.im * sbase,
      pLoss: loss.re * sbase, qLoss: loss.im * sbase,
    });
  }

  const slackIdx = buses.findIndex((b) => b.type === "slack");
  const slackP = (S[slackIdx].re + buses[slackIdx].pd) * sbase;
  const slackQ = (S[slackIdx].im + buses[slackIdx].qd) * sbase;
  const totPGen = busResults.reduce((s, b) => s + b.pGen, 0);
  const totQGen = busResults.reduce((s, b) => s + b.qGen, 0);
  const totPLoad = busResults.reduce((s, b) => s + b.pLoad, 0);
  const totQLoad = busResults.reduce((s, b) => s + b.qLoad, 0);

  return {
    converged,
    stopReason,
    iterations: allIterations,
    qEvents,
    buses: busResults,
    branches: branchResults,
    totalPLoss: totPLoss * sbase,
    totalQLoss: totQLoss * sbase,
    totalQCharging: totQCh * sbase,
    slackP, slackQ,
    balanceResidualP: totPGen - totPLoad - totPLoss * sbase,
    balanceResidualQ: totQGen - totQLoad - totQLoss * sbase,
    finalMaxMismatch,
  };
}
