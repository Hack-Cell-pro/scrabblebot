// Checks for candidate-lc7: the low-face bid cap (LC) is lifted only when
// the tile completes a new 7+ letter best word. Run with:
//   node --import tsx --test src/policies/candidate-lc7.test.ts

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import * as B from "./baseline.js";
import * as C from "./candidate-lc7.js";

const raw = fs.readFileSync(new URL("../../../spacetimedb/wordlist.txt", import.meta.url), "utf8");
const DICT = raw.split("\n").map((l) => l.trim().toUpperCase()).filter((l) => l.length >= 2).sort((a, b) => b.length - a.length);
B.warmUp(DICT);
C.warmUp(DICT);

const rack = (s: string) => {
  const r = new Map<string, number>();
  for (const c of s) r.set(c, (r.get(c) ?? 0) + 1);
  return r;
};
const ctx = (r: string, letter: string, over: Record<string, unknown> = {}) => ({
  letter,
  myBalance: 60,
  myRack: rack(r),
  dictionary: DICT,
  bagTotal: 10,
  players: 6,
  auctionType: "Vickrey",
  ...over,
});
const both = (r: string, l: string, over: Record<string, unknown> = {}) =>
  [B.decideBid(ctx(r, l, over)), C.decideBid(ctx(r, l, over))] as const;

// Recorded live trace contexts (six players, Vickrey, full dictionary).
// [word, rack, letter, balance, bagTotal, original@PACE6, lc7@PACE6, lc7@PACE3]
const TRACE: [string, string, string, number, number, number, number, number][] = [
  ["ATTABOY", "AABIOOTY", "T", 61, 51, 12, 41, 37],
  ["POTABLE", "BELOPT", "A", 20, 10, 12, 20, 20],
  ["EVERMORE", "EEEMORV", "R", 14, 11, 12, 14, 14],
  ["EVERMORE", "EEEMORV", "R", 14, 9, 12, 14, 14],
];

test("recorded trace contexts replayed at PACE=6 match the trace (capped at 12)", () => {
  for (const [w, r, l, myBalance, bagTotal, orig6, lc76] of TRACE) {
    const over = { myBalance, bagTotal, params: { PACE: 6 } };
    assert.equal(B.decideBid(ctx(r, l, over)), orig6, `${w}: original at PACE=6`);
    assert.equal(C.decideBid(ctx(r, l, over)), lc76, `${w}: candidate at PACE=6`);
  }
});

test("recorded trace contexts at the candidate's default PACE=3 lift the cap", () => {
  assert.equal(C.DEFAULT_PARAMS.PACE, 3);
  for (const [w, r, l, myBalance, bagTotal, , , lc73] of TRACE) {
    const c = C.decideBid(ctx(r, l, { myBalance, bagTotal }));
    assert.equal(c, lc73, w);
    assert.ok(c > 12 && Number.isInteger(c) && c <= myBalance, `${w}: ${c}`);
    assert.equal(B.decideBid(ctx(r, l, { myBalance, bagTotal })), 12, `${w}: original capped`);
  }
});

test("an already-playable 7-letter word does not lift the cap for a trivial extension", () => {
  // REMOVER is playable; +S only extends it.
  assert.deepEqual(both("REMOVER", "S"), [B.decideBid(ctx("REMOVER", "S")), 12]);
});

test("irrelevant letters and all other contexts keep the original bid", () => {
  const lettersSeen = new Set<string>();
  const can = (w: string, r: Map<string, number>) => {
    const c = new Map(r);
    for (const ch of w) {
      const n = c.get(ch) ?? 0;
      if (!n) return false;
      c.set(ch, n - 1);
    }
    return true;
  };
  let s = 12345;
  const rand = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const BAG = "AAAAAAAAABBCCDDDDEEEEEEEEEEEEFFGGGHHIIIIIIIIIJKLLLLMMNNNNNNOOOOOOOOPPQRRRRRRSSSSTTTTTTUUUUVVWWXYYZ";
  let differ = 0;
  for (let i = 0; i < 300; i++) {
    let r = "";
    for (let k = 0, n = 3 + Math.floor(rand() * 8); k < n; k++) r += BAG[Math.floor(rand() * BAG.length)];
    const l = BAG[Math.floor(rand() * BAG.length)]!;
    const over = { myBalance: Math.floor(rand() * 120), bagTotal: Math.floor(rand() * 60) };
    const [o, c] = both(r, l, over);
    lettersSeen.add(l);
    if (o === c) continue;
    differ++;
    // Any difference must be the lifted cap on a new 7+ letter completion.
    const before = rack(r);
    const after = rack(r + l);
    assert.equal(o, 12, `${r}+${l}`);
    assert.ok(c > 12);
    assert.ok(DICT.some((w) => w.length >= 7 && can(w, after) && !can(w, before)));
    // The best-reward word playable before the tile is shorter than 7.
    let best = "";
    for (const w of DICT) if (can(w, before) && C.wordReward(w) > C.wordReward(best)) best = w;
    assert.ok(best.length < 7, `${r}+${l}: best before was ${best}`);
  }
  assert.ok(differ < 300);
  assert.deepEqual(both("BELOPT", "Q"), [4, 4]);
  assert.deepEqual(both("BELOPT", "E"), [B.decideBid(ctx("BELOPT", "E")), B.decideBid(ctx("BELOPT", "E"))]);
});

test("low balances, integer bids and first-price shading", () => {
  for (const bal of [0, 1, 8, 13]) {
    const c = C.decideBid(ctx("BELOPT", "A", { myBalance: bal }));
    assert.ok(Number.isInteger(c) && c >= 0 && c <= bal, `balance ${bal}: ${c}`);
  }
  const [o, c] = both("BELOPT", "A", { auctionType: "FirstPrice" });
  const vick = C.decideBid(ctx("BELOPT", "A"));
  assert.ok(Number.isInteger(c) && c >= o && c <= vick, `first price ${c} (vickrey ${vick}, original ${o})`);
  // bag <= 2 already bids the whole balance in both.
  assert.deepEqual(both("BELOPT", "A", { bagTotal: 2 }), [60, 60]);
});

test("no extra dictionary scans: decideBid makes the same scan calls", () => {
  const body = (file: string) => {
    const src = fs.readFileSync(new URL(file, import.meta.url), "utf8");
    const start = src.indexOf("export function decideBid");
    return src.slice(start, src.indexOf("\n}\n", start)).match(/scan\(/g)?.length;
  };
  assert.equal(body("../strategy.ts"), 4);
  assert.equal(body("./candidate-lc7.ts"), body("../strategy.ts"));
  assert.deepEqual(C.DEFAULT_PARAMS, B.DEFAULT_PARAMS);
  // Word selection is untouched.
  assert.equal(
    C.chooseWord({ myRack: rack("BELOPTA"), dictionary: DICT, bagTotal: 10, players: 6 }),
    B.chooseWord({ myRack: rack("BELOPTA"), dictionary: DICT, bagTotal: 10, players: 6 }),
  );
});
