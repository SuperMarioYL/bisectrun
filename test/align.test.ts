import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseJsonlText } from "../src/parse-jsonl.js";
import { align, spanFingerprint, signaturesMatch } from "../src/align.js";

const here = dirname(fileURLToPath(import.meta.url));
const failedText = readFileSync(join(here, "fixtures/failed-session.jsonl"), "utf8");
const goodText = readFileSync(join(here, "fixtures/good-session.jsonl"), "utf8");

test("align confirms the two fixtures share a task signature", () => {
  const failed = parseJsonlText(failedText);
  const good = parseJsonlText(goodText);
  assert.equal(signaturesMatch(failed.signature, good.signature), true);
});

test("align locates the first divergence at the Edit step", () => {
  const failed = parseJsonlText(failedText);
  const good = parseJsonlText(goodText);
  const result = align(failed, good);

  assert.equal(result.signaturesMatch, true);
  assert.equal(result.matchedDepth, 1);
  assert.equal(result.firstDivergence?.name, "Edit");
  assert.equal(result.firstDivergence?.id, "toolu_f2");
  assert.equal(result.goodDivergence?.name, "Edit");
  assert.equal(result.goodDivergence?.id, "toolu_g2");
  assert.equal(result.commonPrefix.length, 1);
  assert.equal(result.commonPrefix[0].id, "toolu_f1");
  assert.match(result.reason, /Edit/);
});

test("the divergent Edit spans have distinct fingerprints", () => {
  const failed = parseJsonlText(failedText);
  const good = parseJsonlText(goodText);
  const fEdit = failed.spans.find((s) => s.name === "Edit")!;
  const gEdit = good.spans.find((s) => s.name === "Edit")!;
  assert.notEqual(spanFingerprint(fEdit), spanFingerprint(gEdit));
});

test("align reports identical runs as having no divergence", () => {
  const failed = parseJsonlText(failedText);
  const result = align(failed, failed);
  assert.equal(result.firstDivergence, null);
  assert.equal(result.goodDivergence, null);
  assert.equal(result.matchedDepth, 2);
  assert.match(result.reason, /no divergence/i);
});

test("align flags mismatched signatures", () => {
  const failed = parseJsonlText(failedText);
  const good = parseJsonlText(goodText);
  good.signature.prompt = "do something entirely different";
  const result = align(failed, good);
  assert.equal(result.signaturesMatch, false);
});

// fix-edit-fingerprint-ignores-new-string — the Edit span fingerprint used to
// key on file_path + old_string only and ignore new_string entirely, so two
// runs that edit the same file at the same spot with the SAME old_string but
// DIFFERENT new_string (the canonical "agent wrote the wrong fix to the right
// spot" divergence) produced IDENTICAL fingerprints and align() reported
// "Runs align completely — no divergence detected" — a silent false-negative
// on the core bisect verdict for exactly the scenario this tool exists to
// locate. The fingerprint now also keys on head(new_string). RED on revert
// (fps equal → no divergence), GREEN after.
/** Build a 2-span transcript (Bash + Edit) whose Edit carries the given new_string. */
function editTranscript(newString: string): string {
  const base = { cwd: "/repo/x", gitBranch: "main" };
  return [
    JSON.stringify({ parentUuid: null, uuid: "u1", type: "user", message: { role: "user", content: [{ type: "text", text: "Fix the bug in src/math.ts" }] }, timestamp: "2026-08-20T09:00:00.000Z", ...base }),
    JSON.stringify({ parentUuid: "u1", uuid: "a1", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "run tests" }, { type: "tool_use", id: "tu1", name: "Bash", input: { command: "npm test" } }] }, timestamp: "2026-08-20T09:00:05.000Z", ...base }),
    JSON.stringify({ parentUuid: "a1", uuid: "u2", type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok", is_error: false }] }, timestamp: "2026-08-20T09:00:06.000Z", ...base }),
    JSON.stringify({ parentUuid: "u2", uuid: "a2", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "fix it" }, { type: "tool_use", id: "tu2", name: "Edit", input: { file_path: "src/math.ts", old_string: "return a + b;", new_string: newString } }] }, timestamp: "2026-08-20T09:00:10.000Z", ...base }),
    JSON.stringify({ parentUuid: "a2", uuid: "u3", type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu2", content: "ok", is_error: false }] }, timestamp: "2026-08-20T09:00:11.000Z", ...base }),
  ].join("\n");
}

