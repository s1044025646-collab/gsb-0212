import { solve } from './solve';
import { Netlist, SolveOptions, SolveResult } from './types';

export interface ScanPoint {
  factor: number;
  converged: boolean;
  stopReason: string;
  minVm: number;
  maxVm: number;
  pvSwitches: number;
  residualP: number;
  residualQ: number;
  result?: SolveResult;
}

/** 负荷扫描：按比例同时放大所有母线负荷 P、Q，逐点求解。 */
export function loadScan(
  net: Netlist,
  factors: number[],
  opts: SolveOptions = {},
  includeResults = false,
): ScanPoint[] {
  return factors.map((factor) => {
    const scaled: Netlist = {
      sbase: net.sbase,
      branches: net.branches.map((b) => ({ ...b })),
      buses: net.buses.map((b) => ({ ...b, pl: b.pl * factor, ql: b.ql * factor })),
    };
    const result = solve(scaled, opts);
    const vms = result.buses.map((b) => b.vm);
    return {
      factor,
      converged: result.converged,
      stopReason: result.stopReason,
      minVm: Math.min(...vms),
      maxVm: Math.max(...vms),
      pvSwitches: result.pvSwitches.length,
      residualP: result.residualP,
      residualQ: result.residualQ,
      result: includeResults ? result : undefined,
    };
  });
}

export interface CaseDiff {
  buses: {
    id: number;
    dVm: number;
    dVa: number;
    dPInj: number;
    dQInj: number;
    typeA: string;
    typeB: string;
  }[];
  branches: { id: number; dPFrom: number; dQFrom: number; dPLoss: number }[];
  convergedA: boolean;
  convergedB: boolean;
}

/** 工况比较：同网不同结果（B - A）。 */
export function compareResults(a: SolveResult, b: SolveResult): CaseDiff {
  const busB = new Map(b.buses.map((x) => [x.id, x] as const));
  const brB = new Map(b.branches.map((x) => [x.id, x] as const));
  return {
    convergedA: a.converged,
    convergedB: b.converged,
    buses: a.buses.map((x) => {
      const y = busB.get(x.id)!;
      return {
        id: x.id,
        dVm: y.vm - x.vm,
        dVa: y.va - x.va,
        dPInj: y.pInj - x.pInj,
        dQInj: y.qInj - x.qInj,
        typeA: x.effectiveType,
        typeB: y.effectiveType,
      };
    }),
    branches: a.branches.map((x) => {
      const y = brB.get(x.id)!;
      return {
        id: x.id,
        dPFrom: y.pFrom - x.pFrom,
        dQFrom: y.qFrom - x.qFrom,
        dPLoss: y.pLoss - x.pLoss,
      };
    }),
  };
}
