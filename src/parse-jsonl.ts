/**
 * parse-jsonl — read and parse a Claude Code session transcript (`.jsonl`)
 * into a span tree + task signature.
 *
 * Claude Code writes one JSON object per line to:
 *   ~/.claude/projects/<sanitized-cwd>/<session-uuid>.jsonl
 *
 * Each record carries `uuid`, `parentUuid`, `type` ("user" | "assistant" | ...),
 * a `message` with `content[]`, an ISO `timestamp`, the `cwd`, and (optionally)
 * the `gitBranch`. Assistant turns contain `tool_use` blocks; the following
 * user turn carries the matching `tool_result` blocks keyed by `tool_use_id`.
 *
 * We collapse each `tool_use` + its `tool_result` into a single {@link Span}
 * and stitch spans into a tree via the `parentUuid`/`uuid` record linkage.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Span, RunSignature } from "./types.js";

/** The fully parsed agent run. */
export interface ParsedRun {
  /** All spans in chronological order. */
  spans: Span[];
  /** Root spans (those with no parent). */
  roots: Span[];
  /** The task signature derived from the transcript. */
  signature: RunSignature;
  /** Total number of JSON records parsed from the transcript (before span derivation). */
  recordCount: number;
  /**
   * Records that look like Claude Code transcript entries (a `uuid` field
   * and/or `type` "user"/"assistant"). A wrong-but-valid JSONL data file
   * parses to recordCount > 0 with transcriptRecordCount === 0 and must not
   * masquerade as an empty-but-fine transcript. (fix-parse-guard-non-transcript-jsonl)
   */
  transcriptRecordCount: number;
}

interface RawRecord {
  parentUuid?: string | null;
  uuid?: string;
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
}

interface ContentBlock {
  type: string;
  // tool_use
  id?: string;
  name?: string;
  input?: unknown;
  // tool_result
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  // text
  text?: string;
}

/** Sanitize a cwd the way Claude Code derives the project sub-directory name. */
export function sanitizeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/** Resolve the canonical transcript path for a (cwd, sessionId) pair. */
export function resolveProjectPath(cwd: string, sessionId: string): string {
  return join(homedir(), ".claude", "projects", sanitizeCwd(cwd), `${sessionId}.jsonl`);
}

/** Resolve a user-supplied path: existing file wins, else `~` expansion, else as-is. */
function resolveInput(input: string): string {
  if (existsSync(input)) return resolve(input);
  const expanded = input.replace(/^~(?=$|\/|\\)/, homedir());
  if (existsSync(expanded)) return resolve(expanded);
  // Last fallback: a bare Claude Code session id, resolved against
  // ~/.claude/projects/*/. (fix-cli-session-id-argument)
  const byId = resolveSessionId(input);
  if (byId) return byId;
  return expanded;
}

/**
 * Resolve a bare Claude Code session id to its transcript under
 * ~/.claude/projects/<sanitized-cwd>/<session-id>.jsonl.
 *
 * Returns the absolute path when EXACTLY ONE project dir holds <id>.jsonl
 * (session uuids are unique filenames, so ambiguity is practically
 * impossible — and when it somehow happens, guessing is worse than the
 * caller's existing not-found error). Returns null — keeping the caller's
 * current behavior — when the input is not id-shaped (contains path
 * separators), ~/.claude/projects is absent/unreadable, or no/ambiguous
 * match exists. (fix-cli-session-id-argument)
 */
export function resolveSessionId(id: string, home: string = homedir()): string | null {
  if (!id || id.includes("/") || id.includes("\\") || id.startsWith("~")) return null;
  const projects = join(home, ".claude", "projects");
  let entries: string[];
  try {
    entries = readdirSync(projects);
  } catch {
    // No ~/.claude/projects (or unreadable) — nothing to resolve against.
    return null;
  }
  const matches: string[] = [];
  for (const e of entries) {
    const candidate = join(projects, e, `${id}.jsonl`);
    try {
      if (statSync(candidate).isFile()) matches.push(candidate);
    } catch {
      // Skip entries that disappeared between readdir and stat, broken
      // symlinks, and directories named <id>.jsonl.
    }
  }
  return matches.length === 1 ? resolve(matches[0]) : null;
}

/** Normalize a message's `content` field into a list of content blocks. */
function asBlocks(content: unknown): ContentBlock[] {
  if (Array.isArray(content)) return content as ContentBlock[];
  if (typeof content === "string") return [{ type: "text", text: content }];
  return [];
}

