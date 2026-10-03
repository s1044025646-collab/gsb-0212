/** 母线类型：平衡（slack）、PQ、PV */
export type BusType = 'slack' | 'pq' | 'pv';

export interface BusSpec {
  /** 母线唯一编号（任意整数，内部会重排为 0..n-1） */
  id: number;
  type: BusType;
  /** 电压幅值初值 / PV 电压设定值（标幺） */
  vm: number;
  /** 相角初值（弧度），平衡母线为参考角 */
  va: number;
  /** 负荷有功（标幺，正值表示消耗） */
  pl: number;
  /** 负荷无功（标幺，正值表示消耗感性无功） */
  ql: number;
  /** 发电有功（标幺，正值表示注入） */
  pg: number;
  /** 发电无功（标幺；仅 PQ 母线使用，PV 母线由求解决定） */
  qg: number;
  /** PV 发电机无功下限（标幺），可选 */
  qmin?: number;
  /** PV 发电机无功上限（标幺），可选 */
  qmax?: number;
}

export interface BranchSpec {
  /** 支路唯一编号 */
  id: number;
  from: number;
  to: number;
  /** 串联电阻（标幺） */
  r: number;
  /** 串联电抗（标幺） */
  x: number;
  /** 线路充电总电纳（标幺，π 型等值两端各半） */
  b: number;
}

export interface Netlist {
  /** 基准容量 MVA，全网统一 */
  sbase: number;
  buses: BusSpec[];
  branches: BranchSpec[];
}

export interface SolveOptions {
  /** 功率不平衡容差（标幺），默认 1e-8 */
  tol?: number;
  /** 最大迭代次数，默认 50 */
  maxIter?: number;
  /** 无功限值判定裕度（标幺），默认 1e-6 */
  qTol?: number;
  /** 是否启用 PV->PQ 无功限值切换，默认 true */
  enforceQLimits?: boolean;
}

export interface IterationRecord {
  iter: number;
  /** 最大功率不平衡（标幺） */
  maxMismatch: number;
  /** 修正步长二范数 */
  stepNorm: number;
}

export type StopReason =
  | 'converged'
  | 'max_iter_exceeded'
  | 'jacobian_singular'
  | 'non_finite_state';

export interface PvSwitchRecord {
  busId: number;
  /** 越限后被固定的无功（即被钳到的限值） */
  qFixed: number;
  limit: 'qmin' | 'qmax';
  /** 原电压设定值（切换后不再受控） */
  originalVSet: number;
  /** 越限时刻计算出的无功 */
  qComputed: number;
}

export interface BusResult {
  id: number;
  type: BusType;
  /** 实际求解时生效的类型（PV 越限后为 pq） */
  effectiveType: BusType;
  vm: number;
  va: number;
  /** 净注入 P = Pg - Pl（标幺） */
  pInj: number;
  /** 净注入 Q = Qg - Ql（标幺，含 PV 求解出的 Qg） */
  qInj: number;
  pg: number;
  qg: number;
  pl: number;
  ql: number;
}

export interface BranchResult {
  id: number;
  from: number;
  to: number;
  /** from 端注入支路的复功率（标幺） */
  pFrom: number;
  qFrom: number;
  /** to 端注入支路的复功率（标幺） */
  pTo: number;
  qTo: number;
  /** 支路损耗 = 两端之和（含充电无功净额） */
  pLoss: number;
  qLoss: number;
}

export interface SolveResult {
  converged: boolean;
  stopReason: StopReason;
  iterations: IterationRecord[];
  /** 最终最大功率不平衡（标幺），未收敛时为最后迭代值 */
  finalMismatch: number;
  buses: BusResult[];
  branches: BranchResult[];
  /** 全网平衡残差：所有母线注入之和（应≈0，含损耗与充电） */
  residualP: number;
  residualQ: number;
  pvSwitches: PvSwitchRecord[];
  /** 无功限值切换的轮次记录 */
  switchRounds: number;
}
