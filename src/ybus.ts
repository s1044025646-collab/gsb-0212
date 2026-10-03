import { BranchSpec } from './types';

/**
 * 由支路参数构造节点导纳矩阵（标幺）。
 * 每条支路：串联 y = 1/(r+jx)，充电电纳 b 按 π 型等值在两端各并 j*b/2。
 * 无非额定变比与移相变压器（本系统范围外）。
 * 返回 n×n 的 G、B 数组（Y = G + jB）。
 */
export function buildYbus(
  n: number,
  branches: BranchSpec[],
  indexOf: (busId: number) => number,
): { G: number[][]; B: number[][] } {
  const G: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  const B: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (const br of branches) {
    const i = indexOf(br.from);
    const j = indexOf(br.to);
    const denom = br.r * br.r + br.x * br.x;
    if (denom === 0) {
      throw new Error(`支路 ${br.id} 阻抗为零（r=x=0），非法`);
    }
    const g = br.r / denom;
    const bSeries = -br.x / denom;
    const bc = br.b / 2;
    G[i][i] += g;
    B[i][i] += bSeries + bc;
    G[j][j] += g;
    B[j][j] += bSeries + bc;
    G[i][j] -= g;
    B[i][j] -= bSeries;
    G[j][i] -= g;
    B[j][i] -= bSeries;
  }
  return { G, B };
}
