// ScrabbleBot bot starter.
//
// First run, with a token from the website:
//   On your team's page, click "Generate token", then run
//   `BOT_NAME=<name> BOT_TOKEN=<token> npm start`.
//
// Or with a nonce from the CLI:
//   1. `spacetime call scrabblebot mint_credential_nonce`
//      `spacetime sql 'SELECT code FROM my_nonces ORDER BY expires_at DESC'`
//   2. `BOT_NAME=<name> BOT_NONCE=<code> npm start`
//      The bot connects fresh and redeems the nonce.
//
// Either way the bot saves its token to .token-<BOT_NAME>, so later runs
// need only `BOT_NAME=<name> npm start`.
//
// Entering a tournament: `BOT_NAME=<name> TOURNAMENT_ID=<id> npm start`
// registers the bot for that tournament when it connects. Only the bot
// itself can register, so this has to come from the bot's process.
//
// Bounded trials (both optional):
//   EXPECTED_BOT_ID=<id>  no gameplay call at all unless the token's bot has
//                         this id; on a mismatch the bot disconnects.
//   MAX_MATCHES=<n>       after n completed matches, don't rejoin; exit.
//
// Edit ./src/strategy.ts to customise how your bot bids and plays words.
// When to act is decided in ./src/client/scheduler.ts.

import {
  DbConnection,
  tables,
  type EventContext,
  type ErrorContext,
} from "./module_bindings/index.js";
import { Identity } from "spacetimedb";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ClientScheduler,
  type AuctionView,
  type ClientState,
} from "./client/scheduler.js";
import * as strategy from "./strategy.js";

const HOST = process.env.STDB_HOST ?? "https://maincloud.spacetimedb.com";
const DB_NAME = process.env.STDB_DB ?? "scrabblebot";
const BOT_NAME = process.env.BOT_NAME ?? "bot";
const BOT_TOKEN = process.env.BOT_TOKEN; // from the website, first run only
const BOT_NONCE = process.env.BOT_NONCE; // from the CLI, first run only
const TOURNAMENT_ID = process.env.TOURNAMENT_ID;
const TOKEN_PATH = path.join(process.cwd(), `.token-${BOT_NAME}`);

function intOption(name: string): string | undefined {
  const v = process.env[name];
  if (v === undefined || v === "") return undefined;
  if (!/^\d+$/.test(v)) {
    console.error(`[${BOT_NAME}] ${name} must be a whole number`);
    process.exit(1);
  }
  return v;
}
const EXPECTED_BOT_ID = intOption("EXPECTED_BOT_ID");
const MAX_MATCHES_RAW = intOption("MAX_MATCHES");
const MAX_MATCHES = MAX_MATCHES_RAW === undefined ? undefined : Number(MAX_MATCHES_RAW);
if (MAX_MATCHES === 0) {
  console.error(`[${BOT_NAME}] MAX_MATCHES must be at least 1`);
  process.exit(1);
}
if (TOURNAMENT_ID !== undefined && !/^\d+$/.test(TOURNAMENT_ID)) {
  console.error(`[${BOT_NAME}] TOURNAMENT_ID must be a whole number`);
  process.exit(1);
}

function telemetry(event: string, data: Record<string, unknown>) {
  console.log(
    `[telemetry] ${JSON.stringify(
      { t: new Date().toISOString(), bot: BOT_NAME, event, ...data },
      (_k, v) => (typeof v === "bigint" ? v.toString() : v),
    )}`,
  );
}

