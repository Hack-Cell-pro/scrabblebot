// Offline tests for summary reconciliation and decision tracing. Fake
// state, reducers and timers only; nothing connects to SpacetimeDB. Run:
//   node --import tsx --test src/client/diagnostics.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ClientScheduler,
  type AuctionResultRow,
  type AuctionView,
  type ClientState,
  type MatchView,
  type SchedulerOptions,
} from "./scheduler.js";

const flush = () => new Promise<void>((r) => setImmediate(r));
const ME = 213n;
const RIVAL = 9n;

class FakeTimers {
  t = 1_000_000;
  private seq = 0;
  private q = new Map<number, { at: number; fn: () => void }>();
  now = () => this.t;
  setTimeout = (fn: () => void, ms: number) => {
    const id = ++this.seq;
    this.q.set(id, { at: this.t + ms, fn });
    return id;
  };
  clearTimeout = (h: unknown) => void this.q.delete(h as number);
  async advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      const due = [...this.q].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
      if (!due.length) break;
      const [id, v] = due[0]!;
      this.q.delete(id);
      this.t = v.at;
      v.fn();
      await flush();
    }
    this.t = end;
    await flush();
  }
}

/** Fake state with an SDK-like cache: rows exist before their callbacks run. */
class CacheState implements ClientState {
  matches = new Map<bigint, MatchView>();
  people = new Map<string, { balance: number; score: number }>();
  racks = new Map<bigint, Map<string, number>>();
  auctions = new Map<bigint, AuctionView>();
  results = new Map<bigint, AuctionResultRow>();
  addMatch(id: bigint, auctionsFrom = 1n, n = 68) {
    this.matches.set(id, { status: "Running", bagTotal: 40, auctionType: "Vickrey", players: 6, auctionDurationMs: 1000, startingRackSize: 5 });
    this.people.set(`${id}:${ME}`, { balance: 100, score: 0 });
    this.people.set(`${id}:${RIVAL}`, { balance: 100, score: 0 });
    this.racks.set(id, new Map());
    for (let i = 0n; i < BigInt(n); i++) {
      const aid = auctionsFrom + i;
      this.auctions.set(aid, { id: aid, matchId: id, letter: "E", status: "Closed", closesAtMs: 0 });
    }
  }
  /** One result row per auction; we win every `everyNth`, paying `paid`. */
  result(matchId: bigint, auctionId: bigint, mine: boolean, paid: number): AuctionResultRow {
    return { auctionId, matchId, winnerBotId: mine ? ME : RIVAL, paid, letter: "E" };
  }
  match = (id: bigint) => {
    const m = this.matches.get(id);
    return m ? { ...m } : undefined;
  };
  participant = (m: bigint, b: bigint) => this.people.get(`${m}:${b}`);
  rack = (m: bigint) => new Map(this.racks.get(m) ?? []);
  auction = (id: bigint) => this.auctions.get(id);
  openAuctions = () => [...this.auctions.values()].filter((a) => a.status === "Open");
  myMatchIds = () => [...this.matches.keys()];
  inOpenLobby = () => false;
  scores = (m: bigint) =>
    [...this.people].filter(([k]) => k.startsWith(`${m}:`)).map(([k, v]) => ({ botId: BigInt(k.split(":")[1]!), score: v.score }));
  auctionResults = (m: bigint) => [...this.results.values()].filter((r) => r.matchId === m);
  auctionIds = (m: bigint) => [...this.auctions.values()].filter((a) => a.matchId === m).map((a) => a.id);
}

