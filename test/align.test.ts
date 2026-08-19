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
