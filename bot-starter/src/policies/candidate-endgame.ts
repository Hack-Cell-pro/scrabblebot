// Competitive strategy for the ScrabbleBot auction game.
//
// Game facts (from the host's module source):
//  - 98 tiles, no blanks. Everyone starts with 100 balance and 5 tiles. Up to 6 bots.
//  - Each round one letter is auctioned for 1 s. Vickrey by default (pay 2nd price).
//  - Word reward = sum(letter values) x length multiplier
//    (<=3: 1x, 4: 1.5x, 5: 2x, 6: 2.5x, 7+: 3x). Reward goes to score AND balance.
//  - The match ends the moment the bag is empty; unplayed letters and leftover
//    balance are worth nothing. Only score counts.
//
// Strategy:
//  - Value a rack by its best word now OR a bigger word it is 1-2 letters away from,
//    discounted by the chance of getting those letters before the bag runs out.
//  - Bid the marginal value a letter adds to the rack (truthful under Vickrey,
//    shaded under first-price). Money is worth more early and nothing at the end.
//  - Hold letters to build long (3x) words; cash in when waiting no longer pays,
//    and dump everything as the bag runs out.

export const LETTER_VALUE: Record<string, number> = {
  A: 1, B: 3, C: 3, D: 2, E: 1, F: 4, G: 2, H: 4, I: 1, J: 8,
  K: 5, L: 1, M: 3, N: 1, O: 1, P: 3, Q: 10, R: 1, S: 1, T: 1,
  U: 1, V: 4, W: 4, X: 8, Y: 4, Z: 10,
};

export interface BidContext {
  letter: string;
  myBalance: number;
  myRack: Map<string, number>;
  dictionary?: string[];
  bagTotal?: number;         // letters still in the bag
  auctionType?: string;      // "Vickrey" | "FirstPrice"
  players?: number;
  myScore?: number;
  /** Public info about rivals: balance, score, and letters we know they hold. */
  rivals?: { balance: number; score: number; known: Map<string, number> }[];
  params?: Partial<Params>;
}

export interface Params {
  K: number;        // weight on our own marginal value
  PACE: number;     // budget pacing multiplier
  DENY: number;     // weight on denying letters rivals need
  CASH: number;     // play-now threshold (fraction of waiting value)
  END: number;      // cash out everything when bag <= END (or players)
  FV: number;       // floor bid per face point for high-value letters (they score more per coin)
  LC: number;       // cap on bids for 1-2 point letters (0 = no cap)
}
export const DEFAULT_PARAMS: Params = {
  K: Number(process.env.BID_K ?? 2),
  PACE: Number(process.env.BID_PACE ?? 3),
  DENY: Number(process.env.BID_DENY ?? 0),
  CASH: Number(process.env.CASH ?? 2),
  END: Number(process.env.END ?? 3),
  FV: Number(process.env.FV ?? 3),
  LC: Number(process.env.LC ?? 12),
};

export interface WordContext {
  myRack: Map<string, number>;
  dictionary: string[];
  bagTotal?: number;
  players?: number;
  params?: Partial<Params>;
}

// ---------- scoring ----------
export function lengthMultiplier(len: number): number {
  if (len <= 3) return 1;
  if (len === 4) return 1.5;
  if (len === 5) return 2;
  if (len === 6) return 2.5;
  return 3;
}
export function wordReward(word: string): number {
  let base = 0;
  for (const c of word) base += LETTER_VALUE[c] ?? 0;
  // Server uses integer division.
  const [n, d] = word.length <= 3 ? [1, 1] : word.length === 4 ? [3, 2] : word.length === 5 ? [2, 1] : word.length === 6 ? [5, 2] : [3, 1];
  return Math.floor((base * n) / d);
}

