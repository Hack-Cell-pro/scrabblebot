// Decides when the live client bids, plays words and rejoins the lobby.
//
// Everything outside this file is injected: the strategy, a read-only view
// of the subscribed state, the reducer calls, the clock and timers, and a
// logger. Importing this module opens no connection and starts nothing, so
// it can be tested offline with fakes (see scheduler.test.ts).

import type { BidContext, WordContext } from "../strategy.js";

export interface MatchView {
  status: string; // "Running" | "Ended" | ...
  bagTotal: number;
  auctionType: string;
  players: number;
  auctionDurationMs: number;
  startingRackSize: number;
}

export interface AuctionView {
  id: bigint;
  matchId: bigint;
  letter: string;
  status: string; // "Open" | "Closed"
  /** Server close time, in ms since the epoch. */
  closesAtMs: number;
}

/** Read-only view of the client's subscribed rows. Read fresh on each call. */
export interface ClientState {
  match(matchId: bigint): MatchView | undefined;
  participant(matchId: bigint, botId: bigint): { balance: number; score: number } | undefined;
  rack(matchId: bigint): Map<string, number>;
  auction(auctionId: bigint): AuctionView | undefined;
  openAuctions(): AuctionView[];
  /** Matches this bot is a participant in, any status. */
  myMatchIds(botId: bigint): bigint[];
  inOpenLobby(botId: bigint): boolean;
  scores(matchId: bigint): { botId: bigint; score: number }[];
  /**
   * The cached auction_result rows for a match. The SDK applies a whole
   * transaction to the cache before running any row callback, so this can
   * hold rows whose insert callback has not fired yet. Optional: without
   * it, result completeness is reported as unverifiable.
   */
  auctionResults?(matchId: bigint): AuctionResultRow[];
  /** Ids of every cached auction row of a match (open or closed). */
  auctionIds?(matchId: bigint): bigint[];
}

export interface AuctionResultRow {
  auctionId: bigint;
  matchId: bigint;
  winnerBotId?: bigint | null;
  paid: number;
  letter?: string;
}

export interface Reducers {
  submitBid(auctionId: bigint, amount: bigint): Promise<unknown>;
  submitWord(matchId: bigint, word: string): Promise<unknown>;
  joinLobby(): Promise<unknown>;
  registerForTournament(tournamentId: bigint): Promise<unknown>;
}

