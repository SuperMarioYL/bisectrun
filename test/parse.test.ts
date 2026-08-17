import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseJsonlText, parseJsonlFile, flatten } from "../src/parse-jsonl.js";
import { align } from "../src/align.js";

const here = dirname(fileURLToPath(import.meta.url));
const failedText = readFileSync(join(here, "fixtures/failed-session.jsonl"), "utf8");
const goodText = readFileSync(join(here, "fixtures/good-session.jsonl"), "utf8");

test("parse derives the task signature from the failed fixture", () => {
  const run = parseJsonlText(failedText);
  assert.equal(run.signature.cwd, "/home/alice/myapp");
  assert.equal(run.signature.gitBranch, "main");
  assert.equal(run.signature.prompt, "Fix the failing test in src/math.ts");
  assert.equal(run.signature.spanCount, 2);
});

test("parse stitches spans into a tree via parentUuid linkage", () => {
  const run = parseJsonlText(failedText);
  assert.equal(run.roots.length, 1);
  const root = run.roots[0];
  assert.equal(root.name, "Bash");
  assert.equal(root.id, "toolu_f1");
  assert.equal(root.parent, null);
  assert.equal(root.children.length, 1);
  assert.equal(root.children[0].name, "Edit");
  assert.equal(root.children[0].id, "toolu_f2");
  assert.equal(root.children[0].parent, "toolu_f1");
});

test("parse attaches tool_result blocks to their spans", () => {
  const failed = parseJsonlText(failedText);
  const good = parseJsonlText(goodText);
  const fRoot = failed.roots[0];
  assert.equal(fRoot.tool_result?.is_error, true);
  assert.match(fRoot.tool_result?.content ?? "", /FAIL/);
  const gRoot = good.roots[0];
  assert.equal(gRoot.tool_result?.is_error, false);
});

test("flatten walks the tree in chronological order", () => {
  const run = parseJsonlText(failedText);
  const flat = flatten(run.roots);
  assert.equal(flat.length, 2);
  assert.equal(flat[0].id, "toolu_f1");
  assert.equal(flat[1].id, "toolu_f2");
});

test("parse tolerates blank and malformed lines", () => {
  const text = failedText + "\n\n{not json}\n";
  const run = parseJsonlText(text);
  assert.equal(run.signature.spanCount, 2);
});

// fix-silent-success-on-unparseable-transcript — a totally garbage / non-JSONL
// file must fail loudly instead of yielding an empty run that align() would
// report as a silent "no divergence" result.
test("parseJsonlFile throws on a non-JSONL file that parses to zero spans (garbage input)", () => {
  const tmp = join(tmpdir(), `bisect-run-garbage-${process.pid}-${Date.now()}.jsonl`);
  writeFileSync(tmp, "this is not json\nso neither is this\n");
  try {
    assert.throws(
      () => parseJsonlFile(tmp),
      /no parseable transcript records in .*not a Claude Code session JSONL/,
    );
  } finally {
    rmSync(tmp, { force: true });
  }
});

test("parseJsonlFile does NOT throw on an empty/whitespace-only file (only non-empty garbage fails)", () => {
  const tmp = join(tmpdir(), `bisect-run-empty-${process.pid}-${Date.now()}.jsonl`);
  writeFileSync(tmp, "   \n\n  \n");
  try {
    const run = parseJsonlFile(tmp);
    assert.equal(run.signature.spanCount, 0);
  } finally {
    rmSync(tmp, { force: true });
  }
});

// fix-parsejsonlfile-spans-vs-records — a valid Claude Code transcript where
// the agent only chatted (no tool_use blocks) parses cleanly (recordCount > 0)
// yet yields spanCount === 0. Before the fix the v0.3.0 guard gated on
// spanCount, so it threw "not a Claude Code session JSONL?" for a legitimate
// chat-only transcript — sending the user down the wrong diagnostic path
// (re-checking file format instead of noticing there are no tool_use blocks
// to bisect). The fix gates on recordCount (parsed JSON lines) instead, so a
// chat-only transcript no longer throws and align() reports no divergence.
test("parseJsonlFile does NOT throw on a chat-only transcript (records present, zero spans)", () => {
  // Same task signature as the failed fixture, but the assistant only emits
  // text — no tool_use blocks, so the run has records but zero spans.
  const chatOnlyText = [
    '{"parentUuid":null,"uuid":"u1-c","type":"user","message":{"role":"user","content":[{"type":"text","text":"Fix the failing test in src/math.ts"}]},"timestamp":"2026-07-22T09:00:00.000Z","cwd":"/home/alice/myapp","gitBranch":"main"}',
    '{"parentUuid":"u1-c","uuid":"a1-c","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Let me think about this approach."}]},"timestamp":"2026-07-22T09:00:05.000Z","cwd":"/home/alice/myapp","gitBranch":"main"}',
  ].join("\n");
  const tmp = join(tmpdir(), `bisect-run-chatonly-${process.pid}-${Date.now()}.jsonl`);
  writeFileSync(tmp, chatOnlyText);
  try {
    // Before the fix this threw "no parseable transcript records ... — not a
    // Claude Code session JSONL?" (spanCount === 0). After the fix it parses
    // cleanly because recordCount === 2 (two valid JSON lines).
    const run = parseJsonlFile(tmp);
    assert.equal(run.recordCount, 2);
    assert.equal(run.signature.spanCount, 0);
    // A legitimate (if boring) chat-only transcript aligns against itself
    // with no divergence — it is NOT "not a Claude Code session JSONL?".
    const result = align(run, run);
    assert.equal(result.firstDivergence, null);
    assert.match(result.reason, /no divergence/i);
  } finally {
    rmSync(tmp, { force: true });
  }
});
