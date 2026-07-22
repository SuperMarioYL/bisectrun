import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseJsonlText, flatten } from "../src/parse-jsonl.js";

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