class FakeReducers {
  calls: { kind: string; args: string[]; at: number }[] = [];
  failures = new Map<string, string[]>();
  constructor(private timers: FakeTimers) {}
  private call(kind: string, ...args: unknown[]) {
    this.calls.push({ kind, args: args.map(String), at: this.timers.t });
    const fail = this.failures.get(kind)?.shift();
    return fail ? Promise.reject(new Error(fail)) : Promise.resolve();
  }
  of = (kind: string) => this.calls.filter((c) => c.kind === kind);
  submitBid = (a: bigint, n: bigint) => this.call("bid", a, n);
  submitWord = (m: bigint, w: string) => this.call("word", m, w);
  joinLobby = () => this.call("join");
  registerForTournament = (id: bigint) => this.call("tournament", id);
}

function setup(over: Partial<SchedulerOptions> = {}) {
  const timers = new FakeTimers();
  const state = new CacheState();
  const reducers = new FakeReducers(timers);
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const finalized: bigint[] = [];
  const sched = new ClientScheduler({
    strategy: { decideBid: () => 5, chooseWord: () => null },
    state,
    reducers,
    timers,
    dictionary: ["CAT"],
    log: (event, data) => events.push({ event, data }),
    perfNow: () => 0,
    onMatchFinalized: (m) => finalized.push(m),
    ...over,
  });
  sched.setBotId(ME);
  const summaries = () => events.filter((e) => e.event === "match_summary").map((e) => e.data as unknown as Summary);
  return { timers, state, reducers, events, sched, finalized, summaries };
}

interface Summary {
  matchId: bigint;
  observed: {
    tilesBoughtFromResults: number;
    spentFromResults: number;
    auctionResultsSeen: number;
    results: {
      completeness: string;
      observed: number;
      expectedFromAuctionRows: number | null;
      expectedFromBag: number | null;
      missingCount: number;
      viaCallback: number;
      viaCacheSnapshot: number;
      stoppedBy: string | null;
    };
  };
  inferred: { spentFromBalance: number | null };
}

/** 68 auctions; we win auctions 1, 11, 21, ... 61 (7 tiles) and the last, 68. */
function fullMatch(f: ReturnType<typeof setup>, id = 1n, from = 1n) {
  f.state.addMatch(id, from);
  const rows: AuctionResultRow[] = [];
  for (let i = 0n; i < 68n; i++) {
    const mine = i % 10n === 0n || i === 67n;
    rows.push(f.state.result(id, from + i, mine, mine ? 10 + Number(i % 3n) : 4));
  }
  return rows;
}

test("match end processed before the final result callback still counts the final result", async () => {
  const f = setup();
  const rows = fullMatch(f);
  f.sched.onMatchSeen(1n);
  // Callbacks for the first 67 results fire during the match.
  for (const r of rows.slice(0, 67)) {
    f.state.results.set(r.auctionId, r);
    f.sched.onAuctionResult(r);
  }
  // The final transaction: the SDK caches result 68 and the Ended state,
  // then runs the match-state callback before the result callback.
  f.state.results.set(rows[67]!.auctionId, rows[67]!);
  f.state.matches.get(1n)!.status = "Ended";
  f.state.people.set(`1:${ME}`, { balance: 100 - 87 + 40, score: 40 });
  assert.equal(f.sched.onMatchEnded(1n), true);
  f.sched.onAuctionResult(rows[67]!); // the late callback

  const s = f.summaries();
  assert.equal(s.length, 1, "one summary");
  const mine = rows.filter((r) => r.winnerBotId === ME);
  assert.equal(s[0]!.observed.tilesBoughtFromResults, mine.length);
  assert.equal(s[0]!.observed.spentFromResults, mine.reduce((a, r) => a + r.paid, 0));
  assert.equal(s[0]!.observed.results.completeness, "complete");
  assert.equal(s[0]!.observed.results.observed, 68);
  assert.equal(s[0]!.observed.results.viaCallback, 67);
  assert.equal(s[0]!.observed.results.viaCacheSnapshot, 1);
  assert.equal(f.events.filter((e) => e.event === "late_auction_result").length, 0);
  assert.deepEqual(f.finalized, [1n]);
});

