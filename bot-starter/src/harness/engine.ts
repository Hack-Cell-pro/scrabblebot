// Offline match engine for comparing bot policies.
//
// Mirrors the official module at clockworklabs/scrabblebot
// b5ccb36aa238ad16692f8d6af54da15ef9f11324 (spacetimedb/src, identical to
// this checkout). References below are to that source:
//   game.ts  startMatchWith  deal racks, draw the first letter, open auction
//   game.ts  simulateBids    sims bid when an auction opens
//   game.ts  closeAuction    shuffle + stable sort, pay, award, sim word play,
//                            draw next letter or end the match (one transaction)
//   game.ts  decideBid       sim bid = clamp(base + jitter, 1, balance)
//   index.ts submitBid       reject negative / over-balance bids
//   index.ts submitWord      reject when not running, <2 letters, non A-Z,
//                            not in the dictionary, not spellable
//   dictionary.ts findBestPlayable  sims play the longest word of 3+ letters
//
// External bots are modelled through the wrapper that runs them live
// (bot-starter/src/index.ts here, or the official starter's index.ts):
// which context fields they receive, and when they get a word attempt.
// See README.md in this directory for the timing approximations.

import { createHash } from "node:crypto";
import { fisherYates, hashSeed, intInRange, mulberry32 } from "./rng.js";

// ---------- Server constants (spacetimedb/src/letters.ts, game.ts) ----------

export const DEFAULT_BAG: readonly (readonly [string, number])[] = [
  ["A", 9], ["B", 2], ["C", 2], ["D", 4], ["E", 12], ["F", 2], ["G", 3],
  ["H", 2], ["I", 9], ["J", 1], ["K", 1], ["L", 4], ["M", 2], ["N", 6],
  ["O", 8], ["P", 2], ["Q", 1], ["R", 6], ["S", 4], ["T", 6], ["U", 4],
  ["V", 2], ["W", 2], ["X", 1], ["Y", 2], ["Z", 1],
];
const VALUES: Record<string, number> = {
  A: 1, E: 1, I: 1, O: 1, U: 1, L: 1, N: 1, S: 1, T: 1, R: 1,
  D: 2, G: 2, B: 3, C: 3, M: 3, P: 3, F: 4, H: 4, V: 4, W: 4, Y: 4,
  K: 5, J: 8, X: 8, Q: 10, Z: 10,
};
export const letterValue = (c: string) => VALUES[c] ?? 0;
export function lengthMultiplier(len: number): [number, number] {
  if (len <= 3) return [1, 1];
  if (len === 4) return [3, 2];
  if (len === 5) return [2, 1];
  if (len === 6) return [5, 2];
  return [3, 1];
}
export function reward(word: string): number {
  let base = 0;
  for (const c of word) base += letterValue(c);
  const [n, d] = lengthMultiplier(word.length);
  return Math.floor((base * n) / d); // BigInt division in the module
}
export const STARTING_BALANCE = 100;
export const STARTING_RACK_SIZE = 5;
export const AUCTION_RESERVE = 1;
export const SIM_BID_JITTER = 2;

export function fullBag(): string[] {
  const tiles: string[] = [];
  for (const [l, n] of DEFAULT_BAG) for (let i = 0; i < n; i++) tiles.push(l);
  return tiles;
}

// ---------- Policies ----------

export type AuctionType = "Vickrey" | "FirstPrice";
export type SimStrategy = "cheap" | "value" | "aggr";
/** Which live wrapper drives an external policy. */
export type Wrapper = "goats-live" | "official-starter";

export interface ExternalPolicy {
  kind: "external";
  id: string;
  wrapper: Wrapper;
  decideBid: (ctx: Record<string, unknown>) => unknown;
  chooseWord: (ctx: Record<string, unknown>) => unknown;
}
export interface SimPolicy {
  kind: "sim";
  id: string;
  strategy: SimStrategy;
}
export type SeatPolicy = ExternalPolicy | SimPolicy;

export function simPolicy(strategy: SimStrategy): SimPolicy {
  return { kind: "sim", id: strategy, strategy };
}

