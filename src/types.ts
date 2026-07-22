/**
 * BisectRun core types.
 *
 * A "span" is a unit of agent execution: a single tool_use block together with
 * its corresponding tool_result, linked into a tree via parent/child uuid
 * relationships derived from the Claude Code JSONL transcript.
 */

/** A single tool_use + tool_result pair, treated as a span in the run tree. */
export interface Span {
  /** Stable identifier for this span (the record's uuid). */
  id: string;
  /** Parent span id (derived from the record's parentUuid), or null for the root. */
  parent: string | null;
  /** Human-readable name for the span: the tool name (e.g. "Bash", "Edit"). */
  name: string;
  /** ISO 8601 timestamp for when the tool_use was issued. */
  ts: string;
  /** The raw tool_use input block (may be undefined for text-only turns). */
  tool_use?: {
    /** The tool's name as recorded in the transcript. */
    name?: string;
    /** The structured input passed to the tool. */
    input?: unknown;
  };
  /** The corresponding tool_result block (may be undefined on incomplete runs). */
  tool_result?: {
    /** Whether the tool reported an error. */
    is_error?: boolean;
    /** The textual content of the result (first text chunk). */
    content?: string;
  };
  /** Child spans, ordered by timestamp. */
  children: Span[];
}

/** The identifying signature of an agent run, used to confirm two sessions tackle the same task. */
export interface RunSignature {
  /** The working directory the agent operated in. */
  cwd: string;
  /** The git branch the run was performed against, if any. */
  gitBranch?: string;
  /** The first-line task / prompt that kicked off the run. */
  prompt: string;
  /** Total number of spans derived from the transcript. */
  spanCount: number;
}

/** The result of aligning two span trees and locating the first divergence. */
export interface AlignmentResult {
  /** Whether the two runs share the same task signature (cwd + branch + prompt). */
  signaturesMatch: boolean;
  /** Signature of the failing run. */
  failed: RunSignature;
  /** Signature of the passing (good) run. */
  good: RunSignature;
  /** The shared leading path of spans present in both trees (before divergence). */
  commonPrefix: Span[];
  /** The first span where the two runs diverge (from the failed run), or null if identical. */
  firstDivergence: Span | null;
  /** The matching span in the good run at the point of divergence, or null. */
  goodDivergence: Span | null;
  /** Human-readable explanation of the divergence. */
  reason: string;
  /** Total number of spans that matched before divergence. */
  matchedDepth: number;
}
