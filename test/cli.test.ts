import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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

// fix-json-ci-quadratic-bloat — --json used to emit the full AlignmentResult
// including commonPrefix: Span[], whose members are the same Span objects also
// linked via their nested children subtree, so JSON.stringify(result) grew
// QUADRATICALLY with run length (measured N=10→~30KB, N=30→~470KB,
// N=60→~3.1MB), bloating CI logs on this feature's primary surface. It also
// contradicted the stated /result.json parity contract (the server OMITS
// commonPrefix). --json now serializes the same payload /result.json serves.
// RED on revert (full result → output contains commonPrefix and is O(n^2)),
// GREEN after (no commonPrefix, O(1) for aligned runs).

/** Build a transcript whose n Bash spans form a single deep chain (each span
 * is the child of the previous one), so a serialized commonPrefix carries the
 * whole nested tree and grows O(n^2). Used to verify --json output is O(n),
 * not O(n^2). */
function nestedTranscript(n: number): string {
  const base = { cwd: "/repo/nested", gitBranch: "main" };
  const ts = (i: number) =>
    `2026-08-20T09:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`;
  const lines: string[] = [
    JSON.stringify({
      parentUuid: null,
      uuid: "u0",
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "run nested bash steps" }] },
      timestamp: ts(0),
      ...base,
    }),
  ];
  let prev = "u0";
  let t = 1;
  for (let i = 0; i < n; i++) {
    const aUuid = `a${i}`;
    const uUuid = `ur${i}`;
    const tuId = `tu${i}`;
    lines.push(
      JSON.stringify({
        parentUuid: prev,
        uuid: aUuid,
        type: "assistant",
        message: { role: "assistant", content: [{ type: "tool_use", id: tuId, name: "Bash", input: { command: `echo step ${i}` } }] },
        timestamp: ts(t),
        ...base,
      }),
    );
    t++;
    lines.push(
      JSON.stringify({
        parentUuid: aUuid,
        uuid: uUuid,
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: tuId, content: "ok", is_error: false }] },
        timestamp: ts(t),
        ...base,
      }),
    );
    t++;
    prev = uUuid;
  }
  return lines.join("\n");
}

test("--json omits commonPrefix (mirrors /result.json, no quadratic bloat)", () => {
  const n = 40; // a single deep chain of nested Bash spans
  const text = nestedTranscript(n);
  const dir = mkdtempSync(join(tmpdir(), "bisectrun-json-"));
  const failedPath = join(dir, "failed.jsonl");
  const goodPath = join(dir, "good.jsonl");
  try {
    writeFileSync(failedPath, text);
    writeFileSync(goodPath, text);
    const res = runCli([failedPath, goodPath, "--json"]);
    // Identical runs align completely → --json exits 2 (no divergence).
    assert.equal(res.status, 2, `expected exit 2, got ${res.status}; stderr=${res.stderr}`);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.firstDivergence, null);
    assert.equal(parsed.goodDivergence, null);
    // The /result.json-shape payload conveys the matched count via matchedDepth
    // instead of the nested commonPrefix tree.
    assert.equal(parsed.matchedDepth, n);
    assert.ok(!/"commonPrefix"/.test(res.stdout), "--json output must NOT carry the commonPrefix field");
    // With commonPrefix omitted, output is O(1) in the run length, not O(n^2).
    // (On the reverted build, N=40 nested spans serialize to ~1MB+.)
    assert.ok(res.stdout.length < 50_000, `--json output should be small, got ${res.stdout.length} bytes`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
