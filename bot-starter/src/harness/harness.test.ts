// Harness checks. Run with:
//   node --import tsx --test src/harness/harness.test.ts

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  DEFAULT_BAG,
  buildDictionary,
  fullBag,
  lengthMultiplier,
  letterValue,
  makeEnvironment,
  playMatch,
  simPolicy,
  type AuctionType,
  type Environment,
  type ExternalPolicy,
  type MatchConfig,
} from "./engine.js";
import {
  FROZEN,
  WORDLIST,
  assertNoParamEnv,
  loadPolicies,
  seatPolicy,
  verifyFrozen,
  warmUp,
} from "./policies.js";
import { run } from "./run.js";

const small = buildDictionary("ACT\nAT\nCAT\nTA\n");

function ext(
  bid: (ctx: Record<string, unknown>) => unknown,
  word: (ctx: Record<string, unknown>) => unknown = () => null,
  id = "ext",
): ExternalPolicy {
  return { kind: "external", id, wrapper: "goats-live", decideBid: bid, chooseWord: word };
}

/** Racks of `rack` tiles per seat, then the auctioned letters. */
function env(racks: string[], auctions: string, ties?: number[][]): Environment {
  const draws = [...racks.join(""), ...auctions];
  const n = racks.length;
  return {
    draws,
    tiePriority: ties ?? [...auctions].map(() => [...Array(n).keys()]),
    jitter: [...auctions].map(() => Array(n).fill(0)),
  };
}

function match(cfg: Partial<MatchConfig> & Pick<MatchConfig, "seats" | "env">) {
  return playMatch({
    auctionType: "Vickrey",
    dictionary: small,
    startingRack: 2,
    keepTrace: true,
    ...cfg,
  });
}

const spellCat = (ctx: Record<string, unknown>) => {
  const r = ctx.myRack as Map<string, number>;
  return r.get("C") && r.get("A") && r.get("T") ? "CAT" : null;
};

test("an external bot cannot use the letter won in the final auction", () => {
  const res = match({
    seats: [ext(() => 1, spellCat), ext(() => 0)],
    env: env(["CA", "XX"], "T"),
  });
  const me = res.players[0]!;
  assert.equal(me.tilesBought, 1);
  assert.equal(me.score, 0, "CAT needs the final T, which arrives as the match ends");
  assert.equal(me.wordCalls, 1, "one attempt, during the final auction, before the T");
  assert.equal(me.unplayedTiles, 3);
});

test("an external bot can use a letter won before the final auction", () => {
  const res = match({
    seats: [ext(() => 1, spellCat), ext(() => 0)],
    env: env(["CA", "XX"], "TQ"),
  });
  assert.equal(res.players[0]!.score, 5);
});

test("a sim that wins the final auction plays inside the closing transaction", () => {
  const res = match({
    seats: [ext(() => 0), simPolicy("value")],
    env: env(["XX", "CA"], "T"),
  });
  const sim = res.players[1]!;
  assert.equal(sim.tilesBought, 1);
  assert.equal(sim.score, 5);
  assert.equal(sim.unplayedTiles, 0);
});

test("unbid tiles are discarded, not returned to the bag", () => {
  const res = match({
    seats: [ext(() => 0), ext(() => 0)],
    env: env(["AA", "AA"], "QT"),
  });
  const a = res.accounting;
  assert.deepEqual([a.auctions, a.unsold, a.sold], [2, 2, 0]);
  assert.equal(a.reconciles, true);
  const letters = (res.trace as { letter?: string; outcome?: string }[])
    .filter((t) => t.letter)
    .map((t) => `${t.letter}:${t.outcome}`);
  assert.deepEqual(letters, ["Q:unsold", "T:unsold"]);
});

test("tied bids go to the seat the round's tie priority puts first", () => {
  for (const [prio, winner] of [
    [[1, 0, 2], 1],
    [[0, 1, 2], 0],
    [[2, 1, 0], 1],
  ] as [number[], number][]) {
    const res = match({
      seats: [ext(() => 5), ext(() => 5), ext(() => 3)],
      env: env(["AA", "AA", "AA"], "Q", [prio]),
    });
    assert.equal(res.players[winner]!.tilesBought, 1, `priority ${prio}`);
    assert.equal(res.players[winner]!.totalSpent, 5, "second price equals the tied bid");
  }
});

