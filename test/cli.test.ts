import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here); // build dir
const cliPath = join(root, "src", "cli.ts");
const failedFixture = join(here, "fixtures/failed-session.jsonl");
const goodFixture = join(here, "fixtures/good-session.jsonl");

/** Run the CLI as a subprocess (via tsx) and capture stdout/stderr/status. */
function runCli(args: string[]): { stdout: string; stderr: string; status: number | null } {
  const res = spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
    encoding: "utf8",
    cwd: root,
  });
  return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", status: res.status };
}

// feat-json-ci-output — the --json flag emits a machine-readable
// AlignmentResult (the exact shape the UI server already serves at
// /result.json) to stdout, paired with an OPT-IN exit-code contract that
// applies ONLY in --json mode (the default headless path keeps its
// human-readable output and exit 0/1 semantics unchanged):
//   0 = a divergence span was found (the actionable case a CI gates on),
//   2 = the runs align completely / no divergence (nothing to bisect),
//   1 = error.
test("--json emits a valid JSON AlignmentResult and exits 0 when divergence is found", () => {
  const res = runCli([failedFixture, goodFixture, "--json"]);
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr=${res.stderr}`);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.signaturesMatch, true);
  assert.equal(parsed.matchedDepth, 1);
  assert.equal(parsed.firstDivergence.name, "Edit");
  assert.equal(parsed.firstDivergence.id, "toolu_f2");
  assert.equal(parsed.goodDivergence.id, "toolu_g2");
});

test("--json exits 2 when the runs align completely (no divergence)", () => {
  const res = runCli([goodFixture, goodFixture, "--json"]);
  assert.equal(res.status, 2, `expected exit 2, got ${res.status}; stderr=${res.stderr}`);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.firstDivergence, null);
  assert.equal(parsed.goodDivergence, null);
  assert.match(parsed.reason, /no divergence/i);
});

// The default headless path is fully non-breaking: no --json ⇒ the existing
// human-readable summary and exit 0 semantics are unchanged.
test("default headless path (no --json) still prints human-readable output and exits 0", () => {
  const res = runCli([failedFixture, goodFixture]);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /BisectRun — first divergence/);
  // The default path is human-readable, NOT valid JSON.
  assert.throws(() => JSON.parse(res.stdout));
});

// --ui and --json are two different output modes and cannot both hold.
test("--json and --ui are mutually exclusive (clear message, exit 1)", () => {
  const res = runCli([failedFixture, goodFixture, "--ui", "--json"]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /mutually exclusive/);
});
