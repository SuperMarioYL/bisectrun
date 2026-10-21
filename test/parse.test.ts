import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseJsonlText, parseJsonlFile, flatten, resolveSessionId } from "../src/parse-jsonl.js";
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

// fix-parse-guard-non-transcript-jsonl — a wrong-but-VALID JSONL file (any
// newline-delimited JSON data file) parses to recordCount > 0 with zero
// transcript-shaped records, and before this fix it flowed into align() and
// silently reported "Runs align completely — no divergence detected." with
// exit 0 — the exact "pointed at the wrong file" failure mode the v0.3.0
// guard was built to prevent, surviving it because that guard only fired
// when ZERO JSON lines parsed. The guard now also gates on transcript SHAPE
// (records with a uuid field and/or type "user"/"assistant").
test("parseJsonlFile throws on a valid-JSONL data file (records parse, none are transcript entries)", () => {
  const tmp = join(tmpdir(), `bisect-run-data-${process.pid}-${Date.now()}.jsonl`);
  // Valid JSON lines — but no uuid and no user/assistant type: an .jsonl
  // dataset, not a Claude Code session transcript.
  writeFileSync(tmp, '{"a": 1, "ts": "x"}\n{"b": 2}\n');
  try {
    // Before the fix: no throw, spanCount 0, and two such files aligned to a
    // silent exit-0 "no divergence". RED on v0.8.0, GREEN after.
    assert.throws(
      () => parseJsonlFile(tmp),
      /no parseable transcript records in .*not a Claude Code session JSONL/,
    );
  } finally {
    rmSync(tmp, { force: true });
  }
});

test("the transcript-shape count distinguishes data files from chat-only transcripts", () => {
  // A data file: records parse, none are transcript-shaped.
  const data = parseJsonlText('{"a": 1}\n{"b": 2}\n');
  assert.equal(data.recordCount, 2);
  assert.equal(data.transcriptRecordCount, 0);
  // A chat-only transcript: records parse AND are transcript-shaped (the
  // v0.5.0 protection — chat-only transcripts must NOT throw).
  const chatOnly = parseJsonlText(
    [
      '{"parentUuid":null,"uuid":"u1-x","type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]},"timestamp":"2026-09-16T09:00:00.000Z","cwd":"/r","gitBranch":"main"}',
      '{"parentUuid":"u1-x","uuid":"a1-x","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hello"}]},"timestamp":"2026-09-16T09:00:05.000Z","cwd":"/r","gitBranch":"main"}',
    ].join("\n"),
  );
  assert.equal(chatOnly.recordCount, 2);
  assert.equal(chatOnly.transcriptRecordCount, 2);
});

// fix-cli-session-id-argument — resolveSessionId resolves a bare Claude Code
// session id against ~/.claude/projects/*/ so the CLI argument form its own
// --help promises ("path or Claude Code session id") actually works instead
// of dying with a raw ENOENT naming a file the user never typed.
test("resolveSessionId resolves a bare session id to the unique matching project transcript", () => {
  const home = mkdtempSync(join(tmpdir(), "bisect-run-sid-"));
  const projectDir = join(home, ".claude", "projects", "-repo-x");
  mkdirSync(projectDir, { recursive: true });
  const transcript = join(projectDir, "sess-abc123.jsonl");
  writeFileSync(transcript, failedText);
  try {
    assert.equal(resolveSessionId("sess-abc123", home), transcript);
    // Unknown id: nothing to resolve — caller keeps its existing behavior.
    assert.equal(resolveSessionId("sess-nosuch", home), null);
    // Not id-shaped (path separators): id resolution must not hijack paths.
    assert.equal(resolveSessionId("sub/sess-abc123", home), null);
    assert.equal(resolveSessionId("", home), null);
    // A missing ~/.claude/projects degrades to "nothing to resolve".
    assert.equal(resolveSessionId("sess-abc123", join(home, "no-such-home")), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// fix-cyclic-parentuuid-stack-overflow — buildRun stitches span parents by
// walking the record parentUuid chain with no cycle detection. A JSONL whose
// records reference each other (A.parentUuid=B, B.parentUuid=A), each carrying
// one tool_use, gives both spans a non-null parent, leaves `roots` empty, and
// sends flatten() (and the --ui renderer's treeHtml walk) into unbounded
// recursion: the process died with "Maximum call stack size exceeded" (exit 1)
// on v0.9.0 instead of the clean not-a-transcript diagnostic the parse guards
// promise for malformed input. The parent stitch now breaks cycles, so the
// span tree stays acyclic for every consumer. RED on v0.9.0, GREEN after.
function cyclicTranscript(): string {
  const base = { cwd: "/repo/x", gitBranch: "main" };
  return [
    JSON.stringify({ parentUuid: "a2", uuid: "a1", type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "a" } }] }, timestamp: "2026-09-16T09:00:01.000Z", ...base }),
    JSON.stringify({ parentUuid: "a1", uuid: "a2", type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "tu2", name: "Bash", input: { command: "b" } }] }, timestamp: "2026-09-16T09:00:02.000Z", ...base }),
  ].join("\n");
}

test("a transcript whose records reference each other in parentUuid parses into an acyclic tree", () => {
  const run = parseJsonlText(cyclicTranscript());
  assert.equal(run.spans.length, 2);

  // Every span is reachable from the roots and appears exactly once — the tree
  // is acyclic, so flatten() terminates instead of overflowing the stack.
  const flat = flatten(run.roots);
  assert.deepEqual(
    flat.map((s) => s.id).sort(),
    ["tu1", "tu2"],
  );
  assert.equal(flat.length, run.spans.length);

  // The alignment path (which falls back to the raw span list when roots is
  // empty) must also survive.
  assert.equal(align(run, run).firstDivergence, null);
});

test("a well-formed transcript keeps its parent/child shape after the cycle guard", () => {
  // Behavior preservation: the cycle-break pass must never fire on a valid
  // transcript, so the fixture tree is unchanged.
  const failed = parseJsonlText(failedText);
  const edit = failed.spans.find((s) => s.name === "Edit")!;
  assert.equal(edit.parent, "toolu_f1");
  assert.equal(failed.roots.length, 1);
  assert.equal(flatten(failed.roots).length, failed.spans.length);
});
