// Offline benchmark runner. No network, no SpacetimeDB connection.
//
//   node --import tsx src/harness/run.ts --seeds 101-102 \
//     --field baseline,baseline,starter,starter,aggr --mode vickrey \
//     --seats all --out /tmp/bench.json
//
// See README.md in this directory.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildDictionary,
  latencySummary,
  makeEnvironment,
  playMatch,
  type AuctionType,
  type MatchResult,
  type PlayerResult,
} from "./engine.js";
import { hashSeed } from "./rng.js";
import {
  BOT_STARTER,
  DEFAULT_CANDIDATE,
  FIELD_KINDS,
  FROZEN,
  WORDLIST,
  loadPolicies,
  seatPolicy,
  sha256File,
  warmUp,
  type FieldKind,
} from "./policies.js";

const EVAL_SEEDS = new Set([1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009, 1010]);

export interface RunOptions {
  seeds: number[];
  field: FieldKind[];
  auctionType: AuctionType;
  seats: number[] | "all";
  candidate: string;
  wordAttemptsPerRound: number;
  timeLimitMs: number;
  keepTrace: boolean;
  allowEvalSeeds: boolean;
}

function parseSeeds(s: string): number[] {
  const out: number[] = [];
  for (const part of s.split(",")) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) throw new Error(`Bad seed list: ${s}`);
    const a = +m[1]!;
    const b = m[2] ? +m[2] : a;
    for (let x = a; x <= b; x++) out.push(x);
  }
  return out;
}

