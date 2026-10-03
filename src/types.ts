export type BusType = "slack" | "pv" | "pq";

export interface BusInput {
  id: number;
  type: BusType;
  pg?: number; // MW, 发电有功 (PV/slack 之外 PQ 也可指定)
  pd?: number; // MW
  qd?: number; // Mvar
  gs?: number; // MW at V=1.0
  bs?: number; // Mvar at V=1.0
  vm?: number; // initial / setpoint magnitude (pu)
  va?: number; // initial angle (deg)
  vset?: number; // PV/slack voltage setpoint (pu), defaults to vm
  qmin?: number; // Mvar, PV only
  qmax?: number; // Mvar, PV only
}

export interface BranchInput {
  id: number;
  from: number;
  to: number;
  r: number; // pu on system base
  x: number; // pu
  b?: number; // total line charging susceptance, pu
  status?: boolean;
}

export interface NetlistInput {
  name: string;
  sbase: number; // MVA
  buses: BusInput[];
  branches: BranchInput[];
}

export interface SolveOptions {
  tolerance?: number; // pu mismatch, default 1e-8
  maxIter?: number; // default 50
  flatStart?: boolean; // ignore provided vm/va for non-specified buses
  enforceQLimits?: boolean; // default true
}

export interface IterationRecord {
  iter: number;
  maxMismatch: number;
  stepNorm: number;
}

export interface QLimitEvent {
  bus: number;
  qCalc: number; // pu
  limit: number; // pu, the violated limit
  vsetReleased: number; // original voltage setpoint no longer enforced
}

export interface BusResult {
  id: number;
  type: BusType; // effective type after switching
  vm: number;
  vaDeg: number;
  pInj: number; // pu
  qInj: number; // pu
  pGen: number; // MW
  qGen: number; // Mvar
  pLoad: number;
  qLoad: number;
}

export interface BranchResult {
  id: number;
  from: number;
  to: number;
  pFrom: number; // MW
  qFrom: number; // Mvar
  pTo: number;
  qTo: number;
  pLoss: number;
  qLoss: number;
}

export interface SolveResult {
  converged: boolean;
  stopReason: string;
  iterations: IterationRecord[];
  qEvents: QLimitEvent[];
  buses: BusResult[];
  branches: BranchResult[];
  totalPLoss: number; // MW
  totalQLoss: number; // Mvar (includes line charging absorption sign convention)
  totalQCharging: number; // Mvar injected by line charging
  slackP: number; // MW
  slackQ: number; // Mvar
  balanceResidualP: number; // MW, gen - load - losses
  balanceResidualQ: number;
  finalMaxMismatch: number; // pu
}
