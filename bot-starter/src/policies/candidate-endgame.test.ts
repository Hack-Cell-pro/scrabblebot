// Checks for the endgame-planning candidate. Run with:
//   node --import tsx --test src/policies/candidate-endgame.test.ts

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import * as B from "./baseline.js";
import * as C from "./candidate-endgame.js";

const raw = fs.readFileSync(
  new URL("../../../spacetimedb/wordlist.txt", import.meta.url),
  "utf8",
);
const DICT = raw
  .split("\n")
  .map((l) => l.trim().toUpperCase())
  .filter((l) => l.length >= 2)
  .sort((a, b) => b.length - a.length);
const VALID = new Set(raw.split("\n").filter((l) => l.length > 0));
C.warmUp(DICT);
B.warmUp(DICT);

const rack = (letters: string) => {
  const r = new Map<string, number>();
  for (const c of letters) r.set(c, (r.get(c) ?? 0) + 1);
  return r;
};
const spend = (r: Map<string, number>, w: string) => {
  for (const c of w) {
    const n = (r.get(c) ?? 0) - 1;
    assert.ok(n >= 0, `'${w}' uses more '${c}' than the rack holds`);
    if (n === 0) r.delete(c);
    else r.set(c, n);
  }
};

/** Play out the endgame: one chooseWord call per remaining opportunity. */
function playOut(
  choose: typeof C.chooseWord,
  letters: string,
  bagTotal: number,
  players = 6,
) {
  const r = rack(letters);
  const words: string[] = [];
  for (let bag = bagTotal; bag >= 0; bag--) {
    const w = choose({ myRack: new Map(r), dictionary: DICT, bagTotal: bag, players });
    if (!w) continue;
    assert.ok(VALID.has(w), `${w} is in the dictionary`);
    spend(r, w);
    words.push(w);
  }
  const total = words.reduce((a, w) => a + C.wordReward(w), 0);
  return { words, total };
}

/** Deterministic pseudo-random generator for test inputs. */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}
const BAG = "AAAAAAAAABBCCDDDDEEEEEEEEEEEEFFGGGHHIIIIIIIIIJKLLLLMMNNNNNNOOOOOOOOPPQRRRRRRSSSSTTTTTTUUUUVVWWXYYZ";
function randomRack(rand: () => number, n: number) {
  const tiles = [...BAG];
  let s = "";
  for (let i = 0; i < n; i++) s += tiles.splice(Math.floor(rand() * tiles.length), 1)[0];
  return s;
}

test("DINMJYAMETTO: plays JOINTED then TAMMY (69) instead of ADJOINT + MEM (52)", () => {
  const before = playOut(B.chooseWord, "DINMJYAMETTO", 2);
  assert.deepEqual(before, { words: ["ADJOINT", "MEM"], total: 52 });
  const after = playOut(C.chooseWord, "DINMJYAMETTO", 2);
  assert.deepEqual(after, { words: ["JOINTED", "TAMMY"], total: 69 });
});

test("repeated letters are counted and the input rack is not mutated", () => {
  const input = rack("MMMEEOOTT");
  const copy = new Map(input);
  const w = C.chooseWord({ myRack: input, dictionary: DICT, bagTotal: 3, players: 6 });
  const plan = C.planEndgame(input, DICT, 4);
  assert.deepEqual(input, copy);
  assert.equal(w, plan.words[0]);
  const left = new Map(input);
  for (const x of plan.words) spend(left, x);
  assert.equal(plan.total, plan.words.reduce((a, x) => a + C.wordReward(x), 0));
});

test("one opportunity left: the best word that scores now", () => {
  for (const letters of ["DINMJYAMETTO", "QUIZAEST", "AEIRSTLNOUDGBCM"]) {
    const w = C.chooseWord({ myRack: rack(letters), dictionary: DICT, bagTotal: 0, players: 6 });
    const o = B.chooseWord({ myRack: rack(letters), dictionary: DICT, bagTotal: 0, players: 6 });
    assert.ok(w && o);
    assert.equal(C.wordReward(w), C.wordReward(o), letters);
    assert.equal(C.planEndgame(rack(letters), DICT, 1).total, C.wordReward(o));
  }
});