test("Edit spans with the same old_string but different new_string are detected as a divergence", () => {
  const failed = parseJsonlText(editTranscript("return a - b;"));
  const good = parseJsonlText(editTranscript("return a * b;"));
  assert.equal(signaturesMatch(failed.signature, good.signature), true);

  // The two Edit spans differ ONLY in new_string; their fingerprints must differ.
  const fEdit = failed.spans.find((s) => s.name === "Edit")!;
  const gEdit = good.spans.find((s) => s.name === "Edit")!;
  assert.notEqual(spanFingerprint(fEdit), spanFingerprint(gEdit));

  // The Bash prefix matches; the divergent Edit is the first divergence.
  const result = align(failed, good);
  assert.equal(result.matchedDepth, 1);
  assert.notEqual(result.firstDivergence, null);
  assert.equal(result.firstDivergence!.name, "Edit");
  assert.equal(result.firstDivergence!.id, "tu2");
  assert.equal(result.goodDivergence!.name, "Edit");
  assert.equal(result.goodDivergence!.id, "tu2");
  assert.doesNotMatch(result.reason, /no divergence/i);
});

// fix-write-multiedit-fingerprint-ignores-content — the Write and MultiEdit
// span fingerprints used to key on file_path (+ edit count) only and ignore
// the content/edits payload, so two runs that Write (or MultiEdit) the same
// file with the SAME path/edit-count but DIFFERENT content produced IDENTICAL
// fingerprints and align() reported "Runs align completely — no divergence
// detected" — the same silent false-negative v0.6.0 fixed for Edit, on the
// exact scenario this tool exists to locate. The fingerprints now also key on
// the content/edits head. RED on revert, GREEN after.
/** Build a 2-span transcript (Bash + Write) whose Write carries the given content. */
function writeTranscript(content: string): string {
  const base = { cwd: "/repo/x", gitBranch: "main" };
  return [
    JSON.stringify({ parentUuid: null, uuid: "u1", type: "user", message: { role: "user", content: [{ type: "text", text: "Write src/math.ts" }] }, timestamp: "2026-08-20T09:00:00.000Z", ...base }),
    JSON.stringify({ parentUuid: "u1", uuid: "a1", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "run tests" }, { type: "tool_use", id: "tu1", name: "Bash", input: { command: "npm test" } }] }, timestamp: "2026-08-20T09:00:05.000Z", ...base }),
    JSON.stringify({ parentUuid: "a1", uuid: "u2", type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok", is_error: false }] }, timestamp: "2026-08-20T09:00:06.000Z", ...base }),
    JSON.stringify({ parentUuid: "u2", uuid: "a2", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "write it" }, { type: "tool_use", id: "tu2", name: "Write", input: { file_path: "src/math.ts", content } }] }, timestamp: "2026-08-20T09:00:10.000Z", ...base }),
    JSON.stringify({ parentUuid: "a2", uuid: "u3", type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu2", content: "ok", is_error: false }] }, timestamp: "2026-08-20T09:00:11.000Z", ...base }),
  ].join("\n");
}

test("Write spans with the same file_path but different content are detected as a divergence", () => {
  const failed = parseJsonlText(writeTranscript("export const add = (a, b) => a + b;\n"));
  const good = parseJsonlText(writeTranscript("export const add = (a, b) => a - b;\n"));
  assert.equal(signaturesMatch(failed.signature, good.signature), true);

  // The two Write spans differ ONLY in content; their fingerprints must differ.
  const fWrite = failed.spans.find((s) => s.name === "Write")!;
  const gWrite = good.spans.find((s) => s.name === "Write")!;
  assert.notEqual(spanFingerprint(fWrite), spanFingerprint(gWrite));

  // The Bash prefix matches; the divergent Write is the first divergence.
  const result = align(failed, good);
  assert.equal(result.matchedDepth, 1);
  assert.notEqual(result.firstDivergence, null);
  assert.equal(result.firstDivergence!.name, "Write");
  assert.equal(result.firstDivergence!.id, "tu2");
  assert.equal(result.goodDivergence!.name, "Write");
  assert.equal(result.goodDivergence!.id, "tu2");
  assert.doesNotMatch(result.reason, /no divergence/i);
});