// ---------- precomputed dictionary index ----------
interface Idx { words: string[]; counts: Uint8Array; reward: Float64Array; len: Uint8Array; }
let cache: { src: string[]; idx: Idx } | null = null;
function index(dict: string[]): Idx {
  if (cache && cache.src === dict) return cache.idx;
  const words = dict.filter((w) => /^[A-Z]{2,}$/.test(w) && w.length <= 15);
  const counts = new Uint8Array(words.length * 26);
  const reward = new Float64Array(words.length);
  const len = new Uint8Array(words.length);
  words.forEach((w, i) => {
    for (const c of w) counts[i * 26 + c.charCodeAt(0) - 65]++;
    reward[i] = wordReward(w);
    len[i] = w.length;
  });
  const idx = { words, counts, reward, len };
  cache = { src: dict, idx };
  return idx;
}
const toArr = (rack: Map<string, number>) => {
  const a = new Uint8Array(26);
  for (const [c, n] of rack) a[c.charCodeAt(0) - 65] += n;
  return a;
};

/** Chance of acquiring one specific missing letter before the match ends. */
function acquireP(bagTotal: number, players: number): number {
  if (bagTotal <= 0) return 0;
  // More letters left = more chances; more players = more competition.
  return Math.min(0.6, (bagTotal / 98) * 1.6) * (players <= 2 ? 1 : 4 / (players + 2));
}

/**
 * One pass over the dictionary.
 * Returns the best word playable now, and the rack's "potential":
 *   max over words of reward * p^missing (missing <= 2).
 */
function scan(ix: Idx, rack: Uint8Array, p: number, extra = -1) {
  let total = 0;
  for (let k = 0; k < 26; k++) total += rack[k];
  if (extra >= 0) total++;
  let bestNow = -1, bestNowR = 0, potential = 0;
  const p1 = p, p2 = p * p * 0.7; // two missing letters is much harder
  const n = ix.words.length;
  for (let i = 0; i < n; i++) {
    const L = ix.len[i];
    if (L > total + 2) continue;
    const r = ix.reward[i];
    if (r <= bestNowR && r * p1 <= potential) continue;
    let miss = 0;
    const o = i * 26;
    for (let k = 0; k < 26; k++) {
      const need = ix.counts[o + k];
      if (!need) continue;
      const have = rack[k] + (k === extra ? 1 : 0);
      if (need > have) { miss += need - have; if (miss > 2) break; }
    }
    if (miss > 2) continue;
    if (miss === 0) {
      if (r > bestNowR) { bestNowR = r; bestNow = i; }
      if (r > potential) potential = r;
    } else {
      const v = r * (miss === 1 ? p1 : p2);
      if (v > potential) potential = v;
    }
  }
  return { bestNow, bestNowR, potential };
}

// ---------- bidding ----------
export function decideBid(ctx: BidContext): number {
  const balance = Math.max(0, Math.floor(ctx.myBalance));
  if (balance <= 0) return 0;
  const letter = ctx.letter.toUpperCase();
  const bag = ctx.bagTotal ?? 50;
  const players = ctx.players ?? 6;

  const P = { ...DEFAULT_PARAMS, ...ctx.params };
  let marginal: number;
  let deny = 0;
  if (ctx.dictionary?.length) {
    const ix = index(ctx.dictionary);
    const rack = toArr(ctx.myRack);
    const p = acquireP(bag, players);
    const before = scan(ix, rack, p).potential;
    const after = scan(ix, rack, p, letter.charCodeAt(0) - 65).potential;
    marginal = Math.max(0, after - before);
    // Denial: a letter that would jump a contending rival's best word is worth
    // buying even if it only helps us a little (finishing place is what counts).
    const me = ctx.myScore ?? 0;
    const k = letter.charCodeAt(0) - 65;
    for (const r of ctx.rivals ?? []) {
      if (r.balance <= 0) continue;
      const rr = toArr(r.known);
      const gain = Math.max(0, scan(ix, rr, p, k).potential - scan(ix, rr, p).potential);
      const w = r.score >= me - 30 ? 1 : 0.4;
      deny = Math.max(deny, gain * w);
    }
    // Small option value: any extra tile widens future options while time remains.
    marginal += bag > 10 ? 1 : 0;
  } else {
    marginal = (LETTER_VALUE[letter] ?? 1) + 2;
  }

  // Leftover balance is worth nothing at the end, so spend it all over the match.
  // Pace: spread the balance across the auctions left, weighted toward useful letters.
  const K = P.K, PACE = P.PACE;
  const auctionsLeft = Math.max(1, bag + 1);
  const pace = (balance / auctionsLeft) * PACE;
  const value = marginal + deny * P.DENY;
  let bid = value > 0 ? value * K + pace : pace * 0.3;
  const face = LETTER_VALUE[letter] ?? 1;
  let tiles = 0;
  for (const n of ctx.myRack.values()) tiles += n;
  if (P.FV > 0 && face >= 3 && bag > 8 && tiles < 12) {
    // Q is hard to use; treat it like a 5-point letter, and only with a U in hand.
    const f = letter === "Q" ? ((ctx.myRack.get("U") ?? 0) > 0 ? 5 : 0) : face;
    bid = Math.max(bid, P.FV * f);
  }
  if (P.LC > 0 && face <= 2 && bag > 2) bid = Math.min(bid, P.LC);
  if (bag <= 2) bid = balance; // last letters: money is worthless after this
  bid = Math.min(bid, balance);

  if (ctx.auctionType === "FirstPrice") {
    // Shade: winner pays own bid. Rivals typically bid face value + 0..6.
    bid = Math.min(bid, Math.max(bid * 0.65, face + 5));
  }
  return Math.max(0, Math.min(balance, Math.floor(bid)));
}