test("reconciliation is idempotent across callbacks and snapshots", async () => {
  const f = setup();
  const rows = fullMatch(f);
  for (const r of rows) f.state.results.set(r.auctionId, r);
  for (const r of [...rows, ...rows.slice(0, 20)]) f.sched.onAuctionResult(r); // duplicates
  f.state.matches.get(1n)!.status = "Ended";
  f.sched.onMatchEnded(1n);
  f.sched.onMatchEnded(1n); // a repeated end event
  for (const r of rows) f.sched.onAuctionResult(r);
  const s = f.summaries();
  assert.equal(s.length, 1);
  const mine = rows.filter((r) => r.winnerBotId === ME);
  assert.equal(s[0]!.observed.tilesBoughtFromResults, mine.length);
  assert.equal(s[0]!.observed.spentFromResults, mine.reduce((a, r) => a + r.paid, 0));
  assert.equal(s[0]!.observed.results.viaCallback, 68);
  assert.equal(s[0]!.observed.results.viaCacheSnapshot, 0);
});

test("a genuinely incomplete result set is labelled incomplete after the bounded wait", async () => {
  const f = setup();
  const rows = fullMatch(f);
  for (const r of rows.slice(0, 66)) f.state.results.set(r.auctionId, r);
  f.state.matches.get(1n)!.status = "Ended";
  f.state.people.set(`1:${ME}`, { balance: 20, score: 50 });
  f.sched.onMatchEnded(1n);
  assert.equal(f.summaries().length, 0, "waits for missing results");
  assert.deepEqual(f.finalized, []);
  await f.timers.advance(1999);
  assert.equal(f.summaries().length, 0);
  await f.timers.advance(1);
  const s = f.summaries();
  assert.equal(s.length, 1);
  const r = s[0]!.observed.results;
  assert.deepEqual(
    [r.completeness, r.observed, r.expectedFromAuctionRows, r.expectedFromBag, r.missingCount, r.stoppedBy],
    ["incomplete", 66, 68, 68, 2, "wait limit"],
  );
  // Observed spending stays the results-only figure; balance-derived is separate.
  const seen = rows.slice(0, 66).filter((x) => x.winnerBotId === ME);
  assert.equal(s[0]!.observed.spentFromResults, seen.reduce((a, x) => a + x.paid, 0));
  assert.equal(s[0]!.inferred.spentFromBalance, 130);
  assert.deepEqual(f.finalized, [1n]);
});

test("a result that lands in the cache during the wait completes the summary early", async () => {
  const f = setup();
  const rows = fullMatch(f);
  for (const r of rows.slice(0, 67)) f.state.results.set(r.auctionId, r);
  f.state.matches.get(1n)!.status = "Ended";
  f.sched.onMatchEnded(1n);
  await f.timers.advance(250);
  f.state.results.set(rows[67]!.auctionId, rows[67]!);
  await f.timers.advance(100);
  const s = f.summaries();
  assert.equal(s.length, 1);
  assert.equal(s[0]!.observed.results.completeness, "complete");
  assert.ok(f.timers.t - 1_000_000 < 2000);
});

test("three-match shutdown waits for the last summary and never joins a fourth lobby", async () => {
  let finished = 0;
  const f = setup({ maxMatches: 3, onFinished: () => finished++ });
  f.sched.start();
  for (const [i, id] of [1n, 2n, 3n].entries()) {
    const from = BigInt(1 + i * 100);
    const rows = fullMatch(f, id, from);
    const cached = id === 3n ? rows.slice(0, 67) : rows;
    for (const r of cached) f.state.results.set(r.auctionId, r);
    f.state.matches.get(id)!.status = "Ended";
    f.sched.onMatchEnded(id);
    if (id === 3n) {
      assert.equal(f.sched.isFinished, true, "no more gameplay after the third");
      assert.equal(finished, 0, "but shutdown waits for the summary");
      await f.timers.advance(300);
      f.state.results.set(rows[67]!.auctionId, rows[67]!);
      f.sched.onAuctionResult(rows[67]!);
    }
  }
  await flush();
  assert.equal(finished, 1);
  assert.equal(f.summaries().length, 3);
  assert.ok(f.summaries().every((s) => s.observed.results.completeness === "complete"));
  assert.equal(f.reducers.of("join").length, 3, "start + after matches 1 and 2");
  const order = f.events.map((e) => e.event).filter((e) => e === "match_summary" || e === "trial_complete");
  assert.deepEqual(order, ["match_summary", "match_summary", "match_summary", "trial_complete"]);
  f.state.addMatch(4n, 1000n);
  f.state.matches.get(4n)!.status = "Ended";
  assert.equal(f.sched.onMatchEnded(4n), false);
  f.sched.joinLobby();
  await f.timers.advance(5000);
  assert.equal(f.reducers.of("join").length, 3);
  assert.equal(finished, 1);
});

