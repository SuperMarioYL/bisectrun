/**
 * autocapture — auto-resolve a reference (last successful) Claude Code
 * transcript for a given task signature, dropping the manual
 * `good-session.jsonl` locate step named in the base plan §3.
 *
 * Claude Code writes one transcript per session to
 *   ~/.claude/projects/<sanitized-cwd>/<session-uuid>.jsonl
 *
 * When the CLI is invoked with only the failing transcript, this module:
 *   1. Derives the failed run's task signature ({@link RunSignature}).
 *   2. Looks for a previously captured reference at
 *      ~/.bisect-run/refs/<sig>.jsonl and reuses it if present.
 *   3. Otherwise scans ~/.claude/projects/<sanitized-cwd>/ for the most
 *      recent *successful* transcript whose signature matches the failed
 *      run's, copies it to ~/.bisect-run/refs/<sig>.jsonl, and returns it.
 *   4. If no reference is resolvable, returns a clear hint so the CLI can
 *      exit non-zero with an actionable message.
 *
 * "Successful" is a heuristic (consistent with the project's explicit
 * "heuristic, not proven causation" stance): a run with at least one span
 * and no `tool_result` flagged `is_error`. The run being debugged is
 * excluded by span-id overlap so a failed run is never used as its own
 * reference.
 */

import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { parseJsonlFile, sanitizeCwd, type ParsedRun } from "./parse-jsonl.js";
import { signaturesMatch } from "./align.js";
import type { RunSignature } from "./types.js";

/** Resolve a writable reference-store directory under the user's home. */
export function refsDir(home: string = homedir()): string {
  return join(home, ".bisect-run", "refs");
}

/** Normalize a prompt fragment the way {@link signaturesMatch} compares it. */
function normalizePrompt(p: string): string {
  return p.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Compute a stable signature hash for a run. Encodes the same triple
 * {@link signaturesMatch} checks (cwd + gitBranch + normalized prompt) so a
 * reference is only reused for runs that are genuinely the same task.
 */
export function signatureHash(sig: RunSignature): string {
  const material = [sig.cwd, sig.gitBranch ?? "", normalizePrompt(sig.prompt)].join("\n");
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

/** Resolve the on-disk reference path for a run's signature. */
export function refPath(sig: RunSignature, home: string = homedir()): string {
  return join(refsDir(home), `${signatureHash(sig)}.jsonl`);
}

/**
 * Heuristic: is this parsed run a usable *successful* reference?
 * True when the run produced at least one span and no tool_result was an
 * error. This is intentionally a heuristic, not proven success.
 */
export function isSuccessfulRun(run: ParsedRun): boolean {
  if (run.spans.length === 0) return false;
  for (const span of run.spans) {
    if (span.tool_result?.is_error) return false;
  }
  return true;
}

/** The outcome of an auto-resolve attempt. */
export interface AutocaptureResult {
  /** Whether a usable reference transcript was located. */
  ok: boolean;
  /** Absolute path to the reference transcript, or null when unresolved. */
  referencePath: string | null;
  /** One-line, human-readable explanation (always set). */
  reason: string;
}

/**
 * Resolve a reference transcript for the failed run, capturing from the
 * Claude Code project directory if no cached reference exists yet.
 *
 * @param failedRun the failing run (signature + spans used for matching/exclusion)
 * @param home optional home override (defaults to `os.homedir()`; injectable for tests)
 */
export function resolveReference(failedRun: ParsedRun, home: string = homedir()): AutocaptureResult {
  const sig = failedRun.signature;
  const ref = refPath(sig, home);

  if (existsSync(ref)) {
    return {
      ok: true,
      referencePath: ref,
      reason: `reference resolved from cache at ${ref}`,
    };
  }

  const projectDir = join(home, ".claude", "projects", sanitizeCwd(sig.cwd));
  if (!existsSync(projectDir)) {
    return unresolved(sig, home, `no Claude Code project directory at ${projectDir}`);
  }

  const failedIds = new Set(failedRun.spans.map((s) => s.id));

  // Most recent first — the "last successful" run is the freshest match.
  const candidates = readdirSync(projectDir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const path = join(projectDir, f);
      return { path, mtime: statSync(path).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);

  for (const c of candidates) {
    try {
      const run = parseJsonlFile(c.path);
      if (run.spans.length === 0) continue;
      // Exclude the failed run itself (it may live in the same project dir).
      if (run.spans.some((s) => failedIds.has(s.id))) continue;
      if (!isSuccessfulRun(run)) continue;
      if (!signaturesMatch(sig, run.signature)) continue;

      mkdirSync(refsDir(home), { recursive: true });
      copyFileSync(c.path, ref);
      return {
        ok: true,
        referencePath: ref,
        reason: `reference captured from ${c.path}`,
      };
    } catch {
      // Skip unreadable / malformed transcripts — mirrors parseJsonlText's
      // tolerance for partial tails.
    }
  }

  return unresolved(sig, home, "no successful matching transcript found under " + projectDir);
}

/** Build the standard "could not resolve" result with an actionable hint. */
function unresolved(sig: RunSignature, home: string, detail: string): AutocaptureResult {
  const store = refsDir(home);
  return {
    ok: false,
    referencePath: null,
    reason:
      `could not auto-resolve a reference run (${detail}). ` +
      `Pass a good-session.jsonl explicitly, or run a successful Claude Code ` +
      `session for this task first. Reference store: ${store}`,
  };
}
