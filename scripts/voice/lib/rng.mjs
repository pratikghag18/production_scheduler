// scripts/voice/lib/rng.mjs — a small seeded PRNG, dependency-free (S42-a,
// docs/agent-briefs/s42-a-training-set-brief.md §2: "deterministic ... no
// dependency"). mulberry32 is a public-domain 32-bit generator; it is used
// here (rather than Math.random) so `--seed 1` always writes the same file,
// byte for byte, on any machine.

/**
 * `mulberry32(seed)` -> a function that returns the next pseudo-random float
 * in `[0, 1)` on every call, deterministic in `seed`.
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One element of `arr`, chosen by `rng()` (a `mulberry32`-shaped generator). */
export function pick(rng, arr) {
  if (arr.length === 0) throw new Error("pick: empty array");
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

/** An integer in `[min, max]` inclusive. */
export function randInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

/** True with probability `p` (`0..1`). */
export function chance(rng, p) {
  return rng() < p;
}

/** A new array: `arr` shuffled by the Fisher-Yates method, using `rng`. */
export function shuffle(rng, arr) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}