test("a shutdown during the wait emits the pending summary, labelled", async () => {
  let finished = 0;
  const f = setup({ maxMatches: 1, onFinished: () => finished++ });
  const rows = fullMatch(f);
  for (const r of rows.slice(0, 60)) f.state.results.set(r.auctionId, r);
  f.state.matches.get(1n)!.status = "Ended";
  f.sched.onMatchEnded(1n);
  f.sched.shutdown("SIGINT");
  const s = f.summaries();
  assert.equal(s.length, 1);
  assert.equal(s[0]!.observed.results.completeness, "incomplete");
  assert.equal(s[0]!.observed.results.stoppedBy, "shutdown: SIGINT");
  assert.equal(finished, 1);
});

test("without a cache snapshot, completeness is reported as unverifiable", () => {
  const f = setup();
  fullMatch(f);
  (f.state as Partial<CacheState>).auctionResults = undefined;
  f.state.matches.get(1n)!.status = "Ended";
  f.sched.onMatchEnded(1n);
  assert.equal(f.summaries()[0]!.observed.results.completeness, "unverifiable");
});

// ---------- tracing ----------

test("traced decision snapshots are taken before the strategy runs and stay frozen", async () => {
  const f = setup({
    trace: true,
    traceParams: { K: 2, PACE: 3 },
    strategy: {
      decideBid: (ctx) => {
        ctx.myRack.set("Z", 9); // a misbehaving strategy mutates its input
        ctx.myRack.delete("A");
        return 7;
      },
      chooseWord: (ctx) => {
        ctx.myRack.clear();
        return "CAT";
      },
    },
  });
  f.state.addMatch(1n, 1n, 0);
  f.state.racks.set(1n, new Map([["A", 2], ["C", 1], ["T", 1]]));
  f.state.people.set(`1:${ME}`, { balance: 60, score: 12 });
  f.state.auctions.set(500n, { id: 500n, matchId: 1n, letter: "Q", status: "Open", closesAtMs: f.timers.t + 900 });
  f.sched.requestBid(500n, "auction-open");
  f.sched.requestWord(1n, "rack");
  await flush();
  const bid = f.events.find((e) => e.event === "trace_bid_decision")!.data;
  const word = f.events.find((e) => e.event === "trace_word_decision")!.data;
  assert.deepEqual(bid.rack, { A: 2, C: 1, T: 1 });
  assert.deepEqual(word.rack, { A: 2, C: 1, T: 1 });
  assert.ok(Object.isFrozen(bid.rack) && Object.isFrozen(word.rack));
  assert.throws(() => ((bid.rack as Record<string, number>).A = 0));
  f.state.racks.set(1n, new Map([["X", 1]]));
  assert.deepEqual(bid.rack, { A: 2, C: 1, T: 1 }, "later state changes don't reach the record");
  assert.deepEqual(
    [bid.letter, bid.balance, bid.score, bid.output, bid.closesAtMs, bid.msBeforeClose, bid.players, bid.bagTotal, bid.auctionType],
    ["Q", 60, 12, 7, f.timers.t + 900, 900, 6, 40, "Vickrey"],
  );
  assert.deepEqual(bid.params, { K: 2, PACE: 3 });
  // Submission, acknowledgement and result share the decision's sequence id.
  const seq = bid.seq;
  assert.equal(f.events.find((e) => e.event === "trace_bid_submit")!.data.seq, seq);
  assert.equal(f.events.find((e) => e.event === "trace_bid_ack")!.data.seq, seq);
  f.sched.onAuctionResult({ auctionId: 500n, matchId: 1n, winnerBotId: ME, paid: 4, letter: "Q" });
  const res = f.events.find((e) => e.event === "trace_auction_result")!.data;
  assert.deepEqual([res.seq, res.won, res.paid, res.ourSubmittedBid], [seq, true, 4, 7]);
  assert.equal(f.events.find((e) => e.event === "trace_word_submit")!.data.seq, word.seq);
  assert.equal(word.output, "CAT");
});