/** Build a 2-span transcript (Bash + MultiEdit) whose MultiEdit carries the given edits payload. */
function multieditTranscript(edits: Array<{ old_string: string; new_string: string }>): string {
  const base = { cwd: "/repo/x", gitBranch: "main" };
  return [
    JSON.stringify({ parentUuid: null, uuid: "u1", type: "user", message: { role: "user", content: [{ type: "text", text: "MultiEdit src/math.ts" }] }, timestamp: "2026-08-20T09:00:00.000Z", ...base }),
    JSON.stringify({ parentUuid: "u1", uuid: "a1", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "run tests" }, { type: "tool_use", id: "tu1", name: "Bash", input: { command: "npm test" } }] }, timestamp: "2026-08-20T09:00:05.000Z", ...base }),
    JSON.stringify({ parentUuid: "a1", uuid: "u2", type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok", is_error: false }] }, timestamp: "2026-08-20T09:00:06.000Z", ...base }),
    JSON.stringify({ parentUuid: "u2", uuid: "a2", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "edit it" }, { type: "tool_use", id: "tu2", name: "MultiEdit", input: { file_path: "src/math.ts", edits } }] }, timestamp: "2026-08-20T09:00:10.000Z", ...base }),
    JSON.stringify({ parentUuid: "a2", uuid: "u3", type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu2", content: "ok", is_error: false }] }, timestamp: "2026-08-20T09:00:11.000Z", ...base }),
  ].join("\n");
}

test("MultiEdit spans with the same file_path and edit count but different edits are detected as a divergence", () => {
  // Both MultiEdits target the same path with one edit on the same old_string;
  // they differ ONLY in the edit's new_string (so edits.length is identical).
  const failed = parseJsonlText(multieditTranscript([{ old_string: "return a + b;", new_string: "return a - b;" }]));
  const good = parseJsonlText(multieditTranscript([{ old_string: "return a + b;", new_string: "return a * b;" }]));
  assert.equal(signaturesMatch(failed.signature, good.signature), true);

  // The two MultiEdit spans differ ONLY in edit content; their fingerprints must differ.
  const fMe = failed.spans.find((s) => s.name === "MultiEdit")!;
  const gMe = good.spans.find((s) => s.name === "MultiEdit")!;
  assert.notEqual(spanFingerprint(fMe), spanFingerprint(gMe));

  // The Bash prefix matches; the divergent MultiEdit is the first divergence.
  const result = align(failed, good);
  assert.equal(result.matchedDepth, 1);
  assert.notEqual(result.firstDivergence, null);
  assert.equal(result.firstDivergence!.name, "MultiEdit");
  assert.equal(result.firstDivergence!.id, "tu2");
  assert.equal(result.goodDivergence!.name, "MultiEdit");
  assert.equal(result.goodDivergence!.id, "tu2");
  assert.doesNotMatch(result.reason, /no divergence/i);
});

test("identical Write and MultiEdit spans share fingerprints and align as no divergence", () => {
  // Behavior-preservation: genuinely-identical spans still collide as "the same"
  // step (the fix is strictly more discriminating, not a different key space).
  const w = parseJsonlText(writeTranscript("same content\n"));
  assert.equal(spanFingerprint(w.spans.find((s) => s.name === "Write")!), spanFingerprint(w.spans.find((s) => s.name === "Write")!));
  assert.equal(align(w, w).firstDivergence, null);

  const m = parseJsonlText(multieditTranscript([{ old_string: "a", new_string: "b" }]));
  assert.equal(spanFingerprint(m.spans.find((s) => s.name === "MultiEdit")!), spanFingerprint(m.spans.find((s) => s.name === "MultiEdit")!));
  assert.equal(align(m, m).firstDivergence, null);
});

// fix-fingerprint-truncation-collisions — the content-aware fingerprints of
// v0.6.0/v0.7.0 were built from head() fragments (first line, first 60-80
// chars), so the "wrong fix to the right spot" divergence they were built to
// catch was STILL silently missed whenever the differing bytes fell past the
// truncation — the norm for real multi-line edits and long Bash commands.
// Every case below produced IDENTICAL fingerprints and align() reported
// "Runs align completely — no divergence detected." on v0.8.0; the
// fingerprint now pairs the readable head with a sha256 digest of the FULL
// semantic key, so each case is caught. RED on revert, GREEN after.

/** Build a single-span transcript invoking the given tool with the given input. */
function singleSpanTranscript(prompt: string, tool: string, input: Record<string, unknown>): string {
  const base = { cwd: "/repo/x", gitBranch: "main" };
  return [
    JSON.stringify({ parentUuid: null, uuid: "u1", type: "user", message: { role: "user", content: [{ type: "text", text: prompt }] }, timestamp: "2026-09-16T09:00:00.000Z", ...base }),
    JSON.stringify({ parentUuid: "u1", uuid: "a1", type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: tool, input }] }, timestamp: "2026-09-16T09:00:05.000Z", ...base }),
    JSON.stringify({ parentUuid: "a1", uuid: "u2", type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok", is_error: false }] }, timestamp: "2026-09-16T09:00:06.000Z", ...base }),
  ].join("\n");
}

