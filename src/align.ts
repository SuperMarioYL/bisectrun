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
 * Input fields that describe presentation rather than intent, excluded from a
 * span's semantic key so a cosmetic difference cannot register as a divergence.
 * Bash's and Task's `description` are human-facing one-liners the model rewords
 * freely; Task's `prompt` — the actual instruction — stays in the key.
 * (fix-fingerprint-ignores-remaining-input-fields)
 */
const PRESENTATION_FIELDS: Record<string, ReadonlySet<string>> = {
  Bash: new Set(["description"]),
  Task: new Set(["description"]),
};

/**
 * Canonical JSON with object keys sorted at every depth, so two equal inputs
 * whose keys were serialized in a different order cannot fake a divergence.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Compute a stable semantic fingerprint for a span's tool_use input.
 * The fingerprint is intentionally robust to noisy differences (timestamps,
 * uuids, trailing whitespace) so that "the same step" matches across runs.
 *
 * Every arm pairs a readable head fragment (for the --ui tree rows and
 * divergence reasons) with a short sha256 digest of the tool's FULL semantic
 * key. The head alone truncated to the first line / first 60-80 chars, so
 * before the digest was added (fix-fingerprint-truncation-collisions) two
 * runs whose divergent span differed only past the truncation — the norm for
 * real multi-line Edit/Write/MultiEdit content and >80-char Bash commands —
 * produced IDENTICAL fingerprints and align() silently reported "no
 * divergence", the exact false-negative the v0.6.0/v0.7.0 content-aware
 * fixes were built to prevent.
 *
 * The digest covers the whole input (minus PRESENTATION_FIELDS), not a
 * hand-picked subset: keying an arm on some of its fields means every unkeyed
 * field is invisible, so a divergence falling there is still reported as
 * "Runs align completely" — with --json that is exit 2, i.e. a CI gate reads
 * "nothing to bisect". v0.9.0 shipped that gap for Read (offset/limit), Glob
 * (path), Grep (glob/type/-i/output_mode/...), WebFetch (prompt), Task
 * (prompt/subagent_type) and Edit (replace_all); the digest closes them all
 * at once. The key is a superset of every field those arms keyed on, so
 * identical inputs still match and no divergence the shipped code detected is
 * lost. (fix-fingerprint-ignores-remaining-input-fields)
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
  // The tool's semantic key: every input field except the presentation-only
  // ones, canonicalized so key order cannot fake a divergence.
  const semantic = (): string => {
    const noise = PRESENTATION_FIELDS[toolName];
    if (!noise) return digest(canonicalJson(input));
    const kept: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) if (!noise.has(k)) kept[k] = v;
    return digest(canonicalJson(kept));
  };

  switch (toolName) {
    case "Bash":
      return `Bash:${head(str(input.command))}#${semantic()}`;
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
      // The digest then keys on the FULL input (including replace_all), so the
      // divergence is caught wherever the difference falls, not only within
      // the head window. (fix-fingerprint-truncation-collisions,
      // fix-fingerprint-ignores-remaining-input-fields)
      return `Edit:${str(input.file_path)}|${head(str(input.old_string), 60)}|${head(str(input.new_string), 60)}#${semantic()}`;
    case "MultiEdit":
      // Key on file_path + the actual edits payload, not just edits.length.
      // Before this, the fingerprint was `MultiEdit:${file_path}|${edits.length}`
      // and ignored the edit content entirely, so two runs that MultiEdit the
      // same file with the SAME edit count but DIFFERENT edits produced
      // IDENTICAL fingerprints — the same silent false-negative v0.6.0 fixed
      // for Edit (the canonical "wrong fix to the right spot" divergence).
      // The digest covers the whole input, so a differing SECOND edit
      // (invisible to the head of the JSON serialization) still diverges.
      // (fix-write-multiedit-fingerprint-ignores-content,
      // fix-fingerprint-truncation-collisions)
      return `MultiEdit:${str(input.file_path)}|${head(hashish(input.edits), 60)}#${semantic()}`;
    case "Write":
      // Key on file_path + content head, not file_path alone. Before this, two
      // runs that Write the same file with DIFFERENT content produced IDENTICAL
      // fingerprints — the same silent false-negative v0.6.0 fixed for Edit.
      // Write fully replaces file content, so different content is a TOTAL
      // divergence currently reported as none. The digest covers the full
      // input, so differences past the head window still diverge.
      // (fix-write-multiedit-fingerprint-ignores-content,
      // fix-fingerprint-truncation-collisions)
      return `Write:${str(input.file_path)}|${head(str(input.content), 60)}#${semantic()}`;
    case "Read":
      // The read WINDOW is part of the intent: reading a file at offset 900 is
      // not the same step as reading it at offset 1. Keying on file_path alone
      // reported those as "no divergence" on real transcripts.
      // (fix-fingerprint-ignores-remaining-input-fields)
      return `Read:${str(input.file_path)}#${semantic()}`;
    case "Glob":
      // path is the search root — globbing **/*.ts in src is not the same step
      // as globbing it in vendor. (fix-fingerprint-ignores-remaining-input-fields)
      return `Glob:${str(input.pattern)}#${semantic()}`;
    case "Grep":
      // glob / type / -i / output_mode and friends change which results come
      // back, so they are part of the step's intent.
      // (fix-fingerprint-ignores-remaining-input-fields)
      return `Grep:${str(input.pattern)}|${str(input.path)}#${semantic()}`;
    case "Task":
      // The prompt is the instruction the sub-agent receives; the description
      // is only a label (and stays a presentation field).
      // (fix-fingerprint-ignores-remaining-input-fields)
      return `Task:${head(str(input.description))}#${semantic()}`;
    case "TodoWrite":
      // Key on the todo content, not just the count — two same-length but
      // different todo lists are a different plan and must diverge.
      // (fix-fingerprint-truncation-collisions)
      return `TodoWrite:${Array.isArray(input.todos) ? input.todos.length : 0}#${semantic()}`;
    case "WebFetch":
      // The extraction prompt is part of the intent; the URL alone is not.
      // (fix-fingerprint-ignores-remaining-input-fields)
      return `WebFetch:${str(input.url)}#${semantic()}`;
    case "WebSearch":
      return `WebSearch:${head(str(input.query))}#${semantic()}`;
    default:
      return `${toolName}:${head(hashish(input), 80)}#${semantic()}`;
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
