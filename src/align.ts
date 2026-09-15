/**
 * align — span-semantic alignment of two agent runs.
 *
 * Two spans are considered "the same step" when they invoke the same tool with
 * a semantically equivalent intent (a stable fingerprint of the tool_use
 * input). Walking the chronological span lists of both runs, the first index
 * where the fingerprints disagree is the first divergence — the analogue of
 * `git bisect`'s first bad commit, but for agent execution spans.
 */

import type { Span, AlignmentResult, RunSignature } from "./types.js";
import { createHash } from "node:crypto";
import { flatten, type ParsedRun } from "./parse-jsonl.js";

/** Normalize a prompt line for signature comparison. */
function normalizePrompt(p: string): string {
  return p.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Whether two run signatures describe the same task. */
export function signaturesMatch(a: RunSignature, b: RunSignature): boolean {
  if (a.cwd !== b.cwd) return false;
  if ((a.gitBranch ?? "") !== (b.gitBranch ?? "")) return false;
  return normalizePrompt(a.prompt) === normalizePrompt(b.prompt);
}

/**
 * Compute a stable semantic fingerprint for a span's tool_use input.
 * The fingerprint is intentionally robust to noisy differences (timestamps,
 * uuids, trailing whitespace) so that "the same step" matches across runs.
 *
 * Content-bearing arms pair a readable head fragment (for the --ui tree rows
 * and divergence reasons) with a short sha256 digest of the FULL semantic
 * key. The head alone truncated to the first line / first 60-80 chars, so
 * before the digest was added (fix-fingerprint-truncation-collisions) two
 * runs whose divergent span differed only past the truncation — the norm for
 * real multi-line Edit/Write/MultiEdit content and >80-char Bash commands —
 * produced IDENTICAL fingerprints and align() silently reported "no
 * divergence", the exact false-negative the v0.6.0/v0.7.0 content-aware
 * fixes were built to prevent. The digest makes the fingerprint
 * discriminate the complete content; the head stays for humans.
 */
export function spanFingerprint(span: Span): string {
  const input = (span.tool_use?.input ?? {}) as Record<string, unknown>;
  const toolName = span.name;

  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const head = (v: string, n = 80): string => v.split("\n")[0].slice(0, n).trim();
  const hashish = (v: unknown): string => {
    try {
      return String(JSON.stringify(v ?? ""));
    } catch {
      return String(v ?? "");
    }
  };
  // Short digest of the full semantic key — the discrimination half of the
  // fingerprint. 12 hex chars (48 bits) makes an accidental collision
  // negligible for run-length span lists. (fix-fingerprint-truncation-collisions)
  const digest = (v: string): string => createHash("sha256").update(v).digest("hex").slice(0, 12);

  switch (toolName) {
    case "Bash":
      return `Bash:${head(str(input.command))}#${digest(str(input.command))}`;
    case "Edit":
      // Key on file_path + old_string AND new_string. Before this, the
      // fingerprint was `Edit:${file_path}|${head(old_string, 60)}` and
      // ignored new_string entirely, so two runs that edit the same file at
      // the same spot with the SAME old_string but DIFFERENT new_string (the
      // canonical "agent wrote the wrong fix to the right spot" divergence)
      // produced IDENTICAL fingerprints — a silent false-negative on the core
      // bisect verdict for exactly the scenario this tool exists to locate.
      // Two edits with the same old_string but different new_string have
      // DIFFERENT intent, so they must diverge. (fix-edit-fingerprint-ignores-new-string)
      // The digest then keys on the FULL old/new strings so the divergence is
      // caught wherever the difference falls, not only within the head window.
      // (fix-fingerprint-truncation-collisions)
      return `Edit:${str(input.file_path)}|${head(str(input.old_string), 60)}|${head(str(input.new_string), 60)}#${digest(`${str(input.file_path)}\0${str(input.old_string)}\0${str(input.new_string)}`)}`;
    case "MultiEdit":
      // Key on file_path + the actual edits payload, not just edits.length.
      // Before this, the fingerprint was `MultiEdit:${file_path}|${edits.length}`
      // and ignored the edit content entirely, so two runs that MultiEdit the
      // same file with the SAME edit count but DIFFERENT edits produced
      // IDENTICAL fingerprints — the same silent false-negative v0.6.0 fixed
      // for Edit (the canonical "wrong fix to the right spot" divergence).
      // The digest covers the serialized edits array in full, so a differing
      // SECOND edit (invisible to the head of the JSON serialization) still
      // diverges. (fix-write-multiedit-fingerprint-ignores-content,
      // fix-fingerprint-truncation-collisions)
      return `MultiEdit:${str(input.file_path)}|${head(hashish(input.edits), 60)}#${digest(`${str(input.file_path)}\0${hashish(input.edits)}`)}`;
    case "Write":
      // Key on file_path + content head, not file_path alone. Before this, two
      // runs that Write the same file with DIFFERENT content produced IDENTICAL
      // fingerprints — the same silent false-negative v0.6.0 fixed for Edit.
      // Write fully replaces file content, so different content is a TOTAL
      // divergence currently reported as none. The digest covers the full
      // content, so differences past the head window still diverge.
      // (fix-write-multiedit-fingerprint-ignores-content,
      // fix-fingerprint-truncation-collisions)
      return `Write:${str(input.file_path)}|${head(str(input.content), 60)}#${digest(`${str(input.file_path)}\0${str(input.content)}`)}`;
    case "Read":
      // Full file path — no truncation, no digest needed.
      return `Read:${str(input.file_path)}`;
    case "Glob":
      return `Glob:${str(input.pattern)}`;
    case "Grep":
      return `Grep:${str(input.pattern)}|${str(input.path)}`;
    case "Task":
      return `Task:${head(str(input.description))}#${digest(str(input.description))}`;
    case "TodoWrite":
      // Key on the todo content, not just the count — two same-length but
      // different todo lists are a different plan and must diverge.
      // (fix-fingerprint-truncation-collisions)
      return `TodoWrite:${Array.isArray(input.todos) ? input.todos.length : 0}#${digest(hashish(input.todos))}`;
    case "WebFetch":
      return `WebFetch:${str(input.url)}`;
    case "WebSearch":
      return `WebSearch:${head(str(input.query))}#${digest(str(input.query))}`;
    default:
      return `${toolName}:${head(hashish(input), 80)}#${digest(hashish(input))}`;
  }
}

/** Whether two spans occupy the same semantic step. */
export function spansEqual(a: Span, b: Span): boolean {
  if (a.name !== b.name) return false;
  return spanFingerprint(a) === spanFingerprint(b);
}

/** Describe why two spans diverge, for human readers. */
function divergenceReason(failed: Span, good: Span | null): string {
  if (!good) {
    return `First divergence: run produced an extra "${failed.name}" step that the good run never reached.`;
  }
  if (failed.name !== good.name) {
    return `First divergence: tool differs — failed run used "${failed.name}" while good run used "${good.name}".`;
  }
  return `First divergence: same tool "${failed.name}" but with different input —\n  failed: ${spanFingerprint(failed)}\n  good:   ${spanFingerprint(good)}`;
}

/** Align two parsed runs and locate the first divergence. */
export function align(failed: ParsedRun, good: ParsedRun): AlignmentResult {
  const sigsMatch = signaturesMatch(failed.signature, good.signature);

  const failedFlat = flatten(failed.roots.length ? failed.roots : failed.spans.map((s) => ({ ...s, parent: null })));
  const goodFlat = flatten(good.roots.length ? good.roots : good.spans.map((s) => ({ ...s, parent: null })));

  // Use the raw chronological list when flattening produced nothing useful.
  const fList = failedFlat.length ? failedFlat : failed.spans;
  const gList = goodFlat.length ? goodFlat : good.spans;

  const commonPrefix: Span[] = [];
  let firstDivergence: Span | null = null;
  let goodDivergence: Span | null = null;
  let reason = "Runs align completely — no divergence detected.";
  let matchedDepth = 0;

  const n = Math.min(fList.length, gList.length);
  for (let i = 0; i < n; i++) {
    if (spansEqual(fList[i], gList[i])) {
      commonPrefix.push(fList[i]);
      matchedDepth = i + 1;
    } else {
      firstDivergence = fList[i];
      goodDivergence = gList[i];
      reason = divergenceReason(fList[i], gList[i]);
      break;
    }
  }

  // Handle length-mismatch divergence (one run is a strict prefix of the other).
  if (!firstDivergence) {
    if (fList.length > gList.length) {
      firstDivergence = fList[n] ?? null;
      goodDivergence = null;
      if (firstDivergence) {
        reason = `First divergence: failed run continued past the good run with an extra "${firstDivergence.name}" step.`;
      }
    } else if (gList.length > fList.length) {
      firstDivergence = null;
      goodDivergence = gList[n] ?? null;
      if (goodDivergence) {
        reason = `First divergence: good run continued past the failed run with an extra "${goodDivergence.name}" step.`;
      }
    }
  }

  if (!sigsMatch && !firstDivergence) {
    reason = "Run signatures differ (cwd / branch / prompt) — these may not be the same task.";
  }

  return {
    signaturesMatch: sigsMatch,
    failed: failed.signature,
    good: good.signature,
    commonPrefix,
    firstDivergence,
    goodDivergence,
    reason,
    matchedDepth,
  };
}