test("vickrey and first-price payments", () => {
  const pay = (mode: AuctionType, bids: number[]) => {
    const res = match({
      auctionType: mode,
      seats: bids.map((b) => ext(() => b)),
      env: env(bids.map(() => "AA"), "Q"),
    });
    const w = res.players.find((p) => p.tilesBought === 1)!;
    return [w.seat, w.totalSpent, w.endingBalance];
  };
  assert.deepEqual(pay("Vickrey", [7, 3]), [0, 3, 97]);
  assert.deepEqual(pay("FirstPrice", [7, 3]), [0, 7, 93]);
  assert.deepEqual(pay("Vickrey", [6, 0]), [0, 1, 99], "lone bidder pays the reserve");
  assert.deepEqual(pay("FirstPrice", [6, 0]), [0, 6, 94]);
});

test("invalid bids and words are rejected with reasons, not corrected", () => {
  const bids: unknown[] = [101, 2.5, NaN, "5", -3];
  const words: unknown[] = ["ZZZ", "CAT", "A", "C4T", 42];
  let i = 0;
  let j = 0;
  const res = match({
    seats: [ext(() => bids[i++], () => words[j++]), ext(() => 1)],
    env: env(["CA", "XX"], "QQQQQ"),
  });
  const me = res.players[0]!;
  assert.equal(me.invalidBids, 5);
  assert.equal(me.invalidWords, 5);
  assert.equal(me.tilesBought, 0, "no rejected bid may win");
  assert.equal(me.endingBalance, 100);
  assert.equal(me.score, 0);
  assert.deepEqual(
    res.rejections[0]!.map((r) => r.reason),
    [
      "Insufficient balance",
      "not in the dictionary",
      "non-integer: BigInt() throws in live wrapper",
      "Not enough 'T': need 1, have 0",
      "non-integer: BigInt() throws in live wrapper",
      "Word must be at least 2 letters",
      "not a number",
      "Word must be A-Z only",
      "negative: live wrapper skips submission",
      "not a string",
    ],
  );
  assert.equal(res.players[1]!.tilesBought, 5);
});

test("lowercase words are uppercased, as the module does", () => {
  const res = match({
    seats: [ext(() => 0, (c) => ((c.myRack as Map<string, number>).get("T") ? "cat" : null)), ext(() => 0)],
    env: env(["CAT", "XXX"], "Q"),
    startingRack: 3,
  });
  assert.equal(res.players[0]!.score, 5);
  assert.equal(res.players[0]!.invalidWords, 0);
});

test("live wrappers pass only the context they really supply", () => {
  const seen: Record<string, string[]> = {};
  const spy = (wrapper: ExternalPolicy["wrapper"]): ExternalPolicy => ({
    kind: "external",
    id: wrapper,
    wrapper,
    decideBid: (c) => ((seen[`${wrapper}:bid`] = Object.keys(c).sort()), 0),
    chooseWord: (c) => ((seen[`${wrapper}:word`] = Object.keys(c).sort()), null),
  });
  match({ seats: [spy("goats-live"), spy("official-starter")], env: env(["AA", "AA"], "Q") });
  assert.deepEqual(seen["goats-live:bid"], ["auctionType", "bagTotal", "dictionary", "letter", "myBalance", "myRack", "players"]);
  assert.deepEqual(seen["goats-live:word"], ["auctionType", "bagTotal", "dictionary", "myRack", "players"]);
  assert.deepEqual(seen["official-starter:bid"], ["letter", "myBalance", "myRack"]);
  assert.deepEqual(seen["official-starter:word"], ["dictionary", "myRack"]);
});

test("the official starter only gets a word attempt after its rack changes", () => {
  let calls = 0;
  const starter: ExternalPolicy = {
    kind: "external",
    id: "s",
    wrapper: "official-starter",
    decideBid: (c) => ((c.letter as string) === "Q" ? 0 : 1),
    chooseWord: () => (calls++, null),
  };
  // Auctions: T (won), Q (not bid), T (won, final).
  match({ seats: [starter, ext(() => 0)], env: env(["AA", "AA"], "TQT") });
  assert.equal(calls, 2, "initial deal, then after winning T; not after the final T");
});