test("a word may be planned twice when the tiles allow", () => {
  const dict = ["CAT", "AT"];
  assert.deepEqual(C.planEndgame(rack("CATCAT"), dict, 2), {
    words: ["CAT", "CAT"],
    total: 10,
    exact: true,
    checks: C.planEndgame(rack("CATCAT"), dict, 2).checks,
  });
  assert.deepEqual(C.planEndgame(rack("CATCAT"), dict, 1).words, ["CAT"]);
});

test("empty and unplayable racks play nothing", () => {
  for (const letters of ["", "Q", "XZ", "BCDFG"]) {
    assert.equal(
      C.chooseWord({ myRack: rack(letters), dictionary: DICT, bagTotal: 1, players: 6 }),
      null,
      JSON.stringify(letters),
    );
  }
  assert.deepEqual(C.planEndgame(rack(""), DICT, 3).words, []);
  assert.deepEqual(C.planEndgame(rack("CAT"), DICT, 0).words, []);
});

test("12-20 tile racks: legal plans within the budget, never below greedy", (t) => {
  const rand = lcg(20261107);
  for (const n of [12, 14, 16, 18, 20]) {
    const letters = randomRack(rand, n);
    for (const k of [3, 7]) {
      const start = performance.now();
      const plan = C.planEndgame(rack(letters), DICT, k);
      const ms = performance.now() - start;
      t.diagnostic(`${n} tiles K=${k}: total ${plan.total} exact=${plan.exact} checks=${plan.checks} ${ms.toFixed(1)} ms`);
      assert.ok(plan.checks <= C.ENDGAME_CHECK_LIMIT);
      assert.ok(plan.words.length <= k);
      const left = rack(letters);
      for (const w of plan.words) {
        assert.ok(VALID.has(w));
        spend(left, w);
      }
      const greedy = playOut(B.chooseWord, letters, k - 1);
      assert.ok(plan.total >= greedy.total, `${letters} K=${k}: ${plan.total} < greedy ${greedy.total}`);
      // A tiny budget still returns a legal plan, at least the greedy one.
      const capped = C.planEndgame(rack(letters), DICT, k, 50);
      if (!capped.exact) assert.ok(capped.total >= greedy.total);
      const l2 = rack(letters);
      for (const w of capped.words) spend(l2, w);
    }
  }
  const forced = C.planEndgame(rack("AEIOURSTLNDGMPBCHW"), DICT, 7, 50);
  assert.equal(forced.exact, false, "a 50-check budget cannot finish an 18-tile search");
  assert.ok(forced.words.length > 0);
});

test("outside the endgame, decisions match the original strategy", () => {
  const rand = lcg(42);
  for (let i = 0; i < 150; i++) {
    const letters = randomRack(rand, 3 + Math.floor(rand() * 10));
    const players = 2 + Math.floor(rand() * 5);
    const bagTotal = Math.max(3, players) + 1 + Math.floor(rand() * 60);
    const ctx = () => ({ myRack: rack(letters), dictionary: DICT, bagTotal, players });
    assert.equal(C.chooseWord(ctx()), B.chooseWord(ctx()), `${letters} bag ${bagTotal}`);
    // Fallback branch without bag information.
    assert.equal(
      C.chooseWord({ myRack: rack(letters), dictionary: DICT }),
      B.chooseWord({ myRack: rack(letters), dictionary: DICT }),
    );
    // Bidding is unchanged everywhere, endgame included.
    const letter = BAG[Math.floor(rand() * BAG.length)]!;
    for (const bag of [bagTotal, Math.floor(rand() * 7)]) {
      const bid = () => ({
        letter,
        myBalance: Math.floor(rand() * 150),
        myRack: rack(letters),
        dictionary: DICT,
        bagTotal: bag,
        players,
        auctionType: "Vickrey",
      });
      const b = bid();
      assert.equal(C.decideBid(b), B.decideBid({ ...b, myRack: rack(letters) }));
    }
  }
  assert.deepEqual(C.DEFAULT_PARAMS, B.DEFAULT_PARAMS);
});
