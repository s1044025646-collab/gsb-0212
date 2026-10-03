import { Netlist } from './types';

/** 结构校验：编号唯一、支路端点存在、非零阻抗、连通、恰一个平衡母线。 */
export function validateNetlist(net: Netlist): string[] {
  const errors: string[] = [];
  if (!(net.sbase > 0)) errors.push('基准容量 sbase 必须为正数');
  const busIds = new Set<number>();
  for (const b of net.buses) {
    if (busIds.has(b.id)) errors.push(`母线编号重复: ${b.id}`);
    busIds.add(b.id);
    if (b.type === 'pv' && b.qmin !== undefined && b.qmax !== undefined && b.qmin > b.qmax) {
      errors.push(`母线 ${b.id} 无功下限大于上限`);
    }
  }
  const slackCount = net.buses.filter((b) => b.type === 'slack').length;
  if (slackCount !== 1) errors.push(`必须恰有一个平衡母线，当前 ${slackCount} 个`);
  const brIds = new Set<number>();
  for (const br of net.branches) {
    if (brIds.has(br.id)) errors.push(`支路编号重复: ${br.id}`);
    brIds.add(br.id);
    if (!busIds.has(br.from)) errors.push(`支路 ${br.id} 起点 ${br.from} 不存在`);
    if (!busIds.has(br.to)) errors.push(`支路 ${br.id} 终点 ${br.to} 不存在`);
    if (br.from === br.to) errors.push(`支路 ${br.id} 为自环`);
    if (br.r === 0 && br.x === 0) errors.push(`支路 ${br.id} 阻抗为零，非法`);
  }
  // 连通性（无向 BFS）
  if (net.buses.length > 0 && errors.length === 0) {
    const adj = new Map<number, number[]>();
    for (const b of net.buses) adj.set(b.id, []);
    for (const br of net.branches) {
      adj.get(br.from)!.push(br.to);
      adj.get(br.to)!.push(br.from);
    }
    const seen = new Set<number>([net.buses[0].id]);
    const queue = [net.buses[0].id];
    while (queue.length) {
      const u = queue.pop()!;
      for (const v of adj.get(u)!) {
        if (!seen.has(v)) {
          seen.add(v);
          queue.push(v);
        }
      }
    }
    if (seen.size !== net.buses.length) {
      const missing = net.buses.map((b) => b.id).filter((id) => !seen.has(id));
      errors.push(`网络不连通（存在孤岛），未达母线: ${missing.join(', ')}`);
    }
  }
  return errors;
}

/** 母线编号重排：任意编号 -> 0..n-1，按编号升序，保证确定性。 */
export function indexBuses(net: Netlist): { ids: number[]; indexOf: (id: number) => number } {
  const ids = net.buses.map((b) => b.id).sort((a, b) => a - b);
  const pos = new Map(ids.map((id, i) => [id, i] as const));
  return { ids, indexOf: (id: number) => pos.get(id)! };
}