test("harness letters match the module's letters.ts", async () => {
  const server = (await import(
    new URL("../../../spacetimedb/src/letters.ts", import.meta.url).href
  )) as {
    DEFAULT_BAG: [string, number][];
    letterValue: (c: string) => number;
    lengthMultiplier: (n: number) => [bigint, bigint];
  };
  assert.deepEqual(DEFAULT_BAG, server.DEFAULT_BAG);
  for (const c of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") assert.equal(letterValue(c), server.letterValue(c));
  for (let n = 1; n <= 15; n++) {
    assert.deepEqual(lengthMultiplier(n), server.lengthMultiplier(n).map(Number));
  }
  assert.equal(fullBag().length, 98);
});

const dict = buildDictionary(fs.readFileSync(WORDLIST, "utf8"));

test("every tile is accounted for in a full match", async () => {
  const p = await loadPolicies();
  warmUp(p, dict.byLength);
  const kinds = ["baseline", "starter", "cheap", "value", "aggr", "candidate"] as const;
  const res = playMatch({
    seats: kinds.map((k) => seatPolicy(k, p)),
    auctionType: "Vickrey",
    env: makeEnvironment(101, 6),
    dictionary: dict,
  });
  const a = res.accounting;
  assert.equal(a.bagTiles, 98);
  assert.equal(a.dealt, 30);
  assert.equal(a.auctions, 68);
  assert.equal(a.sold + a.unsold + a.forfeited, 68);
  assert.equal(a.heldAtEnd + a.playedTiles + a.unsold + a.forfeited, 98);
  assert.equal(a.reconciles, true);
  for (const pl of res.players) {
    assert.equal(pl.endingBalance, 100 - pl.totalSpent + pl.score, `seat ${pl.seat} balance`);
  }
});

test("the frozen baseline loads independently of the candidate", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-"));
  const file = path.join(dir, "candidate.mjs");
  fs.writeFileSync(file, "export const decideBid = () => 0;\nexport const chooseWord = () => null;\n");
  try {
    const p = await loadPolicies(file);
    assert.notEqual(p.candidate.module, p.baseline.module);
    assert.equal(p.baseline.sha256, FROZEN.baseline.sha256);
    assert.equal(p.starter.sha256, FROZEN.starter.sha256);
    const ctx = {
      letter: "Z",
      myBalance: 100,
      myRack: new Map([["A", 1], ["E", 1]]),
      dictionary: dict.byLength,
      bagTotal: 40,
      players: 6,
      auctionType: "Vickrey",
    };
    assert.equal(p.candidate.policy.decideBid(ctx), 0);
    assert.ok((p.baseline.policy.decideBid(ctx) as number) > 0, "baseline keeps its own behaviour");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.throws(() => verifyFrozen(FROZEN.baseline.file, "0".repeat(64)), /expected/);
  assert.throws(() => assertNoParamEnv({ BID_K: "3" }), /BID_K/);
});

test("same configuration reproduces outcomes and traces", async () => {
  const opts = {
    seeds: [101],
    field: ["baseline", "starter", "aggr"] as ("baseline" | "starter" | "aggr")[],
    auctionType: "Vickrey" as const,
    seats: [0, 2],
    candidate: FROZEN.baseline.file,
    wordAttemptsPerRound: 1,
    timeLimitMs: 120_000,
    keepTrace: false,
    allowEvalSeeds: false,
  };
  const a = await run(opts);
  const b = await run(opts);
  assert.equal(a.completedGames, 2);
  assert.equal(a.deterministicDigest, b.deterministicDigest);
  assert.deepEqual(a.games, b.games);
  const c = await run({ ...opts, seeds: [102] });
  assert.notEqual(a.deterministicDigest, c.deterministicDigest);
  await assert.rejects(run({ ...opts, seeds: [1001] }), /reserved for evaluation/);
});

test("the environment does not depend on policy decisions", () => {
  const e = makeEnvironment(101, 3);
  const letters = (bid: number) =>
    (
      playMatch({
        seats: [ext(() => bid), ext(() => 0), simPolicy("cheap")],
        auctionType: "Vickrey",
        env: e,
        dictionary: dict,
        keepTrace: true,
      }).trace as { letter?: string }[]
    )
      .map((t) => t.letter)
      .join("");
  assert.equal(letters(0), letters(9));
  assert.deepEqual(makeEnvironment(101, 3), e);
});

test("Math.random is seeded during a match and restored after", () => {
  const real = Math.random;
  const draws: number[][] = [[], []];
  for (const k of [0, 1]) {
    playMatch({
      seats: [ext(() => (draws[k]!.push(Math.random()), 0)), ext(() => 0)],
      auctionType: "Vickrey",
      env: env(["AA", "AA"], "QQ"),
      dictionary: small,
      startingRack: 2,
      policySeed: 7,
    });
  }
  assert.deepEqual(draws[0], draws[1]);
  assert.equal(Math.random, real);
});
