// Offline tests for the live client's scheduler: fake state, fake reducers,
// fake timers. Nothing here touches SpacetimeDB. Run with:
//   node --import tsx --test src/client/scheduler.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ClientScheduler,
  type AuctionView,
  type ClientState,
  type MatchView,
  type SchedulerOptions,
} from "./scheduler.js";

// ---------- fakes ----------

class FakeTimers {
  t = 0;
  private seq = 0;
  private q = new Map<number, { at: number; fn: () => void }>();
  now = () => this.t;
  setTimeout = (fn: () => void, ms: number) => {
    const id = ++this.seq;
    this.q.set(id, { at: this.t + ms, fn });
    return id;
  };
  clearTimeout = (h: unknown) => {
    this.q.delete(h as number);
  };
  get pending() {
    return this.q.size;
  }
  /** Moves the clock forward, firing due timers in order. */
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

const flush = () => new Promise<void>((r) => setImmediate(r));

const ME = 213n;
const M1 = 1n;

class FakeState implements ClientState {
  matches = new Map<bigint, MatchView>();
  people = new Map<string, { balance: number; score: number }>();
  racks = new Map<bigint, Map<string, number>>();
  auctions = new Map<bigint, AuctionView>();
  lobby = false;
  addMatch(id: bigint, status = "Running") {
    this.matches.set(id, { status, bagTotal: 40, auctionType: "Vickrey", players: 6, auctionDurationMs: 1000, startingRackSize: 5 });
    this.people.set(`${id}:${ME}`, { balance: 100, score: 0 });
    this.people.set(`${id}:9`, { balance: 100, score: 0 });
    this.racks.set(id, new Map());
  }
  setRack(id: bigint, letters: string) {
    const r = new Map<string, number>();
    for (const c of letters) r.set(c, (r.get(c) ?? 0) + 1);
    this.racks.set(id, r);
  }
  end(id: bigint) {
    this.matches.get(id)!.status = "Ended";
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
  inOpenLobby = () => this.lobby;
  scores = (m: bigint) =>
    [...this.people].filter(([k]) => k.startsWith(`${m}:`)).map(([k, v]) => ({ botId: BigInt(k.split(":")[1]!), score: v.score }));
}

interface Deferred {
  resolve: () => void;
  reject: (e: Error) => void;
}

class FakeReducers {
  calls: { kind: string; args: unknown[]; at: number }[] = [];
  inFlight = 0;
  maxInFlight = 0;
  /** If set, the next calls of a kind wait for the test to settle them. */
  manual = new Set<string>();
  /** Errors to reject with, in order, per kind. */
  failures = new Map<string, string[]>();
  waiting: Deferred[] = [];
  constructor(private timers: FakeTimers) {}
  private call(kind: string, ...args: unknown[]) {
    this.calls.push({ kind, args, at: this.timers.t });
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    return new Promise<void>((resolve, reject) => {
      const done = () => this.inFlight--;
      const d: Deferred = {
        resolve: () => (done(), resolve()),
        reject: (e) => (done(), reject(e)),
      };
      const fail = this.failures.get(kind)?.shift();
      if (fail) d.reject(new Error(fail));
      else if (this.manual.has(kind)) this.waiting.push(d);
      else d.resolve();
    });
  }
  of(kind: string) {
    return this.calls.filter((c) => c.kind === kind);
  }
  submitBid = (a: bigint, amount: bigint) => this.call("bid", a, amount);
  submitWord = (m: bigint, w: string) => this.call("word", m, w);
  joinLobby = () => this.call("join");
  registerForTournament = (id: bigint) => this.call("tournament", id);
}

function setup(over: Partial<SchedulerOptions> = {}, botId: bigint | null = ME) {
  const timers = new FakeTimers();
  const state = new FakeState();
  const reducers = new FakeReducers(timers);
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const seen = { bids: [] as Record<string, unknown>[], words: [] as Map<string, number>[] };
  let bid: (ctx: Record<string, unknown>) => number = () => 5;
  let word: (rack: Map<string, number>) => string | null = () => null;
  const sched = new ClientScheduler({
    strategy: {
      decideBid: (ctx) => (seen.bids.push(ctx as unknown as Record<string, unknown>), bid(ctx as unknown as Record<string, unknown>)),
      chooseWord: (ctx) => (seen.words.push(new Map(ctx.myRack)), word(ctx.myRack)),
    },
    state,
    reducers,
    timers,
    dictionary: ["CAT", "AT"],
    log: (event, data) => events.push({ event, data }),
    perfNow: () => 0,
    ...over,
  });
  sched.setBotId(botId);
  return {
    timers,
    state,
    reducers,
    events,
    seen,
    sched,
    setBid: (f: typeof bid) => (bid = f),
    setWord: (f: typeof word) => (word = f),
  };
}

const cat = (r: Map<string, number>) => (r.get("C") && r.get("A") && r.get("T") ? "CAT" : null);

// ---------- words ----------

test("a null word decision does not swallow a playable rack event inside the throttle", async () => {
  const f = setup();
  f.state.addMatch(M1);
  f.setWord(cat);
  f.state.setRack(M1, "CA");
  f.sched.requestWord(M1, "rack");
  assert.equal(f.reducers.of("word").length, 0, "nothing to play yet");
  await f.timers.advance(100);
  f.state.setRack(M1, "CAT");
  f.sched.requestWord(M1, "rack");
  await flush();
  const w = f.reducers.of("word");
  assert.equal(w.length, 1);
  assert.deepEqual([w[0]!.at, w[0]!.args[1]], [100, "CAT"]);
});

test("a rack event during the throttle after a submission gets a trailing retry", async () => {
  const f = setup();
  f.state.addMatch(M1);
  f.setWord(cat);
  f.state.setRack(M1, "CAT");
  f.sched.requestWord(M1);
  await flush();
  f.state.setRack(M1, ""); // the server applied the word
  await f.timers.advance(100);
  f.state.setRack(M1, "TAC");
  f.sched.requestWord(M1, "rack");
  assert.equal(f.reducers.of("word").length, 1, "still inside the 500 ms throttle");
  await f.timers.advance(400);
  const w = f.reducers.of("word");
  assert.equal(w.length, 2);
  assert.equal(w[1]!.at, 500, "runs when the throttle expires");
  assert.deepEqual(f.seen.words.at(-1), new Map([["T", 1], ["A", 1], ["C", 1]]), "reads the rack at execution");
});

test("several events inside the throttle coalesce into one retry", async () => {
  const f = setup();
  f.state.addMatch(M1);
  f.setWord(cat);
  f.state.setRack(M1, "CAT");
  f.sched.requestWord(M1);
  await flush();
  f.state.setRack(M1, "");
  const decisionsBefore = f.seen.words.length;
  for (const at of [100, 200, 300, 400]) {
    await f.timers.advance(at - f.timers.t);
    f.state.setRack(M1, at === 400 ? "CAT" : "CA");
    f.sched.requestWord(M1, "rack");
  }
  assert.equal(f.timers.pending, 1, "one pending retry per match");
  await f.timers.advance(100);
  assert.equal(f.seen.words.length - decisionsBefore, 1, "one decision for four events");
  assert.equal(f.reducers.of("word").length, 2);
});

test("a slow word submission never has a second one in flight", async () => {
  const f = setup();
  f.state.addMatch(M1);
  f.setWord(cat);
  f.reducers.manual.add("word");
  f.state.setRack(M1, "CATCAT");
  f.sched.requestWord(M1);
  for (let i = 0; i < 20; i++) {
    await f.timers.advance(100);
    f.sched.requestWord(M1, "rack");
  }
  assert.equal(f.reducers.of("word").length, 1, "2 s of events, one call");
  // The server applied the word; then the reply arrives.
  f.state.setRack(M1, "CAT");
  f.reducers.waiting.shift()!.resolve();
  await flush();
  assert.equal(f.reducers.of("word").length, 2, "fresh state processed after it settles");
  assert.deepEqual(f.seen.words.at(-1), new Map([["C", 1], ["A", 1], ["T", 1]]));
  assert.equal(f.reducers.maxInFlight, 1);
});

test("a refused word is not retried in a loop", async () => {
  const f = setup();
  f.state.addMatch(M1);
  f.setWord(cat);
  f.state.setRack(M1, "CAT");
  f.reducers.failures.set("word", ["'CAT' is not in the dictionary"]);
  f.sched.requestWord(M1);
  await f.timers.advance(5000);
  assert.equal(f.reducers.of("word").length, 1);
  assert.equal(f.events.filter((e) => e.event === "word_failed").length, 1);
});

// ---------- bids ----------

function openAuction(f: ReturnType<typeof setup>, id = 10n, closesAtMs = 1000) {
  f.state.auctions.set(id, { id, matchId: M1, letter: "Q", status: "Open", closesAtMs });
}

test("a failed bid is retried before the deadline with a fresh decision", async () => {
  const f = setup();
  f.state.addMatch(M1);
  openAuction(f);
  f.setBid((ctx) => Math.min(7, ctx.myBalance as number));
  f.reducers.failures.set("bid", ["connection reset"]);
  f.sched.requestBid(10n);
  await flush();
  f.state.people.set(`${M1}:${ME}`, { balance: 4, score: 0 }); // balance changed meanwhile
  await f.timers.advance(50);
  const b = f.reducers.of("bid");
  assert.equal(b.length, 2);
  assert.deepEqual(b.map((c) => c.args[1]), [7n, 4n], "recomputed from the current balance");
  assert.equal(f.seen.bids.length, 2);
  await f.timers.advance(2000);
  assert.equal(f.reducers.of("bid").length, 2, "no more attempts after success");
});

test("bid attempts are bounded", async () => {
  const f = setup();
  f.state.addMatch(M1);
  openAuction(f);
  f.reducers.failures.set("bid", ["timeout", "timeout", "timeout"]);
  f.sched.requestBid(10n);
  await f.timers.advance(500);
  f.sched.requestBid(10n);
  await f.timers.advance(400);
  assert.equal(f.reducers.of("bid").length, 2);
});

test("a successful bid is not submitted again", async () => {
  const f = setup();
  f.state.addMatch(M1);
  openAuction(f);
  f.sched.requestBid(10n);
  await flush();
  for (let i = 0; i < 5; i++) f.sched.requestBid(10n, "event");
  await f.timers.advance(500);
  assert.equal(f.reducers.of("bid").length, 1);
});

test("one bid in flight per auction", async () => {
  const f = setup();
  f.state.addMatch(M1);
  openAuction(f);
  f.reducers.manual.add("bid");
  f.sched.requestBid(10n);
  f.sched.requestBid(10n);
  f.sched.start();
  assert.equal(f.reducers.of("bid").length, 1);
});

test("closed or expired auctions and terminal errors stop retries", async () => {
  // Closed before the retry fires.
  let f = setup();
  f.state.addMatch(M1);
  openAuction(f);
  f.reducers.failures.set("bid", ["timeout"]);
  f.sched.requestBid(10n);
  await flush();
  f.state.auctions.get(10n)!.status = "Closed";
  f.sched.onAuctionClosed(10n);
  await f.timers.advance(500);
  assert.equal(f.reducers.of("bid").length, 1);

  // Too close to the deadline for a retry.
  f = setup();
  f.state.addMatch(M1);
  openAuction(f, 10n, 120);
  f.reducers.failures.set("bid", ["timeout"]);
  f.sched.requestBid(10n);
  await f.timers.advance(500);
  assert.equal(f.reducers.of("bid").length, 1);

  // Already expired: no first attempt either.
  f = setup();
  f.state.addMatch(M1);
  openAuction(f, 10n, 0);
  f.sched.requestBid(10n);
  assert.equal(f.reducers.of("bid").length, 0);

  // A terminal validation error.
  f = setup();
  f.state.addMatch(M1);
  openAuction(f);
  f.reducers.failures.set("bid", ["Auction window expired"]);
  f.sched.requestBid(10n);
  await f.timers.advance(500);
  f.sched.requestBid(10n);
  assert.equal(f.reducers.of("bid").length, 1);
  assert.equal(f.events.find((e) => e.event === "bid_failed")!.data.terminal, true);
});

test("invalid strategy outputs are logged and not submitted", async () => {
  for (const out of [2.5, NaN, -1, Infinity, 101]) {
    const f = setup();
    f.state.addMatch(M1);
    openAuction(f);
    f.setBid(() => out);
    f.sched.requestBid(10n);
    await flush();
    assert.equal(f.reducers.of("bid").length, 0, String(out));
    assert.equal(f.events.filter((e) => e.event === "invalid_bid_output").length, 1);
  }
  const f = setup();
  f.state.addMatch(M1);
  f.setWord(() => "C4T");
  f.sched.requestWord(M1);
  assert.equal(f.reducers.of("word").length, 0);
  assert.equal(f.events.filter((e) => e.event === "invalid_word_output").length, 1);
});

test("an ended match or closed connection cancels pending work", async () => {
  let f = setup();
  f.state.addMatch(M1);
  f.setWord(cat);
  f.state.setRack(M1, "CAT");
  f.sched.requestWord(M1);
  await flush();
  f.sched.requestWord(M1, "rack");
  assert.equal(f.timers.pending, 1);
  f.state.end(M1);
  f.sched.onMatchEnded(M1);
  assert.equal(f.timers.pending, 0);
  await f.timers.advance(1000);
  assert.equal(f.reducers.of("word").length, 1);

  f = setup();
  f.state.addMatch(M1);
  f.setWord(cat);
  f.state.setRack(M1, "CAT");
  f.sched.requestWord(M1);
  await flush();
  f.sched.requestWord(M1, "rack");
  f.sched.shutdown("disconnected");
  assert.equal(f.timers.pending, 0);
  await f.timers.advance(1000);
  f.sched.requestWord(M1);
  openAuction(f);
  f.sched.requestBid(10n);
  assert.equal(f.reducers.of("word").length, 1);
  assert.equal(f.reducers.of("bid").length, 0);
});

// ---------- identity and bounded trials ----------

test("a wrong bot identity makes no gameplay calls at all", async () => {
  const f = setup({ expectedBotId: 213n, tournamentId: 5n }, 7n);
  f.state.addMatch(M1);
  openAuction(f);
  f.setWord(cat);
  f.state.setRack(M1, "CAT");
  f.sched.start();
  f.sched.joinLobby();
  f.sched.requestBid(10n);
  f.sched.requestWord(M1);
  f.state.end(M1);
  f.sched.onMatchEnded(M1);
  await f.timers.advance(2000);
  assert.equal(f.reducers.calls.length, 0);
  assert.equal(f.seen.bids.length + f.seen.words.length, 0, "the strategy is not even consulted");
  assert.equal(f.sched.identityMismatch, true);
  assert.equal(f.events.filter((e) => e.event === "identity_mismatch").length, 1);

  const ok = setup({ expectedBotId: 213n }, 213n);
  ok.sched.start();
  assert.equal(ok.reducers.of("join").length, 1, "the right identity acts");
});

test("an unresolved identity makes no gameplay calls", async () => {
  const f = setup({}, null);
  f.state.addMatch(M1);
  openAuction(f);
  f.sched.start();
  f.sched.requestBid(10n);
  assert.equal(f.reducers.calls.length, 0);
});

test("three completed matches: no fourth lobby join, finished once", async () => {
  let finished = 0;
  const f = setup({ maxMatches: 3, onFinished: () => finished++ });
  f.sched.start();
  for (const id of [1n, 2n, 3n]) {
    f.state.addMatch(id);
    f.sched.onMatchSeen(id);
    f.state.end(id);
    f.sched.onMatchEnded(id);
    f.sched.onMatchEnded(id); // a repeated end event counts once
  }
  await flush();
  assert.equal(f.sched.completedMatches, 3);
  assert.equal(f.reducers.of("join").length, 3, "start + after matches 1 and 2");
  assert.equal(finished, 1);
  assert.equal(f.sched.isFinished, true);
  f.state.addMatch(4n);
  f.state.end(4n);
  f.sched.onMatchEnded(4n);
  f.sched.joinLobby();
  assert.equal(f.reducers.of("join").length, 3);
  assert.equal(f.events.filter((e) => e.event === "match_summary").length, 3);
  assert.equal(f.events.filter((e) => e.event === "trial_complete").length, 1);
});

test("without the trial options the bot rejoins after every match", async () => {
  const f = setup();
  f.sched.start();
  for (const id of [1n, 2n, 3n, 4n]) {
    f.state.addMatch(id);
    f.state.end(id);
    f.sched.onMatchEnded(id);
  }
  assert.equal(f.reducers.of("join").length, 5);
  assert.equal(f.reducers.of("tournament").length, 0, "no tournament unless TOURNAMENT_ID is set");
});

test("match telemetry: observed spending from results, inferred spending from balance", async () => {
  const f = setup({ letterValue: (l) => ({ Q: 10, A: 1 })[l] ?? 0 });
  f.state.addMatch(M1);
  f.sched.onMatchSeen(M1);
  f.sched.onAuctionResult({ auctionId: 1n, matchId: M1, winnerBotId: ME, paid: 12 });
  f.sched.onAuctionResult({ auctionId: 1n, matchId: M1, winnerBotId: ME, paid: 12 }); // duplicate row
  f.sched.onAuctionResult({ auctionId: 2n, matchId: M1, winnerBotId: 9n, paid: 3 });
  f.sched.onAuctionResult({ auctionId: 3n, matchId: M1, winnerBotId: undefined, paid: 0 });
  f.state.people.set(`${M1}:${ME}`, { balance: 118, score: 30 });
  f.state.people.set(`${M1}:9`, { balance: 90, score: 30 });
  f.state.setRack(M1, "QA");
  f.state.end(M1);
  f.sched.onMatchEnded(M1);
  const start = f.events.find((e) => e.event === "match_start")!.data;
  assert.deepEqual([start.players, start.auctionType, start.auctionDurationMs], [6, "Vickrey", 1000]);
  const s = f.events.find((e) => e.event === "match_summary")!.data as {
    observed: Record<string, unknown>;
    inferred: Record<string, unknown>;
  };
  assert.equal(s.observed.tilesBoughtFromResults, 1);
  assert.equal(s.observed.spentFromResults, 12);
  assert.equal(s.observed.auctionResultsSeen, 3);
  assert.equal(s.observed.finalScore, 30);
  assert.equal(s.observed.endingBalance, 118);
  assert.equal(s.observed.placement, 1);
  assert.equal(s.observed.sharedTopScore, true);
  assert.equal(s.observed.unplayedTiles, 2);
  assert.equal(s.observed.unplayedFaceValue, 11);
  assert.equal(s.inferred.spentFromBalance, 12);
});
