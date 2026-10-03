/** 极简复数类型与运算（数组 [re, im] 的替代：对象形式便于阅读） */
export interface Cx {
  re: number;
  im: number;
}

export const cx = (re: number, im = 0): Cx => ({ re, im });
export const add = (a: Cx, b: Cx): Cx => ({ re: a.re + b.re, im: a.im + b.im });
export const sub = (a: Cx, b: Cx): Cx => ({ re: a.re - b.re, im: a.im - b.im });
export const mul = (a: Cx, b: Cx): Cx => ({
  re: a.re * b.re - a.im * b.im,
  im: a.re * b.im + a.im * b.re,
});
export const div = (a: Cx, b: Cx): Cx => {
  const d = b.re * b.re + b.im * b.im;
  return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d };
};
export const conj = (a: Cx): Cx => ({ re: a.re, im: -a.im });
export const abs = (a: Cx): Cx => ({ re: Math.hypot(a.re, a.im), im: 0 });
export const fromPolar = (m: number, ang: number): Cx => ({
  re: m * Math.cos(ang),
  im: m * Math.sin(ang),
});