function loadToken(): string | undefined {
  try {
    return fs.readFileSync(TOKEN_PATH, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}
function saveToken(tok: string) {
  fs.writeFileSync(TOKEN_PATH, tok, { mode: 0o600 });
}

// Load the shared wordlist so the bot can pick playable words locally.
const here = path.dirname(fileURLToPath(import.meta.url));
const dictionaryPath = path.join(here, "..", "..", "spacetimedb", "wordlist.txt");
const DICTIONARY: string[] = fs.existsSync(dictionaryPath)
  ? fs
      .readFileSync(dictionaryPath, "utf8")
      .split("\n")
      .map((l) => l.trim().toUpperCase())
      .filter((l) => l.length >= 2)
  : [];
DICTIONARY.sort((a, b) => b.length - a.length); // longest first for greedy pick
const warmStart = performance.now();
strategy.warmUp(DICTIONARY);
const warmMs = performance.now() - warmStart;
console.log(`[${BOT_NAME}] loaded ${DICTIONARY.length} words`);
if (DICTIONARY.length === 0) {
  console.error(`[${BOT_NAME}] word list not found at ${dictionaryPath}`);
  process.exit(1);
}

const PARAM_ENV = ["BID_K", "BID_PACE", "BID_DENY", "CASH", "END", "FV", "LC"];
const TRACE_DECISIONS = process.env.TRACE_DECISIONS === "1";
if (process.env.TRACE_DECISIONS !== undefined && !TRACE_DECISIONS) {
  console.warn(`[${BOT_NAME}] TRACE_DECISIONS is only enabled by the value 1; tracing is off`);
}
const sha256Of = (file: string) =>
  fs.existsSync(file) ? createHash("sha256").update(fs.readFileSync(file)).digest("hex") : "unavailable";
telemetry("startup", {
  strategyFile: "src/strategy.ts",
  strategySha256: sha256Of(path.join(here, "strategy.ts")),
  clientSha256: {
    "src/index.ts": sha256Of(path.join(here, "index.ts")),
    "src/client/scheduler.ts": sha256Of(path.join(here, "client", "scheduler.ts")),
  },
  dictionary: {
    file: "spacetimedb/wordlist.txt",
    sha256: sha256Of(dictionaryPath),
    words: DICTIONARY.length,
  },
  traceDecisions: TRACE_DECISIONS,
  effectiveParams: strategy.DEFAULT_PARAMS,
  paramEnvOverrides: PARAM_ENV.filter((k) => process.env[k] !== undefined),
  host: HOST,
  database: DB_NAME,
  expectedBotId: EXPECTED_BOT_ID ?? null,
  maxMatches: MAX_MATCHES ?? null,
  tournamentId: TOURNAMENT_ID ?? null,
  dictionaryWords: DICTIONARY.length,
  indexWarmUpMs: Math.round(warmMs * 100) / 100,
  node: process.version,
});

// Subscribe only to what this bot needs. Subscribing to every table pulls
// the whole server's match history and runs out of memory.
type Sub = { unsubscribe: () => void };
const matchSubs = new Map<string, Sub[]>();
let mineSubscribed = false;
let myIdentity: Identity | null = null;
let myBotId: bigint | null = null;
let scheduler: ClientScheduler | null = null;

function subscribeMine(conn: DbConnection) {
  if (mineSubscribed || myBotId === null) return;
  mineSubscribed = true;
  const id = myBotId;
  conn.subscriptionBuilder().subscribe([
    tables.matchParticipant.where((r) => r.botId.eq(id)),
    tables.bot.where((r) => r.id.eq(id)),
  ]);
}

function subscribeMatch(conn: DbConnection, matchId: bigint) {
  const key = String(matchId);
  if (matchSubs.has(key)) return;
  const subs: Sub[] = [];
  matchSubs.set(key, subs);
  const h = conn
    .subscriptionBuilder()
    .onApplied(() => {
      const m = conn.db.matchState.id.find(matchId);
      if (m?.status.tag !== "Running") {
        // An old match: nothing to do, so don't keep its rows.
        dropMatch(matchId);
        return;
      }
      // Results for this match only, for telemetry; dropped with the match.
      const r = conn
        .subscriptionBuilder()
        .subscribe([tables.auctionResult.where((x) => x.matchId.eq(matchId))]);
      subs.push(r as unknown as Sub);
      scheduler?.onMatchSeen(matchId);
      for (const a of conn.db.auction.iter()) {
        if (a.matchId === matchId && a.status.tag === "Open") scheduler?.requestBid(a.id, "subscribed");
      }
      scheduler?.requestWord(matchId, "subscribed");
    })
    .subscribe([
      tables.matchState.where((r) => r.id.eq(matchId)),
      tables.matchParticipant.where((r) => r.matchId.eq(matchId)),
      tables.auction.where((r) => r.matchId.eq(matchId)),
    ]);
  subs.push(h as unknown as Sub);
}

function dropMatch(matchId: bigint, delayMs = 2000) {
  const key = String(matchId);
  const subs = matchSubs.get(key);
  if (!subs) return;
  matchSubs.set(key, []);
  setTimeout(() => {
    for (const h of subs) {
      try { h.unsubscribe(); } catch { /* already gone */ }
    }
  }, delayMs);
}

function resolveMyBotId(conn: DbConnection): bigint | null {
  if (!myIdentity) return null;
  const cred = conn.db.botCredential.identity.find(myIdentity);
  return cred ? cred.botId : null;
}

function auctionView(a: {
  id: bigint;
  matchId: bigint;
  letter: string;
  status: { tag: string };
  closesAt: { microsSinceUnixEpoch: bigint };
}): AuctionView {
  return {
    id: a.id,
    matchId: a.matchId,
    letter: a.letter,
    status: a.status.tag,
    closesAtMs: Number(a.closesAt.microsSinceUnixEpoch / 1000n),
  };
}

function clientState(conn: DbConnection): ClientState {
  return {
    match(matchId) {
      const m = conn.db.matchState.id.find(matchId);
      if (!m) return undefined;
      let players = 0;
      for (const p of conn.db.matchParticipant.iter()) if (p.matchId === matchId) players++;
      return {
        status: m.status.tag,
        bagTotal: Number(m.bagTotal),
        auctionType: m.auctionType.tag,
        players,
        auctionDurationMs: Number(m.auctionDurationMs),
        startingRackSize: Number(m.startingRackSize),
      };
    },
    participant(matchId, botId) {
      for (const p of conn.db.matchParticipant.iter()) {
        if (p.matchId === matchId && p.botId === botId) {
          return { balance: Number(p.balance), score: Number(p.score) };
        }
      }
      return undefined;
    },
    rack(matchId) {
      const rack = new Map<string, number>();
      for (const h of conn.db.myRack.iter()) {
        if (h.matchId !== matchId || h.count <= 0) continue;
        rack.set(h.letter, (rack.get(h.letter) ?? 0) + h.count);
      }
      return rack;
    },
    auction(auctionId) {
      const a = conn.db.auction.id.find(auctionId);
      return a ? auctionView(a) : undefined;
    },
    openAuctions() {
      return [...conn.db.auction.iter()].filter((a) => a.status.tag === "Open").map(auctionView);
    },
    myMatchIds(botId) {
      const ids: bigint[] = [];
      for (const p of conn.db.matchParticipant.iter()) if (p.botId === botId) ids.push(p.matchId);
      return ids;
    },
    inOpenLobby(botId) {
      const open = [...conn.db.lobby.iter()].find((l) => l.status.tag === "Open");
      return (
        open !== undefined &&
        [...conn.db.lobbyMember.iter()].some((lm) => lm.lobbyId === open.id && lm.botId === botId)
      );
    },
    scores(matchId) {
      return [...conn.db.matchParticipant.iter()]
        .filter((p) => p.matchId === matchId)
        .map((p) => ({ botId: p.botId, score: Number(p.score) }));
    },
    // The SDK applies a whole transaction to its cache before it runs any
    // row callback, so these can include rows whose callbacks are pending.
    auctionResults(matchId) {
      return [...conn.db.auctionResult.iter()]
        .filter((r) => r.matchId === matchId)
        .map((r) => ({
          auctionId: r.auctionId,
          matchId: r.matchId,
          winnerBotId: r.winnerBotId,
          paid: Number(r.paid),
          letter: r.letter,
        }));
    },
    auctionIds(matchId) {
      return [...conn.db.auction.iter()].filter((a) => a.matchId === matchId).map((a) => a.id);
    },
  };
}

let exiting = false;
function finish(conn: DbConnection, code: number, why: string) {
  if (exiting) return;
  exiting = true;
  scheduler?.shutdown(why);
  for (const key of [...matchSubs.keys()]) dropMatch(BigInt(key), 0);
  setTimeout(() => {
    try { conn.disconnect(); } catch { /* already closed */ }
    setTimeout(() => process.exit(code), 500);
  }, 100);
}

function onConnect(conn: DbConnection, identity: Identity, token: string) {
  myIdentity = identity;
  saveToken(token);
  console.log(`[${BOT_NAME}] connected as ${identity.toHexString()}`);

  scheduler = new ClientScheduler({
    strategy,
    state: clientState(conn),
    reducers: {
      submitBid: (auctionId, amount) => conn.reducers.submitBid({ auctionId, amount }),
      submitWord: (matchId, word) => conn.reducers.submitWord({ matchId, word }),
      joinLobby: () => conn.reducers.joinLobby({}),
      registerForTournament: (tournamentId) => conn.reducers.registerForTournament({ tournamentId }),
    },
    timers: {
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    },
    dictionary: DICTIONARY,
    log: telemetry,
    say: (line) => console.log(`[${BOT_NAME}] ${line}`),
    expectedBotId: EXPECTED_BOT_ID === undefined ? undefined : BigInt(EXPECTED_BOT_ID),
    maxMatches: MAX_MATCHES,
    tournamentId: TOURNAMENT_ID === undefined ? undefined : BigInt(TOURNAMENT_ID),
    letterValue: (l) => strategy.LETTER_VALUE[l] ?? 0,
    onFinished: () => finish(conn, 0, "max matches reached"),
    onMatchFinalized: (matchId) => dropMatch(matchId),
    trace: TRACE_DECISIONS,
    traceParams: { ...strategy.DEFAULT_PARAMS },
  });

  // Identity is checked before any gameplay subscription or call.
  const activate = () => {
    if (!scheduler!.setBotId(myBotId)) {
      if (scheduler!.identityMismatch) {
        console.error(
          `[${BOT_NAME}] this token is for bot ${myBotId}, not EXPECTED_BOT_ID ${EXPECTED_BOT_ID}; no gameplay calls made, disconnecting`,
        );
        finish(conn, 3, "identity mismatch");
      }
      return;
    }
    const bot = conn.db.bot.id.find(myBotId!);
    console.log(`[${BOT_NAME}] acting as bot '${bot?.name ?? "?"}' (id ${myBotId})`);
    subscribeMine(conn);
    scheduler!.start();
  };

  conn
    .subscriptionBuilder()
    .onApplied(() => {
      console.log(`[${BOT_NAME}] subscription applied`);

      // Resolve our bot id, possibly after claiming a nonce.
      myBotId = resolveMyBotId(conn);
      if (myBotId === null) {
        if (BOT_NONCE) {
          console.log(`[${BOT_NAME}] claiming credential with nonce…`);
          conn.reducers
            .claimCredential({ code: BOT_NONCE })
            .catch((e: unknown) =>
              console.warn(`[${BOT_NAME}] claiming the credential failed: ${e instanceof Error ? e.message : e}`),
            );
          // Wait briefly for the credential to land; check again.
          setTimeout(() => {
            myBotId = resolveMyBotId(conn);
            if (myBotId === null) {
              console.error(
                `[${BOT_NAME}] couldn't claim credential. Bad / expired nonce?`,
              );
              process.exit(1);
            }
            activate();
          }, 1000);
          return;
        } else {
          console.error(
            `[${BOT_NAME}] no BotCredential for this token. Set BOT_TOKEN or BOT_NONCE and re-run.`,
          );
          process.exit(1);
        }
      }
      activate();
    })
    .subscribe([
      tables.botCredential.where((r) => r.identity.eq(identity)),
      tables.myRack,
      tables.lobby,
      tables.lobbyMember,
    ]);

  conn.db.matchParticipant.onInsert((_ctx, p) => {
    if (scheduler?.canAct() && p.botId === myBotId) subscribeMatch(conn, p.matchId);
  });

  conn.db.auction.onInsert((_ctx: EventContext, a) => {
    if (a.status.tag === "Open") scheduler?.requestBid(a.id, "auction-open");
  });
  conn.db.auction.onUpdate((_ctx, _old, a) => {
    if (a.status.tag !== "Open") scheduler?.onAuctionClosed(a.id);
  });
  // my_rack is a view: a change can arrive as an insert, update or delete.
  conn.db.myRack.onInsert((_ctx, h) => scheduler?.requestWord(h.matchId, "rack"));
  conn.db.myRack.onUpdate((_ctx, _old, h) => scheduler?.requestWord(h.matchId, "rack"));
  conn.db.myRack.onDelete((_ctx, h) => scheduler?.requestWord(h.matchId, "rack"));
  conn.db.botCredential.onInsert(() => {
    if (myBotId === null) myBotId = resolveMyBotId(conn);
  });
  conn.db.auctionResult.onInsert((_ctx, r) => {
    if (myBotId === null) return;
    scheduler?.onAuctionResult({
      auctionId: r.auctionId,
      matchId: r.matchId,
      winnerBotId: r.winnerBotId,
      paid: Number(r.paid),
      letter: r.letter,
    });
    const winner =
      r.winnerBotId !== undefined && r.winnerBotId !== null
        ? String(r.winnerBotId)
        : "no-bid";
    console.log(
      `[${BOT_NAME}] match ${r.matchId} auction ${r.auctionId} '${r.letter}' → bot ${winner} paid ${r.paid}`,
    );
  });

  conn.db.matchState.onUpdate((_ctx, old, neu) => {
    if (myBotId === null || !scheduler) return;
    // Bag shrinking can make cashing out the right call even without a rack change.
    if (neu.status.tag === "Running" && neu.bagTotal !== old.bagTotal) {
      scheduler.requestWord(neu.id, "bag");
    }
    if (old.status.tag !== "Ended" && neu.status.tag === "Ended") {
      const wasIn = Array.from(conn.db.matchParticipant.iter()).some(
        (p) => p.matchId === neu.id && p.botId === myBotId,
      );
      if (wasIn) {
        console.log(`[${BOT_NAME}] match ${neu.id} ended`);
        // Starts the summary, then rejoins or finishes. The match's
        // subscriptions stay until its summary is final (onMatchFinalized).
        if (!scheduler.onMatchEnded(neu.id)) dropMatch(neu.id);
      }
    }
  });
}

function main() {
  console.log(`[${BOT_NAME}] connecting to ${DB_NAME} at ${HOST}`);
  const conn = DbConnection.builder()
    .withUri(HOST)
    .withDatabaseName(DB_NAME)
    .withToken(BOT_TOKEN ?? loadToken())
    .onConnect(onConnect)
    .onConnectError((_ctx: ErrorContext, err: Error) =>
      console.error("connect error:", err.message),
    )
    .onDisconnect(() => {
      scheduler?.shutdown("disconnected");
      console.log("disconnected");
    })
    .build();
  const stop = (signal: string) => {
    console.log(`[${BOT_NAME}] ${signal}: stopping`);
    finish(conn, 130, signal);
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
}

main();
