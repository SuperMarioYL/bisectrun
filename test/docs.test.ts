import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// fix-readme-fingerprint-prefix-claim — README.md, README.zh-CN.md and
// web/site.json's limitations[0] told users that fingerprints use "bounded
// tool-field prefixes". Since v0.9.0 every content-bearing arm pairs its
// readable head with a sha256 digest of the tool's FULL canonicalized input,
// and v0.10.0 extended that to Read/Glob/Grep/WebFetch/Task/Edit — the v0.10.0
// CHANGELOG says exactly that. The published limitation contradicted both the
// release notes and the shipped align.ts, understating what the tool detects.
// This guard keeps the corrected wording on every published surface.

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);

function read(rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

const STALE_EN = "bounded tool-field prefixes";
const STALE_ZH = "有限前缀";
const CORRECT_EN = "full tool input";
const CORRECT_ZH = "完整工具输入";

test("README.md no longer claims prefixes drive the fingerprint", () => {
  const text = read("README.md");
  assert.ok(!text.includes(STALE_EN), "README.md still says fingerprint discrimination is prefix-based");
  assert.ok(text.includes(CORRECT_EN), "README.md must describe the full-input digest");
});

test("README.zh-CN.md no longer claims prefixes drive the fingerprint", () => {
  const text = read("README.zh-CN.md");
  assert.ok(!text.includes(STALE_ZH), "README.zh-CN.md still says fingerprint discrimination is prefix-based");
  assert.ok(text.includes(CORRECT_ZH), "README.zh-CN.md must describe the full-input digest");
});

test("web/site.json limitations describe the full-input digest in both locales", () => {
  const site = JSON.parse(read("web/site.json"));
  assert.ok(Array.isArray(site.limitations) && site.limitations.length > 0);
  const blob = JSON.stringify(site.limitations);
  assert.ok(!blob.includes(STALE_EN), "site limitations still claim prefix-based fingerprints (en)");
  assert.ok(!blob.includes(STALE_ZH), "site limitations still claim prefix-based fingerprints (zh)");
  assert.ok(blob.includes(CORRECT_EN), "site limitations must describe the full-input digest (en)");
  assert.ok(blob.includes(CORRECT_ZH), "site limitations must describe the full-input digest (zh)");
});
