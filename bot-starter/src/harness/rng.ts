// Seeded randomness for the harness. Each stream is derived from the seed
// and a label, so drawing more from one stream never shifts another.

/** 32-bit string hash (cyrb53, folded) used to derive stream seeds. */
export function hashSeed(...parts: (string | number)[]): number {
  const s = parts.join("\u0000");
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h1 ^ h2) >>> 0;
}

/** mulberry32: returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform integer in [lo, hi], inclusive. */
export function intInRange(rand: () => number, lo: number, hi: number) {
  return lo + Math.floor(rand() * (hi - lo + 1));
}

/** In-place Fisher-Yates, as the server's `shuffle` (game.ts) does it. */
export function fisherYates<T>(rand: () => number, items: T[]): T[] {
  for (let i = items.length - 1; i >= 1; i--) {
    const j = intInRange(rand, 0, i);
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}