// game.ts decideBid
export function simBid(
  strategy: SimStrategy,
  letter: string,
  balance: number,
  jitter: number,
): number {
  const v = letterValue(letter);
  const base =
    strategy === "cheap"
      ? v - 1
      : strategy === "value"
        ? v
        : v + ("AEIOU".includes(letter) ? 4 : 2);
  return Math.max(Math.min(Math.max(base + jitter, 1), balance), 0);
}

// ---------- Environment ----------

/**
 * Everything random that the server decides, fixed before play so that
 * policy decisions cannot shift it.
 *  - draws: tile order. The first players*rack are dealt (seat 0 first, as
 *    the module deals in roster order); the rest are auctioned in order.
 *    Unbid tiles are discarded, so this order never depends on bids.
 *  - tiePriority[r]: seat permutation for auction r; earlier wins ties.
 *    Equivalent to the module's Fisher-Yates shuffle before its stable sort.
 *  - jitter[r][seat]: sim bid jitter in [-2, 2] for auction r.
 */
export interface Environment {
  draws: string[];
  tiePriority: number[][];
  jitter: number[][];
}

export function makeEnvironment(
  seed: number,
  players: number,
  startingRack = STARTING_RACK_SIZE,
  bag: string[] = fullBag(),
): Environment {
  const draws = fisherYates(mulberry32(hashSeed(seed, "bag")), [...bag]);
  const auctions = draws.length - players * startingRack;
  const tieRng = mulberry32(hashSeed(seed, players, "ties"));
  const jitRng = mulberry32(hashSeed(seed, players, "jitter"));
  const tiePriority: number[][] = [];
  const jitter: number[][] = [];
  for (let r = 0; r < auctions; r++) {
    tiePriority.push(fisherYates(tieRng, [...Array(players).keys()]));
    jitter.push(
      Array.from({ length: players }, () =>
        intInRange(jitRng, -SIM_BID_JITTER, SIM_BID_JITTER),
      ),
    );
  }
  return { draws, tiePriority, jitter };
}

// ---------- Dictionary ----------

export interface Dictionary {
  /** As the live wrappers build it: trimmed, upper, >= 2, longest first. */
  byLength: string[];
  /** As the module validates: the raw wordlist lines. */
  valid: Set<string>;
}

export function buildDictionary(wordlistText: string): Dictionary {
  const byLength = wordlistText
    .split("\n")
    .map((l) => l.trim().toUpperCase())
    .filter((l) => l.length >= 2)
    .sort((a, b) => b.length - a.length);
  const valid = new Set(wordlistText.split("\n").filter((l) => l.length > 0));
  return { byLength, valid };
}

// dictionary.ts findBestPlayable. `byLength` keeps the lex order within a
// length (stable sort of a lex-sorted file), as `wordsByLength` does.
function findBestPlayable(
  dict: string[],
  rack: Map<string, number>,
  minLen: number,
): string | undefined {
  let total = 0;
  for (const n of rack.values()) total += n;
  if (total < minLen) return undefined;
  for (const w of dict) {
    if (w.length < minLen) break;
    if (w.length > total) continue;
    if (spell(w, rack) === null) return w;
  }
  return undefined;
}

/** null if `rack` can spell `word`, else the module's error message. */
function spell(word: string, rack: Map<string, number>): string | null {
  const need = new Map<string, number>();
  for (const c of word) need.set(c, (need.get(c) ?? 0) + 1);
  for (const [c, n] of need) {
    const have = rack.get(c) ?? 0;
    if (have < n) return `Not enough '${c}': need ${n}, have ${have}`;
  }
  return null;
}

// ---------- Match ----------

export interface MatchConfig {
  seats: SeatPolicy[];
  auctionType: AuctionType;
  env: Environment;
  dictionary: Dictionary;
  startingRack?: number;
  /** Word attempts per opportunity. 1 models the live 500 ms throttle. */
  wordAttemptsPerRound?: number;
  /** Seeds Math.random during the match, for policies that use it. */
  policySeed?: number;
  /** Keep the full action trace in the result. */
  keepTrace?: boolean;
}

export interface Rejection {
  round: number;
  action: "bid" | "word";
  value: string;
  reason: string;
}