/** Assert that two single-span runs differing only in the named tool input
 *  are detected as a divergence (fingerprints differ + align() finds it). */
function assertDivergenceDetected(tool: string, failedInput: Record<string, unknown>, goodInput: Record<string, unknown>): void {
  const failed = parseJsonlText(singleSpanTranscript("do the task", tool, failedInput));
  const good = parseJsonlText(singleSpanTranscript("do the task", tool, goodInput));
  assert.equal(signaturesMatch(failed.signature, good.signature), true);
  assert.notEqual(spanFingerprint(failed.spans[0]), spanFingerprint(good.spans[0]),
    `${tool} spans differing past the head window must have different fingerprints`);
  const result = align(failed, good);
  assert.notEqual(result.firstDivergence, null, `${tool} divergence past the head window must be located, not reported as "no divergence"`);
  assert.equal(result.firstDivergence!.name, tool);
  assert.doesNotMatch(result.reason, /no divergence/i);
}

test("Edit spans whose new_strings share line 1 but differ on line 2 diverge", () => {
  // Same file + old_string; new_strings share the first line (and the first
  // 60 chars) but differ on line 2 — invisible to the v0.8.0 head-based
  // fingerprint, the canonical multi-line "wrong fix to the right spot".
  const old_string = "function add(a, b) {\n  return a + b;\n}";
  assertDivergenceDetected("Edit",
    { file_path: "src/math.ts", old_string, new_string: "function add(a, b) {\n  return a - b;\n}" },
    { file_path: "src/math.ts", old_string, new_string: "function add(a, b) {\n  return a * b;\n}" });
});

test("Write spans whose contents share line 1 but differ later diverge", () => {
  assertDivergenceDetected("Write",
    { file_path: "src/math.ts", content: "export const add = (a, b) => {\n  return a + b;\n};" },
    { file_path: "src/math.ts", content: "export const add = (a, b) => {\n  return a - b;\n};" });
});

test("MultiEdit spans whose SECOND edit differs diverge", () => {
  // JSON.stringify of the edits array is one line, so the v0.8.0 head(.., 60)
  // saw only the beginning of the FIRST edit — the entire second edit was
  // invisible.
  const first = { old_string: "import { x } from \"./x\";", new_string: "import { x } from \"./x\";" };
  assertDivergenceDetected("MultiEdit",
    { file_path: "src/math.ts", edits: [first, { old_string: "  return a + b;", new_string: "  return a - b;" }] },
    { file_path: "src/math.ts", edits: [first, { old_string: "  return a + b;", new_string: "  return a * b;" }] });
});

test("Bash spans with commands differing only after the first 80 chars diverge", () => {
  assertDivergenceDetected("Bash",
    { command: "cd /very/long/working/directory/path/that/goes/on/and/on && npx jest --config=jest.config.js --runInBand" },
    { command: "cd /very/long/working/directory/path/that/goes/on/and/on && npx jest --config=jest.config.js --coverage" });
});

test("TodoWrite spans with same-length but different todo lists diverge", () => {
  // v0.8.0 keyed TodoWrite on todos.length ONLY — two different 2-item plans
  // collided. The fingerprint now digests the full serialized todo list.
  assertDivergenceDetected("TodoWrite",
    { todos: [{ content: "fix parser", status: "in_progress" }, { content: "run tests", status: "pending" }] },
    { todos: [{ content: "fix aligner", status: "in_progress" }, { content: "run tests", status: "pending" }] });
});

test("behavior preservation: identical spans (any length) still share fingerprints and align as no divergence", () => {
  // The digest is over the FULL content, so identical inputs — including
  // multi-line and >80-char ones — still produce identical fingerprints.
  const input = {
    file_path: "src/math.ts",
    old_string: "function add(a, b) {\n  return a + b;\n}",
    new_string: "function add(a, b) {\n  return a - b;\n}",
  };
  const run = parseJsonlText(singleSpanTranscript("do the task", "Edit", input));
  assert.equal(spanFingerprint(run.spans[0]), spanFingerprint(run.spans[0]));
  const result = align(run, run);
  assert.equal(result.firstDivergence, null);
  assert.match(result.reason, /no divergence/i);

  const bashRun = parseJsonlText(singleSpanTranscript("do the task", "Bash", { command: "cd /very/long/path && npx jest --coverage" }));
  assert.equal(align(bashRun, bashRun).firstDivergence, null);
});
