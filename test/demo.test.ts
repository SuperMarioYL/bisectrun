import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// fix-demo-capture-stale — docs/demo-results.json, web/site.json's
// demo.steps[*].output and the fenced ```text blocks in README.md /
// README.zh-CN.md are checked-in captures of the two demo commands. The v0.9.0
// commit bumped the record's `version` field from 0.8.0 to 0.9.0 without
// re-running the commands, so all five surfaces kept publishing the pre-v0.9.0
// fingerprint text (no #digest) — output the shipped binary cannot produce —
// while declaring version 0.9.0. Nothing guarded the capture, so the drift
// recurred silently at exactly the release that changed fingerprint format.
//
// This file is that guard, and the only owner of the demo-command list. In
// verify mode (plain `npm test`) it runs both demo commands and asserts every
// captured surface equals the live output; with DEMO_CAPTURE=1 (`npm run
// demo:capture`) it rewrites the captures first and then asserts, so an
// intentional output change is re-captured in one command instead of by hand.
//
// The captures record the documented command (`node dist/cli.js ...`); the
// guard runs the same CLI through tsx (`node --import tsx src/cli.ts ...`)
// because CI runs `npm test` before `npm run build`, and the two produce
// byte-identical stdout (verified). Only the loading mechanism differs.

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const cliPath = join(root, "src", "cli.ts");
const FIXTURES = ["test/fixtures/failed-session.jsonl", "test/fixtures/good-session.jsonl"];
const RECORD_PATH = join(root, "docs", "demo-results.json");
const SITE_PATH = join(root, "web", "site.json");
const README_PATHS = [join(root, "README.md"), join(root, "README.zh-CN.md")];
const SCOPE =
  "Offline comparison of the shipped synthetic Claude-style transcripts; no agent is executed and divergence is not causal proof.";

/** The demo commands, in record order. `command` is the documented form users run. */
const DEMO_STEPS: Array<{ command: string; argv: string[] }> = [
  { command: `node dist/cli.js ${FIXTURES.join(" ")} --no-color`, argv: [...FIXTURES, "--no-color"] },
  { command: `node dist/cli.js ${FIXTURES.join(" ")} --json`, argv: [...FIXTURES, "--json"] },
];

const WRITE = process.env.DEMO_CAPTURE === "1";
const versionRaw = readFileSync(join(root, "VERSION"), "utf8").trim();
const version = versionRaw.startsWith("v") ? versionRaw.slice(1) : versionRaw;

/** Run one demo command through the CLI and capture stdout + exit code. */
function runDemo(argv: string[]): { output: string; exitCode: number } {
  const res = spawnSync(process.execPath, ["--import", "tsx", cliPath, ...argv], { encoding: "utf8", cwd: root });
  assert.equal(res.error, undefined, `demo command failed to spawn: ${res.error?.message}`);
  assert.notEqual(res.status, null, `demo command was killed by a signal: ${res.signal}`);
  return { output: res.stdout, exitCode: res.status as number };
}

const live = DEMO_STEPS.map((s) => runDemo(s.argv));

/** The record as it should be for this build. */
function buildRecord() {
  return {
    version,
    scope: SCOPE,
    inputs: FIXTURES.map((path) => ({
      path,
      sha256: createHash("sha256").update(readFileSync(join(root, path))).digest("hex"),
    })),
    steps: DEMO_STEPS.map((s, i) => ({ command: s.command, output: live[i].output, exit_code: live[i].exitCode })),
  };
}

/** Replace the body of the fenced ```text block whose `$ <command>` line matches. */
function patchReadme(text: string, command: string, output: string, label: string): string {
  const marker = `$ ${command}\n`;
  const start = text.indexOf(marker);
  assert.notEqual(start, -1, `${label}: no demo block for "${command}"`);
  const end = text.indexOf("```", start);
  assert.notEqual(end, -1, `${label}: demo block for "${command}" is unterminated`);
  return text.slice(0, start) + marker + output + text.slice(end);
}

if (WRITE) {
  const record = buildRecord();
  writeFileSync(RECORD_PATH, `${JSON.stringify(record, null, 2)}\n`);

  const site = JSON.parse(readFileSync(SITE_PATH, "utf8"));
  record.steps.forEach((step, i) => {
    assert.ok(site.demo?.steps?.[i], `web/site.json: no demo.steps[${i}] to capture into`);
    site.demo.steps[i].output = step.output;
  });
  writeFileSync(SITE_PATH, `${JSON.stringify(site, null, 2)}\n`);

  for (const readme of README_PATHS) {
    let text = readFileSync(readme, "utf8");
    record.steps.forEach((step) => {
      text = patchReadme(text, step.command, step.output, readme);
    });
    writeFileSync(readme, text);
  }
}

test("docs/demo-results.json is a live capture of the shipped binary", () => {
  const record = JSON.parse(readFileSync(RECORD_PATH, "utf8"));
  const expected = buildRecord();
  assert.equal(record.version, expected.version, `demo record version ${record.version} != VERSION ${version}`);
  assert.deepEqual(record.inputs, expected.inputs, "demo record input hashes do not match the fixtures");
  assert.equal(record.steps.length, expected.steps.length);
  expected.steps.forEach((step, i) => {
    assert.equal(record.steps[i].command, step.command);
    assert.equal(record.steps[i].exit_code, step.exit_code, `demo step ${i} exit code is stale`);
    assert.equal(record.steps[i].output, step.output, `demo step ${i} output is stale — run: npm run demo:capture`);
  });
});

test("web/site.json demo steps embed the live output", () => {
  const site = JSON.parse(readFileSync(SITE_PATH, "utf8"));
  live.forEach((step, i) => {
    assert.ok(site.demo?.steps?.[i], `web/site.json: missing demo.steps[${i}]`);
    assert.equal(site.demo.steps[i].output, step.output, `web/site.json demo.steps[${i}].output is stale — run: npm run demo:capture`);
  });
});

test("README demo blocks show the live output", () => {
  for (const readme of README_PATHS) {
    const text = readFileSync(readme, "utf8");
    DEMO_STEPS.forEach((step, i) => {
      assert.ok(
        text.includes(`$ ${step.command}\n${live[i].output}\`\`\``),
        `${readme}: demo block for "${step.command}" is stale — run: npm run demo:capture`,
      );
    });
  }
});
