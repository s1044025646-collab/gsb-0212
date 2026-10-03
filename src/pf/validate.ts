import { BusInput, BranchInput, NetlistInput } from "../types";

export class ValidationError extends Error {}

export function validateNetlist(net: NetlistInput): void {
  if (!net.name || typeof net.name !== "string") throw new ValidationError("缺少网络名称");
  if (!(net.sbase > 0)) throw new ValidationError("基准容量 sbase 必须为正数 (MVA)");
  if (!Array.isArray(net.buses) || net.buses.length === 0) throw new ValidationError("至少需要一个母线");
  const ids = new Set<number>();
  let slackCount = 0;
  for (const b of net.buses) {
    if (!Number.isInteger(b.id)) throw new ValidationError(`母线编号必须为整数: ${b.id}`);
    if (ids.has(b.id)) throw new ValidationError(`母线编号重复: ${b.id}`);
    ids.add(b.id);
    if (b.type !== "slack" && b.type !== "pv" && b.type !== "pq")
      throw new ValidationError(`母线 ${b.id} 类型非法: ${b.type}`);
    if (b.type === "slack") slackCount++;
    if (b.type === "pv") {
      const qmin = b.qmin ?? -Infinity, qmax = b.qmax ?? Infinity;
      if (qmin > qmax) throw new ValidationError(`PV 母线 ${b.id} 无功下限大于上限`);
    }
  }
  if (slackCount !== 1) throw new ValidationError(`网络必须恰有一个平衡母线, 实际 ${slackCount} 个`);
  const adj = new Map<number, number[]>();
  for (const id of ids) adj.set(id, []);
  for (const br of net.branches) {
    if (!ids.has(br.from) || !ids.has(br.to))
      throw new ValidationError(`支路 ${br.id} 连接了不存在的母线 (${br.from}-${br.to})`);
    if (br.from === br.to) throw new ValidationError(`支路 ${br.id} 为自环 (${br.from})`);
    if (br.status === false) continue;
    if (br.r === 0 && br.x === 0)
      throw new ValidationError(`支路 ${br.id} (${br.from}-${br.to}) 阻抗为零, 属于非法支路`);
    if (!Number.isFinite(br.r) || !Number.isFinite(br.x) || !Number.isFinite(br.b ?? 0))
      throw new ValidationError(`支路 ${br.id} 参数非有限数`);
    adj.get(br.from)!.push(br.to);
    adj.get(br.to)!.push(br.from);
  }
  // 连通性检查 (孤岛检测)
  const start = net.buses[0].id;
  const seen = new Set<number>([start]);
  const stack = [start];
  while (stack.length) {
    const u = stack.pop()!;
    for (const v of adj.get(u)!) if (!seen.has(v)) { seen.add(v); stack.push(v); }
  }
  if (seen.size !== ids.size) {
    const missing = [...ids].filter((i) => !seen.has(i));
    throw new ValidationError(`网络不连通, 存在孤岛母线: ${missing.join(", ")}`);
  }
}

export interface PreparedBus extends Required<Omit<BusInput, "qmin" | "qmax" | "vset">> {
  qmin: number; qmax: number; vset: number;
}

export function prepareBuses(net: NetlistInput): PreparedBus[] {
  return net.buses.map((b) => ({
    id: b.id,
    type: b.type,
    pg: (b.pg ?? 0) / net.sbase,
    pd: (b.pd ?? 0) / net.sbase,
    qd: (b.qd ?? 0) / net.sbase,
    gs: (b.gs ?? 0) / net.sbase,
    bs: (b.bs ?? 0) / net.sbase,
    vm: b.vm ?? 1.0,
    va: ((b.va ?? 0) * Math.PI) / 180,
    vset: b.vset ?? b.vm ?? 1.0,
    qmin: (b.qmin ?? -Infinity) / net.sbase,
    qmax: (b.qmax ?? Infinity) / net.sbase,
  }));
}

export function activeBranches(net: NetlistInput): BranchInput[] {
  return net.branches.filter((b) => b.status !== false);
}
