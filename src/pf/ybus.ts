import { Cx, add, sub, div, cx } from "./complex";
import { BranchInput, NetlistInput } from "../types";
import { PreparedBus } from "./validate";

// 构建节点导纳矩阵 (标幺, n x n, 行主序一维数组)
export function buildYbus(net: NetlistInput, buses: PreparedBus[]): Cx[] {
  const idToIdx = new Map<number, number>();
  buses.forEach((b, i) => idToIdx.set(b.id, i));
  const n = buses.length;
  const Y: Cx[] = Array.from({ length: n * n }, () => cx(0, 0));
  const at = (i: number, j: number) => i * n + j;
  for (const br of net.branches) {
    if (br.status === false) continue;
    const i = idToIdx.get(br.from)!, j = idToIdx.get(br.to)!;
    const y = div(cx(1, 0), cx(br.r, br.x));
    const bc = cx(0, (br.b ?? 0) / 2);
    Y[at(i, i)] = add(add(Y[at(i, i)], y), bc);
    Y[at(j, j)] = add(add(Y[at(j, j)], y), bc);
    Y[at(i, j)] = sub(Y[at(i, j)], y);
    Y[at(j, i)] = sub(Y[at(j, i)], y);
  }
  // 母线并联导纳 (负荷等值 gs + j*bs)
  buses.forEach((b, i) => {
    Y[at(i, i)] = add(Y[at(i, i)], cx(b.gs, b.bs));
  });
  return Y;
}

// 计算各母线复注入 S = V .* conj(Y * V)
export function calcInjections(Y: Cx[], V: Cx[]): Cx[] {
  const n = V.length;
  const S: Cx[] = [];
  for (let i = 0; i < n; i++) {
    let iv = cx(0, 0);
    for (let j = 0; j < n; j++) {
      const y = Y[i * n + j];
      if (y.re !== 0 || y.im !== 0)
        iv = add(iv, cx(y.re * V[j].re - y.im * V[j].im, y.re * V[j].im + y.im * V[j].re));
    }
    // S = V * conj(I)
    S.push(cx(V[i].re * iv.re + V[i].im * iv.im, V[i].im * iv.re - V[i].re * iv.im));
  }
  return S;
}
