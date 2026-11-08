// Loads the candidate and the frozen opponents as separate modules, and
// checks that the frozen ones are byte-exact.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { simPolicy, type ExternalPolicy, type SeatPolicy, type Wrapper } from "./engine.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BOT_STARTER = path.resolve(HERE, "..", "..");
export const WORDLIST = path.resolve(BOT_STARTER, "..", "spacetimedb", "wordlist.txt");

export const FROZEN = {
  baseline: {
    file: path.resolve(HERE, "..", "policies", "baseline.ts"),
    sha256: "fda09a22e45720bf9d8ea09cd991d97a92d9bd8c89347ffaef55b915b2f53144",
    source: "bot-starter/src/strategy.ts @ e57657588ebfa7d57d68adb5998c74c7d5afad1c",
    wrapper: "goats-live" as Wrapper,
  },
  starter: {
    file: path.resolve(HERE, "..", "policies", "official-starter.ts"),
    sha256: "c6e73dbaf0cb1deeb26822a0d3bf48afd2a0bccc054ddf291e684c1349c2904e",
    source:
      "clockworklabs/scrabblebot bot-starter/src/strategy.ts @ b5ccb36aa238ad16692f8d6af54da15ef9f11324",
    wrapper: "official-starter" as Wrapper,
  },
} as const;

export const DEFAULT_CANDIDATE = path.resolve(BOT_STARTER, "src", "strategy.ts");

/** Env vars that strategy.ts and baseline.ts read when they load. */
export const PARAM_ENV = ["BID_K", "BID_PACE", "BID_DENY", "CASH", "END", "FV", "LC"];

export function sha256File(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function verifyFrozen(file: string, expected: string) {
  const actual = sha256File(file);
  if (actual !== expected) {
    throw new Error(`Frozen policy ${file} has SHA-256 ${actual}, expected ${expected}`);
  }
  return actual;
}

export function assertNoParamEnv(env: NodeJS.ProcessEnv = process.env) {
  const set = PARAM_ENV.filter((k) => env[k] !== undefined);
  if (set.length) {
    throw new Error(
      `Unset ${set.join(", ")}: they would change the frozen baseline's parameters too`,
    );
  }
}

export interface LoadedPolicy {
  id: string;
  file: string;
  sha256: string;
  source: string;
  wrapper: Wrapper;
  module: Record<string, unknown>;
  policy: ExternalPolicy;
}

async function load(id: string, file: string, wrapper: Wrapper, source: string, sha256: string) {
  const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  if (typeof mod.decideBid !== "function" || typeof mod.chooseWord !== "function") {
    throw new Error(`${file} must export decideBid and chooseWord`);
  }
  const policy: ExternalPolicy = {
    kind: "external",
    id,
    wrapper,
    decideBid: mod.decideBid as ExternalPolicy["decideBid"],
    chooseWord: mod.chooseWord as ExternalPolicy["chooseWord"],
  };
  return { id, file, sha256, source, wrapper, module: mod, policy } satisfies LoadedPolicy;
}

export interface Policies {
  candidate: LoadedPolicy;
  baseline: LoadedPolicy;
  starter: LoadedPolicy;
}

export async function loadPolicies(candidateFile = DEFAULT_CANDIDATE): Promise<Policies> {
  assertNoParamEnv();
  const b = FROZEN.baseline;
  const s = FROZEN.starter;
  const baseline = await load("baseline", b.file, b.wrapper, b.source, verifyFrozen(b.file, b.sha256));
  const starter = await load("starter", s.file, s.wrapper, s.source, verifyFrozen(s.file, s.sha256));
  const file = path.resolve(candidateFile);
  const candidate = await load("candidate", file, "goats-live", "working tree", sha256File(file));
  return { candidate, baseline, starter };
}

export const FIELD_KINDS = ["baseline", "starter", "candidate", "cheap", "value", "aggr"] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

export function seatPolicy(kind: FieldKind, p: Policies): SeatPolicy {
  switch (kind) {
    case "baseline":
    case "starter":
    case "candidate":
      return p[kind].policy;
    case "cheap":
    case "value":
    case "aggr":
      return simPolicy(kind);
  }
}

/** Warm each distinct module's index once; returns ms per policy id. */
export function warmUp(p: Policies, dictionary: string[]) {
  const ms: Record<string, number | "none"> = {};
  const seen = new Set<unknown>();
  for (const lp of [p.candidate, p.baseline, p.starter]) {
    const fn = lp.module.warmUp;
    if (typeof fn !== "function") {
      ms[lp.id] = "none";
      continue;
    }
    if (seen.has(lp.module)) {
      ms[lp.id] = 0;
      continue;
    }
    seen.add(lp.module);
    const t = performance.now();
    (fn as (d: string[]) => void)(dictionary);
    ms[lp.id] = Math.round((performance.now() - t) * 1000) / 1000;
  }
  return ms;
}