// ---------- word play ----------
function minus(rack: Uint8Array, word: string) {
  const r = rack.slice();
  for (const c of word) r[c.charCodeAt(0) - 65]--;
  return r;
}

/**
 * Pick a word to play now, or null to keep building.
 * Called on every rack change; plays at most one word per call (the starter
 * calls again after the rack updates, so multiple words chain naturally).
 */
export function chooseWord(ctx: WordContext): string | null {
  // Without bag info, behave like the starter: best-scoring word, plain scan.
  if (ctx.bagTotal === undefined) {
    let best: string | null = null, br = 0, tiles = 0;
    for (const n of ctx.myRack.values()) tiles += n;
    for (const w of ctx.dictionary) {
      if (w.length > tiles || !canSpell(w, ctx.myRack)) continue;
      const r = wordReward(w);
      if (r > br) { br = r; best = w; }
    }
    return best;
  }
  const ix = index(ctx.dictionary);
  const rack = toArr(ctx.myRack);
  const bag = ctx.bagTotal!;
  const players = ctx.players ?? 6;
  const P = { ...DEFAULT_PARAMS, ...ctx.params };

  const p = acquireP(bag, players);
  const now = scan(ix, rack, p);
  if (now.bestNow < 0) return null;
  const word = ix.words[now.bestNow];

  // Endgame: the match ends the instant the bag empties — cash out.
  // Plan the whole remaining rack: the best set of words for the word
  // attempts left (this auction plus one per letter still in the bag),
  // and play that plan's highest-reward word now.
  if (bag <= Math.max(P.END, players)) {
    const plan = planEndgameIdx(ix, rack, bag + 1, ENDGAME_CHECK_LIMIT);
    return plan.words[0] ?? word;
  }

  // 7+ letters already earns the max multiplier.
  if (word.length >= 7) return word;

  // Play if (this word + what's left) is worth about as much as waiting.
  const rest = scan(ix, minus(rack, word), p).potential;
  if (now.bestNowR + rest >= now.potential * P.CASH) return word;
  return null;
}

// ---------- endgame planning ----------

/**
 * Work budget for one endgame search, counted in candidate-word checks
 * (deterministic, never wall time). Small racks finish well inside it and
 * the result is exact. If the budget runs out, the best plan found so far
 * is used; it is never worse than the greedy plan, which seeds the search.
 */
export const ENDGAME_CHECK_LIMIT = 2_000_000;

export interface EndgamePlan {
  /** Words to play, highest reward first. Empty if nothing is playable. */
  words: string[];
  total: number;
  /** False when the check budget ran out before the search finished. */
  exact: boolean;
  checks: number;
}