export interface PlayerResult {
  seat: number;
  policy: string;
  score: number;
  placement: number;
  win: boolean;
  sharedWin: boolean;
  marginVsBestOpponent: number;
  totalSpent: number;
  tilesBought: number;
  avgPricePaid: number | null;
  endingBalance: number;
  wordsPlayed: number;
  unplayedTiles: number;
  unplayedFaceValue: number;
  forfeitedTiles: number;
  invalidBids: number;
  invalidWords: number;
  rejectionReasons: Record<string, number>;
  bidCalls: number;
  wordCalls: number;
}

export interface Accounting {
  bagTiles: number;
  dealt: number;
  auctions: number;
  sold: number;
  unsold: number;
  forfeited: number;
  heldAtEnd: number;
  playedTiles: number;
  /** held + played + unsold + forfeited equals the bag, letter by letter. */
  reconciles: boolean;
}

export interface MatchResult {
  players: PlayerResult[];
  accounting: Accounting;
  traceHash: string;
  trace?: unknown[];
  rejections: Rejection[][];
  /** Offline compute latency in ms, per seat. Not deterministic. */
  latency: { bid: number[]; word: number[] }[];
}

interface Player {
  rack: Map<string, number>;
  balance: number;
  score: number;
  spent: number;
  bought: number;
  forfeited: number;
  words: string[];
  rejections: Rejection[];
  bidCalls: number;
  wordCalls: number;
  bidMs: number[];
  wordMs: number[];
  /** official-starter wrapper: rack changed since the last word attempt. */
  rackChanged: boolean;
}

function addTile(rack: Map<string, number>, l: string) {
  rack.set(l, (rack.get(l) ?? 0) + 1);
}

/** asciiUppercase from spacetimedb/src/text.ts: only a-z change. */
function asciiUpper(s: string) {
  return s.replace(/[a-z]/g, (c) => c.toUpperCase());
}