/** Pull the first text fragment out of a tool_result `content` field. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const textBlock = content.find((c: ContentBlock) => c.type === "text" && typeof c.text === "string");
    return textBlock?.text ?? "";
  }
  return "";
}

/** Parse a transcript file from disk into a {@link ParsedRun}. */
export function parseJsonlFile(filePath: string): ParsedRun {
  const abs = resolveInput(filePath);
  const text = readFileSync(abs, "utf8");
  const run = parseJsonlText(text);
  // Fail loudly when the input was non-empty but the whole file parsed to
  // zero records — a total parse failure (the common "pointed at the wrong /
  // corrupted / non-JSONL file" error) must not masquerade as an empty run
  // that align() then reports as a clean "no divergence" result (the
  // opposite of what this tool is for). Per-line tolerance for partial
  // transcript tails is kept intact inside parseJsonlText; we only fail
  // when the WHOLE file yielded nothing. The guard gates on `recordCount`
  // (parsed JSON lines), NOT `spanCount` (tool_use-derived Spans): a valid
  // Claude Code transcript where the agent only chatted (no tool_use blocks)
  // parses cleanly (recordCount > 0) yet yields spanCount === 0, and gating
  // on spanCount wrongly told the user a legitimate chat-only transcript was
  // "not a Claude Code session JSONL?". A garbage file (zero valid JSON
  // lines) still throws; a chat-only transcript no longer throws and align()
  // reports no divergence. (fix-silent-success-on-unparseable-transcript,
  // fix-parsejsonlfile-spans-vs-records)
  //
  // recordCount alone still lets a wrong-but-VALID JSONL file through (any
  // newline-delimited JSON data file parses to records but zero transcript
  // entries), silently reporting "no divergence" for two files that are not
  // transcripts at all. The second half of the guard gates on transcript
  // SHAPE: a Claude Code session transcript always contains records with a
  // uuid field and/or type "user"/"assistant" — chat-only transcripts
  // qualify (their user/assistant records count), data JSONL does not.
  // (fix-parse-guard-non-transcript-jsonl)
  //
  // The guard applies to a BLANK input too. It used to be gated on
  // `text.trim().length > 0`, so a 0-byte or whitespace-only file (an
  // interrupted capture, a `touch`ed placeholder, a rotated log) skipped both
  // record-count checks and came back as a valid zero-record run; two such
  // runs then aligned to "Runs align completely — no divergence detected."
  // with exit 0 (--json exit 2), a clean verdict computed from no data at all.
  // A blank file is not an empty-but-valid transcript — a real session always
  // writes records — so it throws like any other zero-record input.
  // (fix-zero-record-transcript-clean-verdict)
  if (run.recordCount === 0 || run.transcriptRecordCount === 0) {
    throw new Error(
      `no parseable transcript records in ${abs} — not a Claude Code session JSONL?`,
    );
  }
  return run;
}

/** Parse transcript text (JSONL) into a {@link ParsedRun}. */
export function parseJsonlText(text: string): ParsedRun {
  const records: RawRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as RawRecord);
    } catch {
      // Skip malformed lines silently — transcripts occasionally have partial tails.
    }
  }
  return buildRun(records);
}

