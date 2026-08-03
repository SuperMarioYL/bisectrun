import { test } from "node:test";
import assert from "node:assert/strict";
import * as api from "../src/index.js";

test("index re-exports the runtime API from parse-jsonl and align", () => {
  // parse-jsonl surface
  assert.equal(typeof api.parseJsonlFile, "function");
  assert.equal(typeof api.parseJsonlText, "function");
  assert.equal(typeof api.buildRun, "function");
  assert.equal(typeof api.flatten, "function");
  assert.equal(typeof api.sanitizeCwd, "function");
  assert.equal(typeof api.resolveProjectPath, "function");
  // align surface
  assert.equal(typeof api.align, "function");
  assert.equal(typeof api.signaturesMatch, "function");
  assert.equal(typeof api.spanFingerprint, "function");
  assert.equal(typeof api.spansEqual, "function");
});

test("index re-export round-trips a real alignment end-to-end", () => {
  // If the re-exports were broken (e.g. index.ts missing), this would throw
  // at import time and the assertions would never run.
  const failed = api.parseJsonlText('{ "uuid":"u","type":"user","message":{"role":"user","content":[{"type":"text","text":"do thing"}]},"cwd":"/x","gitBranch":"main","timestamp":"2026-01-01T00:00:00.000Z" }\n');
  const good = api.parseJsonlText('{ "uuid":"u","type":"user","message":{"role":"user","content":[{"type":"text","text":"do thing"}]},"cwd":"/x","gitBranch":"main","timestamp":"2026-01-01T00:00:00.000Z" }\n');
  const result = api.align(failed, good);
  assert.equal(api.signaturesMatch(failed.signature, good.signature), true);
  assert.equal(result.matchedDepth, 0);
  assert.equal(result.firstDivergence, null);
});
