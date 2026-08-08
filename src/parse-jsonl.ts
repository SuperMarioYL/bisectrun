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

import { readFileSync, existsSync } from "node:fs";
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
  return expanded;
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
  // zero spans — a total parse failure (the common "pointed at the wrong /
  // corrupted / non-JSONL file" error) must not masquerade as an empty run
  // that align() then reports as a clean "no divergence" result (the
  // opposite of what this tool is for). Per-line tolerance for partial
  // transcript tails is kept intact inside parseJsonlText; we only fail
  // when the WHOLE file yielded nothing. (fix-silent-success-on-unparseable-transcript)
  if (run.signature.spanCount === 0 && text.trim().length > 0) {
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

  for (const r of records) {
    if (r.cwd && !cwd) cwd = r.cwd;
    if (r.gitBranch && !gitBranch) gitBranch = r.gitBranch;

    // The first textual user message is treated as the task prompt.
    if (!promptFound && r.type === "user" && r.message) {
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

  return { spans, roots, signature };
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