/** Build the span tree + signature from parsed raw records. */
export function buildRun(records: RawRecord[]): ParsedRun {
  const byUuid = new Map<string, RawRecord>();
  for (const r of records) {
    if (r.uuid) byUuid.set(r.uuid, r);
  }

  const spanByToolUseId = new Map<string, Span>();
  const toolUseIdsByRecord = new Map<string, string[]>();
  const recordForToolUse = new Map<string, string>();
  const spans: Span[] = [];

  // Signature extraction.
  let cwd = "";
  let gitBranch: string | undefined;
  let prompt = "";
  let promptFound = false;
  // Transcript-shape count: records that could only come from a Claude Code
  // session (uuid linkage or a user/assistant turn). (fix-parse-guard-non-transcript-jsonl)
  let transcriptRecordCount = 0;

  for (const r of records) {
    if (r.uuid || r.type === "user" || r.type === "assistant") transcriptRecordCount++;
    if (r.cwd && !cwd) cwd = r.cwd;
    if (r.gitBranch && !gitBranch) gitBranch = r.gitBranch;

    // The first textual user message is treated as the task prompt. Records
    // flagged `isMeta` are system-injected (local-command caveats, command
    // breadcrumbs), not the user's instruction: taking one as the prompt made
    // the same task compare as two different tasks (signaturesMatch false)
    // and parked the autocapture reference under a different signature hash.
    // (fix-task-prompt-includes-meta-records)
    if (!promptFound && !r.isMeta && r.type === "user" && r.message) {
      const blocks = asBlocks(r.message.content);
      const textBlock = blocks.find((b) => b.type === "text" && typeof b.text === "string" && b.text.trim());
      if (textBlock?.text) {
        prompt = textBlock.text.split("\n")[0].slice(0, 200);
        promptFound = true;
      }
    }

    // Spawn spans from assistant tool_use blocks.
    if (r.type === "assistant" && r.message && r.uuid) {
      const blocks = asBlocks(r.message.content);
      const ids: string[] = [];
      for (const b of blocks) {
        if (b.type === "tool_use" && b.id) {
          const span: Span = {
            id: b.id,
            parent: null,
            name: b.name ?? "unknown",
            ts: r.timestamp ?? new Date(0).toISOString(),
            tool_use: { name: b.name, input: b.input },
            children: [],
          };
          spans.push(span);
          spanByToolUseId.set(b.id, span);
          recordForToolUse.set(b.id, r.uuid);
          ids.push(b.id);
        }
      }
      if (ids.length) toolUseIdsByRecord.set(r.uuid, ids);
    }
  }

  // Attach tool_result blocks to their spans.
  for (const r of records) {
    if (r.type === "user" && r.message) {
      const blocks = asBlocks(r.message.content);
      for (const b of blocks) {
        if (b.type === "tool_result" && b.tool_use_id) {
          const span = spanByToolUseId.get(b.tool_use_id);
          if (span) {
            span.tool_result = {
              is_error: b.is_error,
              content: resultText(b.content),
            };
          }
        }
      }
    }
  }

  // Stitch parent links via the record parentUuid chain.
  for (const span of spans) {
    const ownUuid = recordForToolUse.get(span.id);
    let current = ownUuid ? byUuid.get(ownUuid) ?? null : null;
    // Skip the span's own record; start from its parent.
    current = current?.parentUuid ? byUuid.get(current.parentUuid) ?? null : null;

    while (current) {
      const ids = current.uuid ? toolUseIdsByRecord.get(current.uuid) : undefined;
      if (ids && ids.length) {
        const lastId = ids[ids.length - 1];
        const parentSpan = spanByToolUseId.get(lastId);
        if (parentSpan && parentSpan.id !== span.id) {
          span.parent = parentSpan.id;
          parentSpan.children.push(span);
        }
        break;
      }
      current = current?.parentUuid ? byUuid.get(current.parentUuid) ?? null : null;
    }
  }

  // A transcript's parentUuid chain is expected to be acyclic, but a malformed
  // or hand-merged file can form a cycle (A.parentUuid=B, B.parentUuid=A). Both
  // spans then get a non-null parent, so `roots` is empty and flatten() — plus
  // the --ui renderer's treeHtml walk — recurses forever, killing the process
  // with "Maximum call stack size exceeded" (and pre-empting the
  // transcript-shape guard in parseJsonlFile, which never gets to report the
  // file). Detach the first span whose parent chain revisits an ancestor, and
  // drop it from its former parent's children, restoring the acyclic invariant
  // once for every consumer. Well-formed transcripts never trigger this: their
  // chains are acyclic, so the walk terminates without a repeat.
  // (fix-cyclic-parentuuid-stack-overflow)
  for (const span of spans) {
    const seen = new Set<string>([span.id]);
    let p = span.parent;
    while (p) {
      if (seen.has(p)) {
        const formerParent = spanByToolUseId.get(span.parent as string);
        span.parent = null;
        if (formerParent) formerParent.children = formerParent.children.filter((c) => c.id !== span.id);
        break;
      }
      seen.add(p);
      p = spanByToolUseId.get(p)?.parent ?? null;
    }
  }

  // Sort each parent's children by timestamp for a stable tree.
  for (const span of spans) {
    span.children.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  }

  const roots = spans.filter((s) => s.parent === null);
  const signature: RunSignature = {
    cwd,
    gitBranch,
    prompt,
    spanCount: spans.length,
  };

  return { spans, roots, signature, recordCount: records.length, transcriptRecordCount };
}

/** Flatten a span tree into chronological (depth-first) order. */
export function flatten(roots: Span[]): Span[] {
  const out: Span[] = [];
  const walk = (s: Span) => {
    out.push(s);
    for (const c of s.children) walk(c);
  };
  for (const r of roots) walk(r);
  return out;
}
