import { NetlistInput, SolveOptions, SolveResult } from "./types";
import { solveCase } from "./pf/solve";

export interface ScanPoint {
  factor: number;
  converged: boolean;
  minVm: number;
  maxVm: number;
  totalPLoss: number;
  qViolations: number;
  result: SolveResult;
}

// 负荷扫描: 按比例缩放所有负荷 (P,Q 同比例), 逐个求解
export function loadScan(net: NetlistInput, factors: number[], opts: SolveOptions = {}): ScanPoint[] {
  return factors.map((f) => {
    const scaled: NetlistInput = {
      ...net,
      buses: net.buses.map((b) => ({ ...b, pd: (b.pd ?? 0) * f, qd: (b.qd ?? 0) * f })),
    };
    const result = solveCase(scaled, opts);
    const vms = result.buses.map((b) => b.vm);
    return {
      factor: f,
      converged: result.converged,
      minVm: Math.min(...vms),
      maxVm: Math.max(...vms),
      totalPLoss: result.totalPLoss,
      qViolations: result.qEvents.length,
      result,
    };
  });
}

export interface CompareRow {
  bus: number;
  vmA: number; vmB: number; dVm: number;
  vaA: number; vaB: number; dVa: number;
}

export function compareRuns(a: SolveResult, b: SolveResult): CompareRow[] {
  const mapB = new Map(b.buses.map((x) => [x.id, x]));
  return a.buses.map((ba) => {
    const bb = mapB.get(ba.id);
    return {
      bus: ba.id,
      vmA: ba.vm, vmB: bb?.vm ?? NaN, dVm: bb ? bb.vm - ba.vm : NaN,
      vaA: ba.vaDeg, vaB: bb?.vaDeg ?? NaN, dVa: bb ? bb.vaDeg - ba.vaDeg : NaN,
    };
  });
}

export function busesToCsv(r: SolveResult): string {
  const head = "bus,type,vm_pu,va_deg,p_gen_MW,q_gen_Mvar,p_load_MW,q_load_Mvar,p_inj_pu,q_inj_pu";
  const rows = r.buses.map((b) =>
    [b.id, b.type, b.vm, b.vaDeg, b.pGen, b.qGen, b.pLoad, b.qLoad, b.pInj, b.qInj].join(","));
  return [head, ...rows].join("\n");
}

export function branchesToCsv(r: SolveResult): string {
  const head = "branch,from,to,p_from_MW,q_from_Mvar,p_to_MW,q_to_Mvar,p_loss_MW,q_loss_Mvar";
  const rows = r.branches.map((b) =>
    [b.id, b.from, b.to, b.pFrom, b.qFrom, b.pTo, b.qTo, b.pLoss, b.qLoss].join(","));
  return [head, ...rows].join("\n");
}
