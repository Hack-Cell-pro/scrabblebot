# Frozen policies

These files are byte-exact copies so the harness can compare a changing
candidate (`src/strategy.ts`) against opponents that cannot change with it.
Do not edit them. The harness checks their SHA-256 at load time and refuses
to run if either differs.

| File | Source | SHA-256 |
|---|---|---|
| `baseline.ts` | `bot-starter/src/strategy.ts` at `e57657588ebfa7d57d68adb5998c74c7d5afad1c` | `fda09a22e45720bf9d8ea09cd991d97a92d9bd8c89347ffaef55b915b2f53144` |
| `official-starter.ts` | `bot-starter/src/strategy.ts` at official `clockworklabs/scrabblebot` `b5ccb36aa238ad16692f8d6af54da15ef9f11324` | `c6e73dbaf0cb1deeb26822a0d3bf48afd2a0bccc054ddf291e684c1349c2904e` |

Reproduce:

```sh
git show e57657588ebfa7d57d68adb5998c74c7d5afad1c:bot-starter/src/strategy.ts | shasum -a 256
git show b5ccb36aa238ad16692f8d6af54da15ef9f11324:bot-starter/src/strategy.ts | shasum -a 256
```

`baseline.ts` reads tuning parameters from environment variables (`BID_K`,
`BID_PACE`, `BID_DENY`, `CASH`, `END`, `FV`, `LC`) when it loads, exactly as
`strategy.ts` does. The harness refuses to run while any of them is set, so
the baseline always plays with its frozen defaults.
