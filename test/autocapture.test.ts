import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  chmodSync,
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

// fix-autocapture-scan-skip-bad-entries — a single unreadable entry (broken
// symlink) in the project dir must be skipped, not abort the whole scan.
test("resolveReference tolerates an unreadable (broken-symlink) entry in the project dir", () => {
  const home = makeHome();
  const cwd = failedRun.signature.cwd;
  const dir = join(home, ".claude", "projects", sanitizeCwd(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "sess-good.jsonl"), goodText);
  // A broken symlink — statSync throws ENOENT, must not abort the scan.
  symlinkSync(join(dir, "does-not-exist.jsonl"), join(dir, "broken-link.jsonl"));

  const result = resolveReference(failedRun, home);

  assert.equal(result.ok, true);
  assert.equal(result.referencePath, refPath(failedRun.signature, home));
  assert.equal(existsSync(result.referencePath), true);
  // The good transcript is still resolved byte-for-byte despite the bad entry.
  assert.equal(readFileSync(result.referencePath, "utf8"), goodText);
  assert.match(result.reason, /captured/);
});

// fix-isSuccessfulRun-incomplete-run — an interrupted/incomplete run (a span
// with NO tool_result attached because the session ended before the result came
// back) must NOT be classified as a successful reference. Before the fix,
// optional chaining (tool_result?.is_error) yielded undefined (falsy) for the
// missing result, so the interrupted run passed the success check and was
// auto-picked as the "good" baseline — producing a wrong core bisection
// result (a length-mismatch masquerading the interruption as an extra failed
// step).
//
// Same task signature as the failed fixture, no errored spans, but the final
// tool_use has NO matching tool_result record.
const interruptedText = [
  '{"parentUuid":null,"uuid":"u1-i","type":"user","message":{"role":"user","content":[{"type":"text","text":"Fix the failing test in src/math.ts"}]},"timestamp":"2026-07-22T08:00:00.000Z","cwd":"/home/alice/myapp","gitBranch":"main"}',
  '{"parentUuid":"u1-i","uuid":"a1-i","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Let me run the tests first."},{"type":"tool_use","id":"toolu_i1","name":"Bash","input":{"command":"npm test"}}]},"timestamp":"2026-07-22T08:00:05.000Z","cwd":"/home/alice/myapp","gitBranch":"main"}',
  '{"parentUuid":"a1-i","uuid":"u2-i","type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_i1","content":"PASS src/math.test.ts","is_error":false}]},"timestamp":"2026-07-22T08:00:09.000Z","cwd":"/home/alice/myapp","gitBranch":"main"}',
  '{"parentUuid":"u2-i","uuid":"a3-i","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Locking it in."},{"type":"tool_use","id":"toolu_i2","name":"Edit","input":{"file_path":"src/math.ts","old_string":"  return a - b;","new_string":"  return a - b;"}}]},"timestamp":"2026-07-22T08:00:12.000Z","cwd":"/home/alice/myapp","gitBranch":"main"}',
].join("\n");

test("isSuccessfulRun rejects an interrupted/incomplete run (a span with no tool_result)", () => {
  const interrupted = parseJsonlText(interruptedText);
  assert.equal(interrupted.spans.length, 2);
  // The first span completed (its tool_use has a matching tool_result record).
  assert.notEqual(interrupted.spans[0].tool_result, undefined);
  assert.equal(interrupted.spans[0].tool_result?.is_error, false);
  // The second span's tool_use has NO matching tool_result record — the run
  // was interrupted before the Edit result came back.
  assert.equal(interrupted.spans[1].tool_result, undefined);
  // Before the fix this returned true (optional chaining hid the missing
  // result); it must now return false so incomplete runs are never cached as
  // the reference baseline.
  assert.equal(isSuccessfulRun(interrupted), false);
});

test("resolveReference does not pick an interrupted run as the reference baseline", () => {
  const home = makeHome();
  // Seed ONLY the interrupted transcript — same task signature as the failed
  // run, no errored spans, but incomplete (a span with no tool_result). Before
  // the fix this was auto-picked as the "good" reference via the default
  // auto-resolve happy path; it must now be rejected as not successful.
  seedProject(home, failedRun.signature.cwd, [{ uuid: "sess-interrupted", text: interruptedText }]);

  const result = resolveReference(failedRun, home);

  assert.equal(result.ok, false);
  assert.equal(result.referencePath, null);
  assert.match(result.reason, /no successful matching transcript/i);
});

// fix-autocapture-swallow-refs-write — a refs-store write failure (EACCES on
// ~/.bisect-run/refs) must NOT be swallowed as a "malformed transcript" skip
// that falls through to the misleading "no successful matching transcript
// found" message. The matched good run is still resolved via the uncached
// source candidate path (the cache is an optimization, not a requirement),
// with a clear message naming the store and the write failure.
test("resolveReference surfaces a refs-store write failure instead of swallowing it (uncached fallback)", () => {
  const home = makeHome();
  const cwd = failedRun.signature.cwd;
  seedProject(home, cwd, [{ uuid: "sess-good", text: goodText }]);

  // Pre-create the refs store as a read-only directory so copyFileSync throws
  // EACCES. mkdirSync(recursive) is idempotent on an existing dir (no throw),
  // so the failure lands on copyFileSync — exactly the swallowed write path
  // the fix targets.
  const store = join(home, ".bisect-run", "refs");
  mkdirSync(store, { recursive: true });
  chmodSync(store, 0o500);

  let result;
  try {
    result = resolveReference(failedRun, home);
  } finally {
    chmodSync(store, 0o700); // restore so the temp home can be removed
  }

  // The good run WAS found — it must not be reported as missing.
  assert.equal(result.ok, true);
  // Falls back to the uncached source candidate path (cache is optional).
  assert.equal(
    result.referencePath,
    join(home, ".claude", "projects", sanitizeCwd(cwd), "sess-good.jsonl"),
  );
  assert.match(result.reason, /could not cache/i);
  assert.match(result.reason, /\.bisect-run/);
});
