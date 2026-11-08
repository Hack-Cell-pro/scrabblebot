# Offline comparison harness

Plays seeded matches between a candidate policy and frozen opponents,
with no network and no SpacetimeDB connection. Results are OFFLINE and
provisional: the harness follows the official module's rules, but it is not
production, and its numbers say nothing definite about live strength.

The older `src/sim.ts` is left as it was. Use this harness for comparisons.

## Run

```sh
cd bot-starter
npm ci --ignore-scripts                       # once
node --import tsx --test src/harness/harness.test.ts
node --import tsx src/harness/run.ts \
  --seeds 101-102 --seats all --mode vickrey \
  --field baseline,baseline,starter,starter,aggr \
  --time-limit-ms 300000 --out /tmp/bench.json
```

| Option | Default | Meaning |
|---|---|---|
| `--seeds` | `101-110` | Seed list, e.g. `101-105` or `101,103`. Seeds 1001-1010 are reserved for evaluation and refused unless `--allow-eval-seeds` is passed. |
| `--field` | five `baseline` | The opponents, in seat order. Kinds: `baseline`, `starter`, `candidate`, `cheap`, `value`, `aggr`. Players = field size + 1. |
| `--seats` | `all` | Seats the candidate takes, one game per seat per seed, e.g. `0,3`. |
| `--mode` | `vickrey` | `vickrey` or `first-price`. |
| `--candidate` | `src/strategy.ts` | Module exporting `decideBid` and `chooseWord` (and optionally `warmUp`). |
| `--word-attempts` | `1` | Word attempts per opportunity (see timing below). |
| `--time-limit-ms` | `300000` | Stops before starting a game once this much time has passed. |
| `--trace` | off | Include each game's full action trace in the output. |
| `--out` | stdout | Where to write the JSON result. |

The run refuses to start while `BID_K`, `BID_PACE`, `BID_DENY`, `CASH`,
`END`, `FV` or `LC` is set, because the frozen baseline would read them too.
To try other parameters, point `--candidate` at a module with different
defaults.

## Policies

- `candidate`: the module under test, run through our live wrapper's
  contract (`bot-starter/src/index.ts`).
- `baseline`: `src/policies/baseline.ts`, a byte-exact copy of our strategy at
  `e576575`, run through the same wrapper contract.
- `starter`: `src/policies/official-starter.ts`, a byte-exact copy of the
  official starter at `b5ccb36`, run through the official starter's wrapper
  contract.
- `cheap`, `value`, `aggr`: the module's Cheapskate, ValueBidder and
  Aggressive sims, played inside the module's transactions as the server does.

The frozen files are checked against pinned SHA-256 hashes on every load.

## Context each policy receives

Only what its live wrapper passes:

- Our wrapper: bid `{letter, myBalance, myRack, dictionary, bagTotal,
  auctionType, players}`; word `{myRack, dictionary, bagTotal, auctionType,
  players}`. No rivals, scores or parameters.
- Official starter wrapper: bid `{letter, myBalance, myRack}`; word
  `{myRack, dictionary}`.

## Reproducibility

The bag order, per-auction tie priorities and sim jitter come from separate
streams seeded from the seed and player count, and are fixed before play.
Unbid tiles are discarded, so policy decisions cannot shift later letters.
`Math.random` is replaced by a seeded stream during each match, for
policies that use it. The JSON `deterministicDigest` covers each game's
seed, seats, per-player results, tile accounting and action-trace hash;
timing is excluded.

## Match order modelled

Per auction:

1. The auction opens and the sims bid (module `simulateBids`).
2. Each external bot bids, then gets its word attempt, during the window.
3. The auction closes, in one transaction: the bids are sorted (ties by the
   round's priority), the winner pays, gets the tile, and if it is a sim it
   plays its longest word of 3+ letters. Then the next letter is drawn, or
   the match ends.

So a sim can use the final letter, but an external bot cannot: the match is
over before it hears about the tile.

## Timing approximations

- **Word attempts.** Our wrapper tries a word when the rack or `bagTotal`
  changes, at most once per 500 ms per match (`WORD_RETRY_MS`). With 1 s
  auctions that is about one attempt per auction, which the harness models as
  exactly one attempt per round, including at match start. The official
  starter tries only when its rack changes (the initial deal or a won
  auction), so it gets an attempt only in those rounds. The attempt that
  follows a played word normally lands inside the 500 ms throttle and is
  skipped; the harness does the same. A slow network could change this.
- **Bid before word.** Within a round the harness asks for the bid first,
  then the word, as the wrapper does at match start (`subscribeMatch`). The
  order of SDK callbacks within one transaction update was not verified.
- **No clock.** Every decision lands inside the auction window, whatever it
  costs. The recorded latency is offline compute time in this process; it
  excludes network, SDK and subscription overhead, and is not part of the
  deterministic digest. Dictionary loading and index warm-up are reported
  separately under `timing.init`.
- **Server randomness** is the same in distribution as the module's
  (`ctx.random`), not the same stream.
- **Admin configuration** (rack size, lobby size, auction length) uses the
  module defaults; live values were not checked.