/**
 * Best total reward from at most `opportunities` words spelled from the
 * current rack alone (no future letters). Words may repeat if the tiles
 * allow. Ties go to the plan whose first word scores more, then to the
 * one found first (candidates ordered by reward, then dictionary order).
 */
function planEndgameIdx(
  ix: Idx,
  rack: Uint8Array,
  opportunities: number,
  limit: number,
): EndgamePlan {
  const left = rack.slice();
  let tiles = 0;
  for (let k = 0; k < 26; k++) tiles += left[k];
  const depth = Math.max(0, Math.floor(opportunities));

  // Words playable from the rack now, best reward first.
  const cand: number[] = [];
  for (let i = 0; i < ix.words.length; i++) {
    if (ix.len[i] > tiles) continue;
    const o = i * 26;
    let ok = true;
    for (let k = 0; k < 26; k++) {
      if (ix.counts[o + k] > left[k]) { ok = false; break; }
    }
    if (ok) cand.push(i);
  }
  cand.sort((a, b) => ix.reward[b] - ix.reward[a] || a - b);
  if (!cand.length || depth === 0) {
    return { words: [], total: 0, exact: true, checks: 0 };
  }
  let ratio = 0;
  for (const i of cand) ratio = Math.max(ratio, ix.reward[i] / ix.len[i]);

  const fits = (i: number) => {
    const o = i * 26;
    for (let k = 0; k < 26; k++) if (ix.counts[o + k] > left[k]) return false;
    return true;
  };
  const take = (i: number, sign: number) => {
    const o = i * 26;
    for (let k = 0; k < 26; k++) left[k] -= sign * ix.counts[o + k];
  };

  // Greedy plan (the original rule applied repeatedly) as the incumbent.
  let best: number[] = [];
  let bestTotal = 0;
  {
    let t = tiles;
    for (let d = 0; d < depth; d++) {
      const next = cand.find((i) => ix.len[i] <= t && fits(i));
      if (next === undefined) break;
      best.push(next);
      bestTotal += ix.reward[next];
      t -= ix.len[next];
      take(next, 1);
    }
    for (const i of best) take(i, -1);
  }

  // Exact branch and bound over non-increasing candidate order, so each
  // multiset of words is visited once.
  let checks = 0;
  let exhausted = false;
  const path: number[] = [];
  const dfs = (start: number, t: number, d: number, total: number) => {
    if (path.length && (total > bestTotal ||
        (total === bestTotal && ix.reward[path[0]] > ix.reward[best[0]]))) {
      best = path.slice();
      bestTotal = total;
    }
    if (d === 0) return;
    const cap = Math.floor(ratio * t + 1e-9);
    for (let j = start; j < cand.length; j++) {
      if (checks >= limit) { exhausted = true; return; }
      checks++;
      const i = cand[j];
      const r = ix.reward[i];
      // Later candidates score no more than r, so neither can this branch.
      if (total + Math.min(d * r, cap) <= bestTotal) break;
      if (ix.len[i] > t || !fits(i)) continue;
      take(i, 1);
      path.push(i);
      dfs(j, t - ix.len[i], d - 1, total + r);
      path.pop();
      take(i, -1);
      if (exhausted) return;
    }
  };
  dfs(0, tiles, depth, 0);

  return {
    words: best.map((i) => ix.words[i]),
    total: bestTotal,
    exact: !exhausted,
    checks,
  };
}

/** Plan the endgame for a rack; exported for tests and offline analysis. */
export function planEndgame(
  myRack: Map<string, number>,
  dictionary: string[],
  opportunities: number,
  limit = ENDGAME_CHECK_LIMIT,
): EndgamePlan {
  return planEndgameIdx(index(dictionary), toArr(myRack), opportunities, limit);
}

function canSpell(word: string, rack: Map<string, number>): boolean {
  const used: Record<string, number> = {};
  for (const c of word) {
    used[c] = (used[c] ?? 0) + 1;
    if (used[c] > (rack.get(c) ?? 0)) return false;
  }
  return true;
}

/** Build the dictionary index ahead of time so the first auction isn't slow. */
export function warmUp(dictionary: string[]) { index(dictionary); }