export function parseArgs(argv: string[]): RunOptions & { out?: string } {
  const get = (k: string) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (k: string) => argv.includes(`--${k}`);
  const field = (get("field") ?? "baseline,baseline,baseline,baseline,baseline")
    .split(",")
    .map((x) => x.trim()) as FieldKind[];
  for (const k of field) {
    if (!FIELD_KINDS.includes(k)) throw new Error(`Unknown field kind '${k}'. Use ${FIELD_KINDS.join(", ")}`);
  }
  const mode = (get("mode") ?? "vickrey").toLowerCase();
  if (mode !== "vickrey" && mode !== "first-price") throw new Error("--mode vickrey|first-price");
  const seatsArg = get("seats") ?? "all";
  return {
    seeds: parseSeeds(get("seeds") ?? "101-110"),
    field,
    auctionType: mode === "vickrey" ? "Vickrey" : "FirstPrice",
    seats: seatsArg === "all" ? "all" : seatsArg.split(",").map((x) => +x),
    candidate: get("candidate") ?? DEFAULT_CANDIDATE,
    wordAttemptsPerRound: +(get("word-attempts") ?? 1),
    timeLimitMs: +(get("time-limit-ms") ?? 300_000),
    keepTrace: has("trace"),
    allowEvalSeeds: has("allow-eval-seeds"),
    out: get("out"),
  };
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const round3 = (x: number) => Math.round(x * 1000) / 1000;

function aggregate(rows: PlayerResult[]) {
  const n = rows.length;
  if (!n) return { games: 0 };
  const mean = (f: (r: PlayerResult) => number) => round3(rows.reduce((a, r) => a + f(r), 0) / n);
  const scores = rows.map((r) => r.score);
  const m = scores.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(scores.reduce((a, x) => a + (x - m) ** 2, 0) / (n - 1)) : 0;
  const spent = rows.reduce((a, r) => a + r.totalSpent, 0);
  const tiles = rows.reduce((a, r) => a + r.tilesBought, 0);
  return {
    games: n,
    meanScore: round3(m),
    sdScore: round3(sd),
    meanPlacement: mean((r) => r.placement),
    winRate: mean((r) => (r.win ? 1 : 0)),
    sharedWins: rows.filter((r) => r.sharedWin).length,
    meanMarginVsBestOpponent: mean((r) => r.marginVsBestOpponent),
    meanTotalSpent: mean((r) => r.totalSpent),
    meanTilesBought: mean((r) => r.tilesBought),
    avgPricePaid: tiles ? round3(spent / tiles) : null,
    meanEndingBalance: mean((r) => r.endingBalance),
    meanWordsPlayed: mean((r) => r.wordsPlayed),
    meanUnplayedTiles: mean((r) => r.unplayedTiles),
    meanUnplayedFaceValue: mean((r) => r.unplayedFaceValue),
    invalidBids: rows.reduce((a, r) => a + r.invalidBids, 0),
    invalidWords: rows.reduce((a, r) => a + r.invalidWords, 0),
  };
}

export async function run(opts: RunOptions) {
  const evalUsed = opts.seeds.filter((s) => EVAL_SEEDS.has(s));
  if (evalUsed.length && !opts.allowEvalSeeds) {
    throw new Error(`Seeds ${evalUsed.join(",")} are reserved for evaluation; pass --allow-eval-seeds`);
  }
  const players = opts.field.length + 1;
  const seats = opts.seats === "all" ? [...Array(players).keys()] : opts.seats;
  for (const s of seats) if (!(s >= 0 && s < players)) throw new Error(`Seat ${s} out of range`);

  const tLoad = performance.now();
  const text = fs.readFileSync(WORDLIST, "utf8");
  const dictionary = buildDictionary(text);
  const dictMs = performance.now() - tLoad;
  const policies = await loadPolicies(opts.candidate);
  const warmMs = warmUp(policies, dictionary.byLength);

  const here = path.dirname(fileURLToPath(import.meta.url));
  const harnessFiles = ["engine.ts", "policies.ts", "rng.ts", "run.ts"];
  const sourceHashes: Record<string, string> = {
    "spacetimedb/wordlist.txt": sha256File(WORDLIST),
  };
  for (const f of harnessFiles) sourceHashes[`bot-starter/src/harness/${f}`] = sha256File(path.join(here, f));

  const started = performance.now();
  const games: unknown[] = [];
  const timing: unknown[] = [];
  const byPolicy = new Map<string, PlayerResult[]>();
  const latByPolicy = new Map<string, { bid: number[]; word: number[] }>();
  const planned = opts.seeds.length * seats.length;
  let stopped = false;

  outer: for (const seed of opts.seeds) {
    const env = makeEnvironment(seed, players);
    for (const seat of seats) {
      if (performance.now() - started >= opts.timeLimitMs) {
        stopped = true;
        break outer;
      }
      const kinds = [...opts.field];
      kinds.splice(seat, 0, "candidate");
      const seatPolicies = kinds.map((k) => seatPolicy(k, policies));
      const t0 = performance.now();
      const res: MatchResult = playMatch({
        seats: seatPolicies,
        auctionType: opts.auctionType,
        env,
        dictionary,
        wordAttemptsPerRound: opts.wordAttemptsPerRound,
        policySeed: hashSeed(seed, seat, "policy"),
        keepTrace: opts.keepTrace,
      });
      const wallMs = performance.now() - t0;
      games.push({
        seed,
        candidateSeat: seat,
        seats: kinds,
        traceHash: res.traceHash,
        accounting: res.accounting,
        players: res.players,
        rejections: res.rejections,
        ...(res.trace ? { trace: res.trace } : {}),
      });
      timing.push({
        seed,
        candidateSeat: seat,
        gameWallMs: round3(wallMs),
        players: res.latency.map((l, s) => ({
          seat: s,
          policy: kinds[s],
          bid: latencySummary(l.bid),
          word: latencySummary(l.word),
        })),
      });
      res.players.forEach((p, s) => {
        const id = kinds[s]!;
        if (!byPolicy.has(id)) byPolicy.set(id, []);
        byPolicy.get(id)!.push(p);
        if (!latByPolicy.has(id)) latByPolicy.set(id, { bid: [], word: [] });
        latByPolicy.get(id)!.bid.push(...res.latency[s]!.bid);
        latByPolicy.get(id)!.word.push(...res.latency[s]!.word);
      });
    }
  }

  const deterministic = games.map((g) => {
    const { rejections: _r, trace: _t, ...rest } = g as Record<string, unknown>;
    return rest;
  });
  const summary: Record<string, unknown> = {};
  for (const [id, rows] of byPolicy) summary[id] = aggregate(rows);
  const latency: Record<string, unknown> = {};
  for (const [id, l] of latByPolicy) {
    latency[id] = { bid: latencySummary(l.bid), word: latencySummary(l.word) };
  }

  return {
    label: "OFFLINE simulation. Provisional; not a measure of live strength.",
    config: {
      seeds: opts.seeds,
      field: opts.field,
      players,
      auctionType: opts.auctionType,
      candidateSeats: seats,
      wordAttemptsPerRound: opts.wordAttemptsPerRound,
      timeLimitMs: opts.timeLimitMs,
      startingBalance: 100,
      startingRack: 5,
    },
    policies: {
      candidate: {
        file: path.relative(BOT_STARTER, policies.candidate.file),
        sha256: policies.candidate.sha256,
        wrapper: policies.candidate.wrapper,
      },
      baseline: {
        file: path.relative(BOT_STARTER, FROZEN.baseline.file),
        sha256: policies.baseline.sha256,
        source: FROZEN.baseline.source,
        wrapper: FROZEN.baseline.wrapper,
      },
      starter: {
        file: path.relative(BOT_STARTER, FROZEN.starter.file),
        sha256: policies.starter.sha256,
        source: FROZEN.starter.source,
        wrapper: FROZEN.starter.wrapper,
      },
      sims: "cheap/value/aggr mirror the module's Cheapskate/ValueBidder/Aggressive",
    },
    sourceHashes,
    plannedGames: planned,
    completedGames: games.length,
    stoppedByTimeLimit: stopped,
    deterministicDigest: sha(JSON.stringify(deterministic)),
    summary,
    games,
    timing: {
      label:
        "Offline compute latency of policy calls in this process. Excludes network, SDK and subscription overhead. Not part of the deterministic digest.",
      init: {
        dictionaryLoadAndBuildMs: round3(dictMs),
        indexWarmUpMs: warmMs,
      },
      totalBenchmarkMs: round3(performance.now() - started),
      byPolicy: latency,
      perGame: timing,
    },
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  run(opts)
    .then((result) => {
      const json = JSON.stringify(result, null, 2);
      if (opts.out) fs.writeFileSync(opts.out, json);
      else process.stdout.write(json + "\n");
      const c = result.summary.candidate as Record<string, unknown> | undefined;
      console.error(
        `[OFFLINE] ${result.completedGames}/${result.plannedGames} games` +
          (result.stoppedByTimeLimit ? " (stopped by time limit)" : "") +
          ` digest ${result.deterministicDigest.slice(0, 16)}` +
          (c ? ` candidate meanScore ${c.meanScore} winRate ${c.winRate} meanPlace ${c.meanPlacement}` : ""),
      );
    })
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