function describe(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") return String(v);
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

export function playMatch(cfg: MatchConfig): MatchResult {
  const n = cfg.seats.length;
  const rackSize = cfg.startingRack ?? STARTING_RACK_SIZE;
  const attempts = cfg.wordAttemptsPerRound ?? 1;
  const { env, dictionary: dict } = cfg;
  const dealt = n * rackSize;
  const auctions = env.draws.length - dealt;
  if (auctions < 1) throw new Error("Bag empty: no tile to auction");
  if (env.tiePriority.length < auctions || env.jitter.length < auctions) {
    throw new Error("Environment is shorter than the match");
  }

  const ps: Player[] = cfg.seats.map(() => ({
    rack: new Map(),
    balance: STARTING_BALANCE,
    score: 0,
    spent: 0,
    bought: 0,
    forfeited: 0,
    words: [],
    rejections: [],
    bidCalls: 0,
    wordCalls: 0,
    bidMs: [],
    wordMs: [],
    rackChanged: true,
  }));
  for (let s = 0; s < n; s++) {
    for (let i = 0; i < rackSize; i++) addTile(ps[s]!.rack, env.draws[s * rackSize + i]!);
  }

  const trace: unknown[] = [
    { deal: ps.map((p) => [...p.rack].sort().map(([l, c]) => l.repeat(c)).join("")) },
  ];
  let unsold = 0;
  let forfeitedTotal = 0;
  const forfeitedLetters: string[] = [];
  const unsoldLetters: string[] = [];

  const reject = (s: number, round: number, action: "bid" | "word", v: unknown, reason: string) =>
    ps[s]!.rejections.push({ round, action, value: describe(v), reason });

  // The live wrappers build a fresh rack map per call, with no zero rows.
  const rackCopy = (p: Player) => {
    const m = new Map<string, number>();
    for (const [l, c] of p.rack) if (c > 0) m.set(l, c);
    return m;
  };

  const playWord = (p: Player, word: string) => {
    for (const c of word) {
      const left = p.rack.get(c)! - 1;
      if (left === 0) p.rack.delete(c);
      else p.rack.set(c, left);
    }
    const r = reward(word);
    p.balance += r;
    p.score += r;
    p.words.push(word);
    return r;
  };

  const realRandom = Math.random;
  if (cfg.policySeed !== undefined) Math.random = mulberry32(cfg.policySeed);
  try {
    for (let r = 0; r < auctions; r++) {
      const letter = env.draws[dealt + r]!;
      const bagTotal = auctions - r - 1; // match_state.bag_total once drawn
      const bids = new Map<number, number>();
      const words: unknown[] = [];

      // Auction opens: sims bid inside the opening transaction.
      cfg.seats.forEach((pol, s) => {
        if (pol.kind !== "sim") return;
        const amt = simBid(pol.strategy, letter, ps[s]!.balance, env.jitter[r]![s]!);
        if (amt > 0) bids.set(s, amt);
      });

      // External bots react during the window: bid, then word attempt.
      cfg.seats.forEach((pol, s) => {
        if (pol.kind !== "external") return;
        const p = ps[s]!;
        const live = pol.wrapper === "goats-live";

        const bidCtx: Record<string, unknown> = live
          ? {
              letter,
              myBalance: p.balance,
              myRack: rackCopy(p),
              dictionary: dict.byLength,
              bagTotal,
              auctionType: cfg.auctionType,
              players: n,
            }
          : { letter, myBalance: p.balance, myRack: rackCopy(p) };
        let amount: unknown;
        p.bidCalls++;
        const t0 = performance.now();
        try {
          amount = pol.decideBid(bidCtx);
        } catch (e) {
          amount = undefined;
          reject(s, r, "bid", "throw", `decideBid threw: ${(e as Error)?.message ?? e}`);
        } finally {
          p.bidMs.push(performance.now() - t0);
        }
        if (amount !== undefined) {
          if (typeof amount !== "number") {
            reject(s, r, "bid", amount, "not a number");
          } else if (amount === 0) {
            // the wrapper skips non-positive bids: a deliberate pass
          } else if (amount < 0) {
            reject(s, r, "bid", amount, "negative: live wrapper skips submission");
          } else if (!Number.isInteger(amount)) {
            reject(s, r, "bid", amount, "non-integer: BigInt() throws in live wrapper");
          } else if (amount > p.balance) {
            reject(s, r, "bid", amount, "Insufficient balance");
          } else {
            bids.set(s, amount);
          }
        }

        // Word opportunity. goats-live: every round (match_state.bag_total
        // changes each auction). official-starter: only after its rack
        // changed (initial deal, or it won the last auction).
        const opportunity = live || p.rackChanged;
        p.rackChanged = false;
        if (!opportunity) return;
        for (let k = 0; k < attempts; k++) {
          const wordCtx: Record<string, unknown> = live
            ? {
                myRack: rackCopy(p),
                dictionary: dict.byLength,
                bagTotal,
                auctionType: cfg.auctionType,
                players: n,
              }
            : { myRack: rackCopy(p), dictionary: dict.byLength };
          let w: unknown;
          p.wordCalls++;
          const t1 = performance.now();
          try {
            w = pol.chooseWord(wordCtx);
          } catch (e) {
            p.wordMs.push(performance.now() - t1);
            reject(s, r, "word", "throw", `chooseWord threw: ${(e as Error)?.message ?? e}`);
            break;
          }
          p.wordMs.push(performance.now() - t1);
          if (!w) break; // the wrapper submits nothing
          if (typeof w !== "string") {
            reject(s, r, "word", w, "not a string");
            break;
          }
          const up = asciiUpper(w);
          const err =
            up.length < 2
              ? "Word must be at least 2 letters"
              : !/^[A-Z]+$/.test(up)
                ? "Word must be A-Z only"
                : !dict.valid.has(up)
                  ? `not in the dictionary`
                  : spell(up, p.rack);
          if (err) {
            reject(s, r, "word", w, err);
            break;
          }
          words.push({ seat: s, word: up, reward: playWord(p, up) });
        }
      });

      // Auction closes (scheduled transaction).
      const order = [...bids.keys()];
      const prio = env.tiePriority[r]!;
      order.sort((a, b) => bids.get(b)! - bids.get(a)! || prio.indexOf(a) - prio.indexOf(b));
      let outcome: "sold" | "unsold" | "forfeited" = "unsold";
      let winner: number | undefined;
      let paid = 0;
      let simWord: string | undefined;
      if (order.length) {
        winner = order[0]!;
        const top = bids.get(winner)!;
        paid =
          cfg.auctionType === "FirstPrice"
            ? top
            : order[1] !== undefined
              ? bids.get(order[1])!
              : Math.min(AUCTION_RESERVE, top);
        const w = ps[winner]!;
        if (w.balance >= paid) {
          w.balance -= paid;
          w.spent += paid;
          w.bought++;
          addTile(w.rack, letter);
          w.rackChanged = true;
          outcome = "sold";
          const pol = cfg.seats[winner]!;
          // The module plays a sim winner's word before drawing the next
          // letter, in the same transaction, so this also happens on the
          // final auction.
          if (pol.kind === "sim") {
            simWord = findBestPlayable(dict.byLength, w.rack, 3);
            if (simWord) words.push({ seat: winner, word: simWord, reward: playWord(w, simWord), sim: true });
          }
        } else {
          outcome = "forfeited";
          w.forfeited++;
          forfeitedTotal++;
          forfeitedLetters.push(letter);
        }
      } else {
        unsold++;
        unsoldLetters.push(letter);
      }
      trace.push({
        r,
        letter,
        bagTotal,
        bids: [...bids].sort((a, b) => a[0] - b[0]),
        words,
        outcome,
        winner,
        paid,
      });
      // If that was the last tile, the match ended in the same transaction:
      // no external bot gets another word opportunity.
    }
  } finally {
    Math.random = realRandom;
  }

  // Ranking: tied scores share a place (game.ts updateEloAtMatchEnd).
  const scores = ps.map((p) => p.score);
  const players: PlayerResult[] = ps.map((p, s) => {
    const others = scores.filter((_, i) => i !== s);
    const best = Math.max(...others);
    const placement = 1 + others.filter((x) => x > p.score).length;
    const reasons: Record<string, number> = {};
    for (const rj of p.rejections) {
      const key = `${rj.action}: ${rj.reason.replace(/'.'.*$/, "'?'")}`;
      reasons[key] = (reasons[key] ?? 0) + 1;
    }
    let unplayed = 0;
    let face = 0;
    for (const [l, c] of p.rack) {
      unplayed += c;
      face += c * letterValue(l);
    }
    return {
      seat: s,
      policy: cfg.seats[s]!.id,
      score: p.score,
      placement,
      win: placement === 1,
      sharedWin: placement === 1 && others.includes(p.score),
      marginVsBestOpponent: p.score - best,
      totalSpent: p.spent,
      tilesBought: p.bought,
      avgPricePaid: p.bought ? p.spent / p.bought : null,
      endingBalance: p.balance,
      wordsPlayed: p.words.length,
      unplayedTiles: unplayed,
      unplayedFaceValue: face,
      forfeitedTiles: p.forfeited,
      invalidBids: p.rejections.filter((x) => x.action === "bid").length,
      invalidWords: p.rejections.filter((x) => x.action === "word").length,
      rejectionReasons: reasons,
      bidCalls: p.bidCalls,
      wordCalls: p.wordCalls,
    };
  });

  // Tile accounting, letter by letter.
  const end: string[] = [...unsoldLetters, ...forfeitedLetters];
  let held = 0;
  let played = 0;
  for (const p of ps) {
    for (const [l, c] of p.rack) {
      held += c;
      for (let i = 0; i < c; i++) end.push(l);
    }
    for (const w of p.words) {
      played += w.length;
      end.push(...w);
    }
  }
  const sorted = (a: string[]) => [...a].sort().join("");
  const accounting: Accounting = {
    bagTiles: env.draws.length,
    dealt,
    auctions,
    sold: auctions - unsold - forfeitedTotal,
    unsold,
    forfeited: forfeitedTotal,
    heldAtEnd: held,
    playedTiles: played,
    reconciles: sorted(end) === sorted(env.draws),
  };

  const rejections = ps.map((p) => p.rejections);
  const fullTrace = [...trace, { rejections }];
  const traceHash = createHash("sha256").update(JSON.stringify(fullTrace)).digest("hex");
  return {
    players,
    accounting,
    traceHash,
    trace: cfg.keepTrace ? fullTrace : undefined,
    rejections,
    latency: ps.map((p) => ({ bid: p.bidMs, word: p.wordMs })),
  };
}

export function latencySummary(ms: number[]) {
  if (!ms.length) return { calls: 0, p50: null, p95: null, max: null };
  const a = [...ms].sort((x, y) => x - y);
  const q = (f: number) => a[Math.min(a.length - 1, Math.ceil(f * a.length) - 1)]!;
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return { calls: a.length, p50: r(q(0.5)), p95: r(q(0.95)), max: r(a[a.length - 1]!) };
}