export interface Timers {
  /** Wall clock in ms, comparable with AuctionView.closesAtMs. */
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface Strategy {
  decideBid(ctx: BidContext): number;
  chooseWord(ctx: WordContext): string | null;
}

export type Log = (event: string, data: Record<string, unknown>) => void;

export interface SchedulerOptions {
  strategy: Strategy;
  state: ClientState;
  reducers: Reducers;
  timers: Timers;
  dictionary: string[];
  log: Log;
  /** Human-readable progress lines (bids, words). */
  say?: (line: string) => void;
  /** Block all gameplay unless the authenticated bot has this id. */
  expectedBotId?: bigint;
  /** Stop after this many completed matches: no rejoin, then onFinished. */
  maxMatches?: number;
  tournamentId?: bigint;
  /** Minimum gap between word submissions in one match. */
  wordRetryMs?: number;
  /** Submissions per auction, first attempt included. */
  maxBidAttempts?: number;
  bidRetryDelayMs?: number;
  /** A retry needs at least this long left before the auction closes. */
  bidRetryMarginMs?: number;
  /** For compute latency; defaults to performance.now. */
  perfNow?: () => number;
  letterValue?: (letter: string) => number;
  /** After MAX_MATCHES, once every summary is final. */
  onFinished?: () => void;
  /** A match's summary is final; its subscriptions can go. */
  onMatchFinalized?: (matchId: bigint) => void;
  /** Longest wait for missing auction results after a match ends. */
  summaryWaitMs?: number;
  summaryPollMs?: number;
  /** TRACE_DECISIONS: log every decision with a frozen snapshot. */
  trace?: boolean;
  /** Effective strategy parameters, copied into traced bid decisions. */
  traceParams?: Record<string, unknown>;
}

export const WORD_RETRY_MS = 500;
export const MAX_BID_ATTEMPTS = 2;
export const BID_RETRY_DELAY_MS = 50;
export const BID_RETRY_MARGIN_MS = 150;
export const SUMMARY_WAIT_MS = 2000;
export const SUMMARY_POLL_MS = 100;
const STARTING_BALANCE = 100;
/** The module's bag (letters.ts DEFAULT_BAG). */
const BAG_SIZE = 98;

/** A frozen copy of a rack, letters sorted. */
function rackSnapshot(rack: Map<string, number>): Readonly<Record<string, number>> {
  return Object.freeze(
    Object.fromEntries([...rack].filter(([, n]) => n > 0).sort(([a], [b]) => (a < b ? -1 : 1))),
  );
}

/** Rejections that a retry cannot fix (index.ts submitBid in the module). */
const TERMINAL_BID_ERRORS = [
  "Auction closed",
  "Auction window expired",
  "Unknown auction",
  "Not in this match",
  "Bid must be non-negative",
  "not a credential",
];

interface WordSlot {
  lastSubmitAt: number;
  timer?: unknown;
  inFlight: boolean;
  dirty: boolean;
  /** Trace only: the latest event that was deferred into this slot. */
  lastTrigger?: string;
}

interface BidSlot {
  matchId: bigint;
  state: "idle" | "inFlight" | "succeeded" | "abandoned";
  attempts: number;
  timer?: unknown;
  /** Trace sequence id of the latest decision for this auction. */
  seq?: number;
  submitted?: number;
}

interface MatchStats {
  matchId: bigint;
  started: boolean;
  bidDecisions: number;
  bidPasses: number;
  bidAttempts: number;
  bidOk: number;
  bidFailed: number;
  bidRetries: number;
  bidInvalid: number;
  bidSkippedExpired: number;
  wordDecisions: number;
  wordNone: number;
  wordAttempts: number;
  wordOk: number;
  wordFailed: number;
  wordInvalid: number;
  wordCoalesced: number;
  bidComputeMs: number[];
  wordComputeMs: number[];
  bidRoundTripMs: number[];
  wordRoundTripMs: number[];
  results: Map<string, AuctionResultRow>;
  fromCallback: number;
  fromCache: number;
  lateResults: number;
  tilesBought: number;
  spent: number;
  endedAt?: number;
  finalizeDeadline?: number;
  finalizeTimer?: unknown;
  summaryEmitted: boolean;
}

export function summarize(ms: number[]) {
  if (!ms.length) return { n: 0, p50: null, p95: null, max: null };
  const a = [...ms].sort((x, y) => x - y);
  const q = (f: number) => a[Math.min(a.length - 1, Math.ceil(f * a.length) - 1)]!;
  const r = (x: number) => Math.round(x * 100) / 100;
  return { n: a.length, p50: r(q(0.5)), p95: r(q(0.95)), max: r(a[a.length - 1]!) };
}

function errorText(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

export class ClientScheduler {
  private botId: bigint | null = null;
  private mismatch = false;
  private closed = false;
  private finished = false;
  private readonly completed = new Set<string>();
  private readonly words = new Map<string, WordSlot>();
  private readonly bids = new Map<string, BidSlot>();
  private readonly stats = new Map<string, MatchStats>();
  private readonly o: Required<
    Pick<
      SchedulerOptions,
      | "wordRetryMs"
      | "maxBidAttempts"
      | "bidRetryDelayMs"
      | "bidRetryMarginMs"
      | "summaryWaitMs"
      | "summaryPollMs"
    >
  > &
    SchedulerOptions;
  private readonly perfNow: () => number;
  private seq = 0;
  private finishNotified = false;

  constructor(opts: SchedulerOptions) {
    this.o = {
      wordRetryMs: WORD_RETRY_MS,
      maxBidAttempts: MAX_BID_ATTEMPTS,
      bidRetryDelayMs: BID_RETRY_DELAY_MS,
      bidRetryMarginMs: BID_RETRY_MARGIN_MS,
      summaryWaitMs: SUMMARY_WAIT_MS,
      summaryPollMs: SUMMARY_POLL_MS,
      ...opts,
    };
    this.perfNow = opts.perfNow ?? (() => performance.now());
  }

  /** Trace-only logging: never called when tracing is off. */
  private trace(event: string, data: Record<string, unknown>) {
    if (this.o.trace) this.o.log(event, data);
  }

  // ---------- identity and lifecycle ----------

  /** Returns false while gameplay is blocked for this identity. */
  setBotId(id: bigint | null): boolean {
    this.botId = id;
    if (id === null) return false;
    if (this.o.expectedBotId !== undefined && id !== this.o.expectedBotId) {
      if (!this.mismatch) {
        this.o.log("identity_mismatch", {
          resolvedBotId: id,
          expectedBotId: this.o.expectedBotId,
          action: "all gameplay blocked",
        });
      }
      this.mismatch = true;
      return false;
    }
    this.mismatch = false;
    return true;
  }

  get identityMismatch() {
    return this.mismatch;
  }

  get completedMatches() {
    return this.completed.size;
  }

  get isFinished() {
    return this.finished;
  }

  canAct(): boolean {
    return !this.closed && !this.finished && !this.mismatch && this.botId !== null;
  }

  /** After identity resolves: register, join, and act on what is open. */
  start() {
    if (!this.canAct()) return;
    if (this.o.tournamentId !== undefined) {
      const id = this.o.tournamentId;
      this.o.reducers.registerForTournament(id).then(
        () => this.o.say?.(`registered for tournament ${id}`),
        (e) => this.o.log("tournament_register_failed", { tournamentId: id, error: errorText(e) }),
      );
    }
    this.joinLobby();
    for (const a of this.o.state.openAuctions()) this.requestBid(a.id, "bootstrap");
    for (const m of this.o.state.myMatchIds(this.botId!)) this.requestWord(m, "bootstrap");
  }

  shutdown(reason: string) {
    if (this.closed) return;
    this.closed = true;
    this.cancelAll();
    // Don't lose a summary still waiting for results: emit what is known.
    for (const key of this.completed) {
      const s = this.stats.get(key);
      if (s && !s.summaryEmitted) this.tryFinalize(s.matchId, `shutdown: ${reason}`);
    }
    this.o.log("scheduler_closed", { reason, completedMatches: this.completed.size });
  }

  private cancelAll() {
    for (const s of this.words.values()) this.clear(s);
    for (const s of this.bids.values()) this.clear(s);
  }

  private clear(s: { timer?: unknown }) {
    if (s.timer !== undefined) this.o.timers.clearTimeout(s.timer);
    s.timer = undefined;
  }

  // ---------- lobby ----------

  joinLobby() {
    if (!this.canAct()) return;
    const me = this.botId!;
    if (this.o.maxMatches !== undefined && this.completed.size >= this.o.maxMatches) return;
    const running = this.o.state
      .myMatchIds(me)
      .some((m) => this.o.state.match(m)?.status === "Running");
    if (running || this.o.state.inOpenLobby(me)) return;
    this.o.say?.("joining lobby");
    this.o.reducers.joinLobby().catch((e) => this.o.log("join_lobby_failed", { error: errorText(e) }));
  }

  // ---------- matches ----------

  private statsFor(matchId: bigint): MatchStats {
    const key = String(matchId);
    let s = this.stats.get(key);
    if (!s) {
      s = {
        matchId,
        started: false,
        bidDecisions: 0,
        bidPasses: 0,
        bidAttempts: 0,
        bidOk: 0,
        bidFailed: 0,
        bidRetries: 0,
        bidInvalid: 0,
        bidSkippedExpired: 0,
        wordDecisions: 0,
        wordNone: 0,
        wordAttempts: 0,
        wordOk: 0,
        wordFailed: 0,
        wordInvalid: 0,
        wordCoalesced: 0,
        bidComputeMs: [],
        wordComputeMs: [],
        bidRoundTripMs: [],
        wordRoundTripMs: [],
        results: new Map(),
        fromCallback: 0,
        fromCache: 0,
        lateResults: 0,
        tilesBought: 0,
        spent: 0,
        summaryEmitted: false,
      };
      this.stats.set(key, s);
    }
    return s;
  }

  /** A running match of ours is subscribed. Logs its settings once. */
  onMatchSeen(matchId: bigint) {
    const m = this.o.state.match(matchId);
    if (!m || m.status !== "Running") return;
    const s = this.statsFor(matchId);
    if (s.started) return;
    s.started = true;
    this.o.log("match_start", {
      matchId,
      players: m.players,
      auctionType: m.auctionType,
      auctionDurationMs: m.auctionDurationMs,
      startingRackSize: m.startingRackSize,
      bagTotal: m.bagTotal,
    });
  }

  /** An auction_result insert callback for a subscribed match. */
  onAuctionResult(r: AuctionResultRow) {
    const slot = this.bids.get(String(r.auctionId));
    if (slot) this.clear(slot);
    if (this.botId === null) return;
    const s = this.statsFor(r.matchId);
    const added = this.recordResult(s, r, "callback");
    if (added && s.summaryEmitted) {
      s.lateResults++;
      this.o.log("late_auction_result", { matchId: r.matchId, auctionId: r.auctionId, note: "after final summary" });
    }
    if (s.finalizeDeadline !== undefined && !s.summaryEmitted) this.tryFinalize(r.matchId);
  }

  /** Adds a result once per auction id, whichever source sees it first. */
  private recordResult(s: MatchStats, r: AuctionResultRow, source: "callback" | "cache") {
    const key = String(r.auctionId);
    if (s.results.has(key)) return false;
    s.results.set(key, { ...r });
    if (source === "cache") s.fromCache++;
    else s.fromCallback++;
    const won = r.winnerBotId !== undefined && r.winnerBotId !== null && r.winnerBotId === this.botId;
    if (won) {
      s.tilesBought++;
      s.spent += r.paid;
    }
    if (this.o.trace) {
      const slot = this.bids.get(key);
      this.trace("trace_auction_result", {
        seq: slot?.seq ?? null,
        matchId: r.matchId,
        auctionId: r.auctionId,
        letter: r.letter ?? null,
        winnerBotId: r.winnerBotId ?? null,
        paid: r.paid,
        won,
        ourSubmittedBid: slot?.submitted ?? null,
        seenVia: source,
      });
    }
    return true;
  }

  /** Pulls cached results into the match's set and checks completeness. */
  private reconcile(matchId: bigint) {
    const s = this.statsFor(matchId);
    const snap = this.o.state.auctionResults?.(matchId);
    if (snap) for (const r of snap) this.recordResult(s, r, "cache");
    const ids = this.o.state.auctionIds?.(matchId);
    const m = this.o.state.match(matchId);
    const derived = m && m.players > 0 ? BAG_SIZE - m.players * m.startingRackSize : null;
    const missing = ids ? ids.filter((id) => !s.results.has(String(id))) : [];
    let completeness: "complete" | "incomplete" | "unverifiable";
    if (!snap) completeness = "unverifiable";
    else if (
      missing.length === 0 &&
      (ids === undefined || ids.length > 0) &&
      (derived === null || s.results.size === derived) &&
      (ids !== undefined || derived !== null)
    ) {
      completeness = "complete";
    } else completeness = "incomplete";
    return {
      completeness,
      observed: s.results.size,
      expectedFromAuctionRows: ids ? ids.length : null,
      expectedFromBag: derived,
      missingAuctionIds: missing.slice(0, 10),
      missingCount: missing.length,
    };
  }

  /**
   * Emits the match's one summary once its results reconcile, or when the
   * wait runs out, or at once if `forced` (shutdown).
   */
  private tryFinalize(matchId: bigint, forced?: string) {
    const s = this.statsFor(matchId);
    if (s.summaryEmitted) return;
    const now = this.o.timers.now();
    const c = this.reconcile(matchId);
    const due = s.finalizeDeadline === undefined || now >= s.finalizeDeadline;
    if (c.completeness !== "incomplete" || forced || due) {
      if (s.finalizeTimer !== undefined) this.o.timers.clearTimeout(s.finalizeTimer);
      s.finalizeTimer = undefined;
      s.summaryEmitted = true;
      this.logSummary(matchId, {
        ...c,
        waitedMs: s.endedAt === undefined ? 0 : now - s.endedAt,
        stoppedBy: c.completeness === "incomplete" ? (forced ?? "wait limit") : null,
      });
      this.o.onMatchFinalized?.(matchId);
      this.maybeFinish();
      return;
    }
    if (s.finalizeTimer === undefined) {
      const wait = Math.max(0, Math.min(this.o.summaryPollMs, s.finalizeDeadline! - now));
      s.finalizeTimer = this.o.timers.setTimeout(() => {
        s.finalizeTimer = undefined;
        this.tryFinalize(matchId);
      }, wait);
    }
  }

  private maybeFinish() {
    if (!this.finished || this.finishNotified) return;
    for (const key of this.completed) if (!this.stats.get(key)?.summaryEmitted) return;
    this.finishNotified = true;
    this.o.log("trial_complete", { completedMatches: this.completed.size, maxMatches: this.o.maxMatches });
    this.o.onFinished?.();
  }

  onAuctionClosed(auctionId: bigint) {
    const slot = this.bids.get(String(auctionId));
    if (slot) this.clear(slot);
  }

  /**
   * A match moved to Ended. Counts it once, cancels its work, starts its
   * summary, and rejoins (or finishes after MAX_MATCHES). Returns true when
   * the summary will report through onMatchFinalized, so the caller should
   * keep the match's subscriptions until then.
   */
  onMatchEnded(matchId: bigint): boolean {
    const key = String(matchId);
    const ws = this.words.get(key);
    if (ws) this.clear(ws);
    for (const b of this.bids.values()) if (b.matchId === matchId) this.clear(b);
    if (this.botId === null || this.mismatch || this.closed) return false;
    if (this.completed.has(key)) return true;
    if (this.finished) return false;
    if (!this.o.state.participant(matchId, this.botId)) return false;
    this.completed.add(key);
    const s = this.statsFor(matchId);
    s.endedAt = this.o.timers.now();
    s.finalizeDeadline = s.endedAt + this.o.summaryWaitMs;
    const last = this.o.maxMatches !== undefined && this.completed.size >= this.o.maxMatches;
    if (last) {
      this.finished = true;
      this.cancelAll();
    }
    this.tryFinalize(matchId);
    if (!last) this.joinLobby();
    return true;
  }

  private logSummary(matchId: bigint, results: Record<string, unknown> & { completeness: string }) {
    const me = this.botId!;
    const s = this.statsFor(matchId);
    const p = this.o.state.participant(matchId, me);
    const rack = this.o.state.rack(matchId);
    let unplayed = 0;
    let face: number | null = this.o.letterValue ? 0 : null;
    for (const [l, c] of rack) {
      unplayed += c;
      if (face !== null) face += c * this.o.letterValue!(l);
    }
    const scores = this.o.state.scores(matchId);
    const mine = p?.score;
    const placement =
      mine === undefined ? null : 1 + scores.filter((x) => x.botId !== me && x.score > mine).length;
    const sharedTop =
      placement === 1 && scores.some((x) => x.botId !== me && x.score === mine);
    this.o.log("match_summary", {
      matchId,
      observed: {
        finalScore: p?.score ?? null,
        endingBalance: p?.balance ?? null,
        placement,
        sharedTopScore: placement === 1 ? sharedTop : false,
        participants: scores.length,
        unplayedTiles: unplayed,
        unplayedFaceValue: face,
        // From auction_result rows only. Exact when results.completeness is
        // "complete"; otherwise a lower bound over the results seen.
        tilesBoughtFromResults: s.tilesBought,
        spentFromResults: s.spent,
        auctionResultsSeen: s.results.size,
        results: {
          ...results,
          viaCallback: s.fromCallback,
          viaCacheSnapshot: s.fromCache,
        },
        bids: {
          decisions: s.bidDecisions,
          passes: s.bidPasses,
          attempts: s.bidAttempts,
          ok: s.bidOk,
          failed: s.bidFailed,
          retries: s.bidRetries,
          invalidOutputs: s.bidInvalid,
          skippedExpired: s.bidSkippedExpired,
          computeMs: summarize(s.bidComputeMs),
          roundTripMs: summarize(s.bidRoundTripMs),
        },
        words: {
          decisions: s.wordDecisions,
          none: s.wordNone,
          attempts: s.wordAttempts,
          ok: s.wordOk,
          failed: s.wordFailed,
          invalidOutputs: s.wordInvalid,
          coalescedEvents: s.wordCoalesced,
          computeMs: summarize(s.wordComputeMs),
          roundTripMs: summarize(s.wordRoundTripMs),
        },
      },
      inferred: {
        // balance = 100 - spent + score, so spending follows from the
        // observed end state (assumes the module's starting balance).
        spentFromBalance: p ? STARTING_BALANCE + p.score - p.balance : null,
      },
      unavailable: [
        "network vs server time within roundTripMs",
        "opponent racks",
        "server-side bid ordering",
      ],
    });
  }

  // ---------- bids ----------

  requestBid(auctionId: bigint, reason = "event") {
    if (!this.canAct()) return;
    const me = this.botId!;
    const a = this.o.state.auction(auctionId);
    if (!a) return;
    const key = String(auctionId);
    let slot = this.bids.get(key);
    if (!slot) {
      slot = { matchId: a.matchId, state: "idle", attempts: 0 };
      this.bids.set(key, slot);
    }
    if (slot.state !== "idle") return;
    if (slot.attempts >= this.o.maxBidAttempts) return;
    const m = this.o.state.match(a.matchId);
    const p = this.o.state.participant(a.matchId, me);
    if (a.status !== "Open" || !m || m.status !== "Running" || !p) return;
    const s = this.statsFor(a.matchId);
    const margin = slot.attempts > 0 ? this.o.bidRetryMarginMs : 0;
    if (this.o.timers.now() >= a.closesAtMs - margin) {
      s.bidSkippedExpired++;
      return;
    }

    const ctx: BidContext = {
      letter: a.letter,
      myBalance: p.balance,
      myRack: this.o.state.rack(a.matchId),
      dictionary: this.o.dictionary,
      bagTotal: m.bagTotal,
      auctionType: m.auctionType,
      players: m.players || undefined,
    };
    // Snapshot before the strategy runs, so it can't alter the record.
    const decidedAt = this.o.trace ? this.o.timers.now() : 0;
    const snap = this.o.trace ? rackSnapshot(ctx.myRack) : undefined;
    const t0 = this.perfNow();
    let amount: unknown;
    try {
      amount = this.o.strategy.decideBid(ctx);
    } catch (e) {
      amount = e;
    }
    const computeMs = this.perfNow() - t0;
    s.bidComputeMs.push(computeMs);
    s.bidDecisions++;
    let seq: number | undefined;
    if (this.o.trace) {
      seq = ++this.seq;
      slot.seq = seq;
      this.trace("trace_bid_decision", {
        seq,
        matchId: a.matchId,
        auctionId,
        letter: a.letter,
        trigger: reason,
        attempt: slot.attempts + 1,
        auctionType: m.auctionType,
        bagTotal: m.bagTotal,
        players: m.players,
        balance: p.balance,
        score: p.score,
        rack: snap,
        params: this.o.traceParams ?? null,
        output: amount instanceof Error ? `threw: ${amount.message}` : typeof amount === "number" ? amount : String(amount),
        computeMs: Math.round(computeMs * 1000) / 1000,
        decidedAtMs: decidedAt,
        closesAtMs: a.closesAtMs,
        msBeforeClose: a.closesAtMs - decidedAt,
      });
    }

    if (typeof amount !== "number" || !Number.isFinite(amount) || !Number.isInteger(amount) || amount < 0) {
      s.bidInvalid++;
      slot.state = "abandoned";
      this.o.log("invalid_bid_output", {
        matchId: a.matchId,
        auctionId,
        output: amount instanceof Error ? `threw: ${amount.message}` : String(amount),
      });
      return;
    }
    if (amount === 0) {
      s.bidPasses++;
      return;
    }
    if (amount > p.balance) {
      s.bidInvalid++;
      slot.state = "abandoned";
      this.o.log("invalid_bid_output", { matchId: a.matchId, auctionId, output: amount, balance: p.balance });
      return;
    }

    slot.state = "inFlight";
    slot.attempts++;
    s.bidAttempts++;
    if (slot.attempts > 1) s.bidRetries++;
    const sent = this.o.timers.now();
    slot.submitted = amount;
    this.o.say?.(
      `bid ${amount} on '${a.letter}' (match ${a.matchId}, auction ${auctionId}${slot.attempts > 1 ? `, retry ${slot.attempts - 1}` : ""}, ${reason})`,
    );
    this.trace("trace_bid_submit", { seq, matchId: a.matchId, auctionId, amount, attempt: slot.attempts, sentAtMs: sent });
    this.o.reducers.submitBid(auctionId, BigInt(amount)).then(
      () => {
        slot!.state = "succeeded";
        s.bidOk++;
        s.bidRoundTripMs.push(this.o.timers.now() - sent);
        this.trace("trace_bid_ack", { seq, auctionId, roundTripMs: this.o.timers.now() - sent });
      },
      (e) => {
        const msg = errorText(e);
        const terminal = TERMINAL_BID_ERRORS.some((t) => msg.includes(t));
        slot!.state = terminal ? "abandoned" : "idle";
        s.bidFailed++;
        s.bidRoundTripMs.push(this.o.timers.now() - sent);
        const willRetry = !terminal && slot!.attempts < this.o.maxBidAttempts && this.canAct();
        this.o.log("bid_failed", {
          ...(this.o.trace ? { seq } : {}),
          matchId: a.matchId,
          auctionId,
          amount,
          attempt: slot!.attempts,
          error: msg,
          terminal,
          willRetry,
        });
        if (willRetry) {
          slot!.timer = this.o.timers.setTimeout(() => {
            slot!.timer = undefined;
            this.requestBid(auctionId, "retry");
          }, this.o.bidRetryDelayMs);
        }
      },
    );
  }

  // ---------- words ----------

  /** A rack, bag or subscription change that may make a word worth trying. */
  requestWord(matchId: bigint, reason = "event") {
    if (!this.canAct()) return;
    const key = String(matchId);
    const m = this.o.state.match(matchId);
    if (!m || m.status !== "Running" || !this.o.state.participant(matchId, this.botId!)) {
      const ws = this.words.get(key);
      if (ws) this.clear(ws);
      return;
    }
    let slot = this.words.get(key);
    if (!slot) {
      slot = { lastSubmitAt: -Infinity, inFlight: false, dirty: false };
      this.words.set(key, slot);
    }
    const s = this.statsFor(matchId);
    if (slot.inFlight) {
      slot.dirty = true;
      slot.lastTrigger = reason;
      s.wordCoalesced++;
      return;
    }
    const wait = slot.lastSubmitAt + this.o.wordRetryMs - this.o.timers.now();
    if (wait > 0) {
      slot.lastTrigger = reason;
      if (slot.timer === undefined) {
        slot.timer = this.o.timers.setTimeout(() => {
          slot!.timer = undefined;
          this.runWord(matchId, "throttled");
        }, wait);
      } else {
        s.wordCoalesced++;
      }
      return;
    }
    this.runWord(matchId, reason);
  }

  private runWord(matchId: bigint, reason: string) {
    if (!this.canAct()) return;
    const key = String(matchId);
    const slot = this.words.get(key)!;
    const m = this.o.state.match(matchId);
    if (!m || m.status !== "Running" || slot.inFlight) return;
    const s = this.statsFor(matchId);
    const ctx: WordContext & Record<string, unknown> = {
      myRack: this.o.state.rack(matchId),
      dictionary: this.o.dictionary,
      bagTotal: m.bagTotal,
      auctionType: m.auctionType,
      players: m.players || undefined,
    };
    // Snapshot before the strategy runs, so it can't alter the record.
    const decidedAt = this.o.trace ? this.o.timers.now() : 0;
    const snap = this.o.trace ? rackSnapshot(ctx.myRack) : undefined;
    const t0 = this.perfNow();
    let word: unknown;
    try {
      word = this.o.strategy.chooseWord(ctx);
    } catch (e) {
      word = e;
    }
    const computeMs = this.perfNow() - t0;
    s.wordComputeMs.push(computeMs);
    s.wordDecisions++;
    let seq: number | undefined;
    if (this.o.trace) {
      seq = ++this.seq;
      const p = this.o.state.participant(matchId, this.botId!);
      this.trace("trace_word_decision", {
        seq,
        matchId,
        trigger: reason === "throttled" ? `throttled (last event: ${slot.lastTrigger ?? "?"})` : reason,
        bagTotal: m.bagTotal,
        players: m.players,
        balance: p?.balance ?? null,
        score: p?.score ?? null,
        rack: snap,
        output: word instanceof Error ? `threw: ${word.message}` : word === undefined ? null : word,
        computeMs: Math.round(computeMs * 1000) / 1000,
        decidedAtMs: decidedAt,
      });
    }
    if (word === null || word === undefined || word === "") {
      s.wordNone++;
      return; // a "no word" decision does not use up the throttle
    }
    if (typeof word !== "string" || !/^[A-Za-z]{2,}$/.test(word)) {
      s.wordInvalid++;
      this.o.log("invalid_word_output", {
        matchId,
        output: word instanceof Error ? `threw: ${word.message}` : String(word),
      });
      return;
    }

    slot.inFlight = true;
    slot.dirty = false;
    slot.lastSubmitAt = this.o.timers.now();
    s.wordAttempts++;
    const sent = slot.lastSubmitAt;
    this.o.say?.(`match ${matchId}: playing '${word}' (${reason})`);
    this.trace("trace_word_submit", { seq, matchId, word, sentAtMs: sent });
    this.o.reducers.submitWord(matchId, word).then(
      () => {
        s.wordOk++;
        s.wordRoundTripMs.push(this.o.timers.now() - sent);
        this.trace("trace_word_ack", { seq, matchId, word, roundTripMs: this.o.timers.now() - sent });
        slot.inFlight = false;
        slot.dirty = false;
        // The rack changed: look again with fresh state once the throttle allows.
        this.requestWord(matchId, "after-word");
      },
      (e) => {
        s.wordFailed++;
        s.wordRoundTripMs.push(this.o.timers.now() - sent);
        this.o.log("word_failed", { ...(this.o.trace ? { seq } : {}), matchId, word, error: errorText(e) });
        slot.inFlight = false;
        // Retry only for a newer event, so a refused word cannot loop.
        if (slot.dirty) {
          slot.dirty = false;
          this.requestWord(matchId, "after-failure");
        }
      },
    );
  }
}
