import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonlText, sanitizeCwd } from "../src/parse-jsonl.js";
import {
  resolveReference,
  isSuccessfulRun,
  refPath,
  signatureHash,
} from "../src/autocapture.js";

const here = dirname(fileURLToPath(import.meta.url));
const failedText = readFileSync(join(here, "fixtures/failed-session.jsonl"), "utf8");
const goodText = readFileSync(join(here, "fixtures/good-session.jsonl"), "utf8");
const failedRun = parseJsonlText(failedText);
const goodRun = parseJsonlText(goodText);

/** Create an isolated fake $HOME for an autocapture run. */
function makeHome(): string {
  return mkdtempSync(join(tmpdir(), "bisect-run-ac-"));
}

/** Seed ~/.claude/projects/<sanitized-cwd>/ with session transcripts. */
function seedProject(home: string, cwd: string, sessions: { uuid: string; text: string }[]): void {
  const dir = join(home, ".claude", "projects", sanitizeCwd(cwd));
  mkdirSync(dir, { recursive: true });
  for (const s of sessions) writeFileSync(join(dir, `${s.uuid}.jsonl`), s.text);
}

test("isSuccessfulRun: good fixture is a usable reference, failed fixture is not", () => {
  assert.equal(isSuccessfulRun(goodRun), true);
  assert.equal(isSuccessfulRun(failedRun), false);
});

test("signatureHash is stable and matches same-task runs", () => {
  const h1 = signatureHash(failedRun.signature);
  const h2 = signatureHash(goodRun.signature); // same cwd/branch/prompt
  assert.equal(h1, h2);
  assert.match(h1, /^[0-9a-f]{16}$/);
});

test("resolveReference copies the most recent successful matching transcript into ~/.bisect-run/refs", () => {
  const home = makeHome();
  seedProject(home, failedRun.signature.cwd, [{ uuid: "sess-good", text: goodText }]);

  const result = resolveReference(failedRun, home);

  assert.equal(result.ok, true);
  assert.equal(result.referencePath, refPath(failedRun.signature, home));
  assert.equal(existsSync(result.referencePath), true);
  // Captured reference must be byte-for-byte the source transcript.
  assert.equal(readFileSync(result.referencePath, "utf8"), goodText);
  assert.match(result.reason, /captured/);
});

test("resolveReference reuses a previously captured reference (cache hit)", () => {
  const home = makeHome();
  seedProject(home, failedRun.signature.cwd, [{ uuid: "sess-good", text: goodText }]);

  const first = resolveReference(failedRun, home);
  assert.equal(first.ok, true);

  // Remove the Claude project dir so a fresh scan could not succeed — the
  // cached ref must short-circuit the lookup.
  rmSync(
    join(home, ".claude", "projects", sanitizeCwd(failedRun.signature.cwd)),
    { recursive: true, force: true },
  );

  const second = resolveReference(failedRun, home);
  assert.equal(second.ok, true);
  assert.equal(second.referencePath, first.referencePath);
  assert.match(second.reason, /cache/);
});

test("resolveReference never uses the failed run as its own reference", () => {
  const home = makeHome();
  // Seed ONLY the failing transcript — it must not be picked as its own ref.
  seedProject(home, failedRun.signature.cwd, [{ uuid: "sess-failed", text: failedText }]);

  const result = resolveReference(failedRun, home);
  assert.equal(result.ok, false);
  assert.equal(result.referencePath, null);
});

test("resolveReference ignores successful transcripts with a different task signature", () => {
  const home = makeHome();
  // A successful run of a DIFFERENT task (different prompt) — must be skipped.
  const otherText = goodText.replace(
    "Fix the failing test in src/math.ts",
    "Refactor the auth module completely",
  );
  seedProject(home, failedRun.signature.cwd, [{ uuid: "sess-other", text: otherText }]);

  const result = resolveReference(failedRun, home);
  assert.equal(result.ok, false);
  assert.equal(result.referencePath, null);
});

test("resolveReference returns a clear hint naming the refs store when nothing resolves", () => {
  const home = makeHome(); // no ~/.claude/projects/... at all
  const result = resolveReference(failedRun, home);

  assert.equal(result.ok, false);
  assert.equal(result.referencePath, null);
  assert.match(result.reason, /could not auto-resolve/i);
  assert.match(result.reason, /\.bisect-run/);
});
