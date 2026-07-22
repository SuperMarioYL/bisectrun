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