test("tracing changes no strategy output, reducer call or concise telemetry", async () => {
  const run = async (trace: boolean) => {
    const outputs: unknown[] = [];
    let n = 0;
    const f = setup({
      trace,
      maxMatches: 2,
      strategy: {
        decideBid: (ctx) => {
          const v = (ctx.myBalance + ctx.letter.charCodeAt(0) + (ctx.bagTotal ?? 0)) % 9;
          outputs.push(["bid", ctx.letter, ctx.myBalance, [...ctx.myRack], v]);
          return v;
        },
        chooseWord: (ctx) => {
          const w = ctx.myRack.get("T") ? "CAT" : null;
          outputs.push(["word", [...ctx.myRack], w]);
          return w;
        },
      },
    });
    f.reducers.failures.set("bid", ["timeout", "Auction window expired"]);
    f.reducers.failures.set("word", ["'CAT' is not in the dictionary"]);
    f.sched.start();
    for (const id of [1n, 2n]) {
      const from = id * 1000n;
      f.state.addMatch(id, from, 4);
      f.state.racks.set(id, new Map([["C", 1], ["A", 1]]));
      f.sched.onMatchSeen(id);
      for (let i = 0n; i < 4n; i++) {
        const aid = from + i;
        f.state.auctions.set(aid, { id: aid, matchId: id, letter: "QETA"[Number(i)]!, status: "Open", closesAtMs: f.timers.t + 1000 });
        f.sched.requestBid(aid, "auction-open");
        f.sched.requestWord(id, "bag");
        await f.timers.advance(300);
        if (i === 1n) f.state.racks.set(id, new Map([["C", 1], ["A", 1], ["T", 1]]));
        f.sched.requestWord(id, "rack");
        await f.timers.advance(700);
        f.state.auctions.get(aid)!.status = "Closed";
        const row = f.state.result(id, aid, i % 2n === 0n, 3);
        f.state.results.set(aid, row);
        f.sched.onAuctionResult(row);
        n++;
      }
      f.state.matches.get(id)!.status = "Ended";
      f.sched.onMatchEnded(id);
      await f.timers.advance(3000);
    }
    const concise = f.events
      .filter((e) => !e.event.startsWith("trace_"))
      .map((e) => {
        const { seq: _s, ...rest } = e.data;
        return [e.event, rest];
      });
    return { outputs, calls: f.reducers.calls, concise, traced: f.events.filter((e) => e.event.startsWith("trace_")).length, n };
  };
  const off = await run(false);
  const on = await run(true);
  assert.equal(off.traced, 0, "tracing off logs no trace records");
  assert.ok(on.traced > 0);
  assert.deepEqual(on.outputs, off.outputs);
  assert.deepEqual(on.calls, off.calls);
  assert.deepEqual(on.concise, off.concise);
  assert.ok(off.calls.some((c) => c.kind === "bid") && off.calls.some((c) => c.kind === "word"));
});
