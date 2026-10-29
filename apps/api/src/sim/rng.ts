/** A seeded generator (mulberry32) so the simulated world is the same on every machine. */
export const rng = (seed: number) => {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T;
  const weighted = <T>(xs: ReadonlyArray<readonly [T, number]>): T => {
    const total = xs.reduce((s, [, w]) => s + w, 0);
    let r = next() * total;
    for (const [x, w] of xs) {
      r -= w;
      if (r <= 0) return x;
    }
    return (xs[xs.length - 1] as readonly [T, number])[0];
  };
  const normal = (mu: number, sd: number) => mu + sd * Math.sqrt(-2 * Math.log(next() || 1e-9)) * Math.cos(2 * Math.PI * next());
  return { next, int, pick, weighted, normal };
};
export type Rng = ReturnType<typeof rng>;
