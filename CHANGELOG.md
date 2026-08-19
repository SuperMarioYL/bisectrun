# Changelog

All notable changes to **BisectRun** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.0] - 2026-08-20

### Fixed

- **Detect `Edit` spans that differ only in `new_string` as a divergence**
  (`src/align.ts`). The `Edit` span fingerprint was
  `Edit:${file_path}|${head(old_string, 60)}` and ignored `new_string`
  entirely, so two runs that edit the same file at the same spot with the
  SAME `old_string` but DIFFERENT `new_string` (the canonical "agent wrote
  the wrong fix to the right spot" case — e.g. one writes `return a + b;`,
  the other `return a - b;`) produced IDENTICAL fingerprints, `align()`
  reported "Runs align completely — no divergence detected", and the
  divergent Edit was counted as matched. This was a silent false-negative
  on the core bisect verdict for exactly the scenario the tool exists to
  locate, and contradicted the README's own "same tool with the same
  intent" matching definition. The fingerprint now also keys on
  `head(new_string, 60)`, so two edits with the same `old_string` but
  different `new_string` (different intent) correctly diverge. Strictly
  more discriminating and non-breaking: existing fixture Edits already
  differ in `old_string`, and `align(failed, failed)` still matches.
- **Stop emitting the full nested `commonPrefix` tree in `--json` CI
  output** (`src/cli.ts`). `--json` mode emitted `JSON.stringify(result)`
  including `commonPrefix: Span[]`, where each `Span` carries its nested
  `children` subtree. Because the common-prefix spans are also linked via
  `children`, the same span serialized O(n) times, so output grew
  QUADRATICALLY with run length (measured N=10→~30KB, N=30→~470KB,
  N=60→~3.1MB), bloating CI logs and parse memory on the feature's primary
  surface. It also contradicted the feature's stated contract: the plan
  says `--json` emits "the exact AlignmentResult the server already serves
  at `/result.json`", but `/result.json` OMITS `commonPrefix` entirely.
  `--json` now serializes the same payload `/result.json` serves
  (`signaturesMatch`, `matchedDepth`, `reason`, `failed`, `good`,
  `firstDivergence`, `goodDivergence` — no `commonPrefix`); `matchedDepth`
  already conveys the matched count for CI consumers. Non-breaking: the
  existing `--json` CLI tests assert only those fields (and
  `firstDivergence` nullness), not `commonPrefix`.

Fixes-only iteration, no new features and no stack/runtime change.

## [0.4.0] - 2026-08-14

### Fixed

- **Stop classifying interrupted/incomplete runs as a successful reference
  baseline** (`src/autocapture.ts`). `isSuccessfulRun` used optional chaining
  (`span.tool_result?.is_error`), so a span with no `tool_result` attached
  (the session ended before a tool's result came back) yielded `undefined`
  (falsy) and the interrupted run passed the success check — letting an
  incomplete run be auto-picked as the "good" reference and producing a wrong
  length-mismatch bisection result. The heuristic now requires every span to
  have a `tool_result` attached (a completed run has results for all of its
  `tool_use` blocks) and rejects incomplete runs before they can be cached as a
  reference baseline.
- **Don't swallow refs-store write failures as "malformed transcript" in
  autocapture** (`src/autocapture.ts`). The per-candidate try/catch (intended
  to skip unreadable/malformed candidate transcripts) also wrapped the
  refs-store write (`mkdirSync` + `copyFileSync`), so a write failure (ENOSPC
  disk full, EACCES on `~/.bisect-run/refs`, EROFS read-only home) was silently
  swallowed and the user got the misleading "no successful matching transcript
  found" message when a matching successful transcript was in fact found but
  could not be cached. The write is now isolated from the parse skip; on write
  failure a clear "could not cache to <store>: <reason>" message surfaces and
  the good run is still resolved via the uncached source candidate path (the
  cache is an optimization, not a requirement).

No new features and no stack/runtime change in this release.

## [0.3.0] - 2026-08-08

### Fixed

- **Fail loudly when a transcript parses to zero spans** instead of a silent
  "no divergence" result (`src/parse-jsonl.ts`). Feeding a garbage / non-JSONL
  file now throws a clear "no parseable transcript records" error; per-line
  tolerance for partial transcript tails is kept intact.
- **Make the autocapture project-dir scan tolerate unreadable entries**
  (`src/autocapture.ts`). A single broken symlink / EACCES-denied / deleted
  entry no longer aborts the entire reference scan; the bad entry is skipped
  so the good transcript is still resolved.

No new features and no stack/runtime change in this release.

## [0.2.0] - 2026-08-04

### Added

- **Auto-capture the last successful Claude Code transcript per task
  signature** (`src/autocapture.ts`, `src/cli.ts`). When `good-session.jsonl`
  is omitted, the reference is auto-resolved from the most recent successful
  matching transcript under `~/.claude/projects/` and cached at
  `~/.bisect-run/refs/<sig>.jsonl`, dropping the manual locate step from ~30s
  to ~0s.

### Fixed

- **Fix the package main/root export pointing at a non-existent `dist/index.js`**
  (`src/index.ts`, `package.json`). Added a minimal `src/index.ts` re-exporting
  the public API so programmatic `import { ... } from "bisectrun"` resolves.
- **Handle the UI server's error event** so a busy port doesn't crash with a
  raw stack trace (`src/server.ts`). `--ui` run a second time on a bound port
  now prints a clear "UI server failed to start" message and exits 1.

### Changed

- Registered the bilingual GitHub Pages product site as a distribution channel.

## [0.1.0] - 2026-07-22

### Added

- **Span-semantic alignment + first-divergence bisect** (`src/parse-jsonl.ts`,
  `src/align.ts`, `src/bisect.ts`). Parse two raw Claude Code session JSONL
  transcripts, derive a span tree per run, run span-semantic alignment, and
  print the first divergence span to stdout.
- **Local diff UI** (`src/server.ts`, `src/ui/`). The `--ui` flag starts a
  local hono server and opens a browser rendering the two derived span trees
  side-by-side with the first divergence span highlighted.

[0.6.0]: https://github.com/SuperMarioYL/bisectrun/releases/tag/v0.6.0
[0.4.0]: https://github.com/SuperMarioYL/bisectrun/releases/tag/v0.4.0
[0.3.0]: https://github.com/SuperMarioYL/bisectrun/releases/tag/v0.3.0
[0.2.0]: https://github.com/SuperMarioYL/bisectrun/releases/tag/v0.2.0
[0.1.0]: https://github.com/SuperMarioYL/bisectrun/releases/tag/v0.1.0
