import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here); // build dir
const cliPath = join(root, "src", "cli.ts");

// fix-version-drift-lockstep — the v0.7.0 release shipped with its version
// surfaces (package.json, CLI --version, --ui footer, CHANGELOG) stuck at
// 0.6.0 while only the VERSION file and the git tag advanced to v0.7.0, so
// `bisect-run --version` and the published package manifest silently
// misreported the shipped code. This guard treats the VERSION file as the
// single source of truth and asserts every version-reporting surface agrees
// with it, so the drift cannot recur silently. RED on any surface
// disagreeing with VERSION; GREEN when all are in lockstep. Self-updating:
// it reads VERSION at run time, so no per-bump literal is needed.

const versionRaw = readFileSync(join(root, "VERSION"), "utf8").trim();
// VERSION is "vX.Y.Z"; strip the leading "v" to match the bare semver the
// other surfaces carry (package.json, CLI --version, CHANGELOG header).
const expected = versionRaw.startsWith("v") ? versionRaw.slice(1) : versionRaw;

test("VERSION file is a parseable vX.Y.Z", () => {
  assert.match(versionRaw, /^v\d+\.\d+\.\d+$/);
  assert.match(expected, /^\d+\.\d+\.\d+$/);
});

test("package.json version is in lockstep with VERSION", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(
    pkg.version,
    expected,
    `package.json version "${pkg.version}" != VERSION "${expected}"`,
  );
});

test("CLI --version output is in lockstep with VERSION", () => {
  const res = spawnSync(process.execPath, ["--import", "tsx", cliPath, "--version"], {
    encoding: "utf8",
    cwd: root,
  });
  assert.equal(res.status, 0, `--version exited ${res.status}; stderr=${res.stderr}`);
  const out = res.stdout.trim();
  // commander prints the raw .version() string for --version; it must equal
  // the VERSION file (the source of truth), not a stale literal.
  assert.equal(out, expected, `CLI --version "${out}" != VERSION "${expected}"`);
});

test("src/cli.ts declares .version() in lockstep with VERSION", () => {
  const src = readFileSync(cliPath, "utf8");
  assert.ok(
    src.includes(`.version("${expected}")`),
    `src/cli.ts does not call .version("${expected}")`,
  );
});

test("src/server.ts --ui footer is in lockstep with VERSION", () => {
  const src = readFileSync(join(root, "src", "server.ts"), "utf8");
  assert.ok(
    src.includes(`BisectRun v${expected}`),
    `src/server.ts footer does not read "BisectRun v${expected}"`,
  );
});

test("CHANGELOG top entry is in lockstep with VERSION", () => {
  const md = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  const m = md.match(/^## \[(\d+\.\d+\.\d+)\]/m);
  assert.ok(m, "CHANGELOG has no ## [x.y.z] header");
  assert.equal(
    m![1],
    expected,
    `CHANGELOG top header [${m![1]}] != VERSION "${expected}"`,
  );
});

// fix-version-lockstep-v0-11-0 — web/site.json is the one live, version-bearing
// surface the v0.8.0 lockstep guard never covered: it declares the shipped
// version twice in two different formats (`content_version: "vX.Y.Z"` at top
// level, `meta.content_version: "X.Y.Z"`). The Pages build publishes it at
// https://bisectrun.lei6393.com, so a bump that misses it ships a page
// advertising a version the repo no longer is. Each field keeps its own format.
test("web/site.json content versions are in lockstep with VERSION", () => {
  const site = JSON.parse(readFileSync(join(root, "web", "site.json"), "utf8"));
  assert.equal(
    site.content_version,
    `v${expected}`,
    `web/site.json content_version "${site.content_version}" != "v${expected}"`,
  );
  assert.equal(
    site.meta?.content_version,
    expected,
    `web/site.json meta.content_version "${site.meta?.content_version}" != "${expected}"`,
  );
});
