#!/usr/bin/env node
/**
 * cli — `bisect-run` command line entry point.
 *
 * Usage:
 *   bisect-run <failed-session.jsonl> <good-session.jsonl> [--ui] [--port 7331]
 *
 * Headless mode (default) prints the first divergence span to stdout.
 * `--ui` boots the Hono diff server and serves the side-by-side span tree.
 */

import { Command } from "commander";
import { parseJsonlFile } from "./parse-jsonl.js";
import { align } from "./align.js";
import { startServer } from "./server.js";
import type { AlignmentResult } from "./types.js";

const program = new Command();

program
  .name("bisect-run")
  .description("git-bisect for coding agents — locate the first divergent span between two agent runs.")
  .argument("<failed>", "path (or ~/.claude-project id) to the failing session transcript")
  .argument("<good>", "path (or ~/.claude-project id) to the passing session transcript")
  .option("--ui", "start the web diff UI instead of printing to stdout")
  .option("-p, --port <number>", "port for the web UI", "7331")
  .option("--no-color", "disable ANSI color in headless output")
  .version("0.1.0")
  .action((failed: string, good: string, opts: { ui: boolean; port: string; color: boolean }) => {
    try {
      const failedRun = parseJsonlFile(failed);
      const goodRun = parseJsonlFile(good);
      const result = align(failedRun, goodRun);

      if (opts.ui) {
        startServer(result, { failedRun, goodRun }, { port: Number(opts.port) });
        return;
      }

      printHeadless(result, opts.color);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`bisect-run: ${msg}`);
      process.exit(1);
    }
  });

function paint(color: boolean, code: string, text: string): string {
  if (!color) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}

function summarize(span: import("./types.js").Span | null, label: string, color: boolean): string {
  if (!span) return `${label}: (none)`;
  const head = paint(color, "1;36", `${span.name}`);
  const fp = span.tool_use?.input ? ` — ${shortFingerprint(span)}` : "";
  return `${label}: ${head} [${span.ts}]${fp}`;
}

function shortFingerprint(span: import("./types.js").Span): string {
  const input = (span.tool_use?.input ?? {}) as Record<string, unknown>;
  const cmd = input.command ?? input.file_path ?? input.pattern ?? input.query ?? input.url ?? input.description;
  return cmd ? String(cmd).split("\n")[0].slice(0, 80) : "";
}

function printHeadless(result: AlignmentResult, color: boolean): void {
  const line = "─".repeat(60);
  console.log(paint(color, "2", line));
  console.log(paint(color, "1;35", "BisectRun — first divergence"));
  console.log(paint(color, "2", line));

  if (!result.signaturesMatch) {
    console.log(paint(color, "1;33", "⚠  signatures differ — possibly different tasks"));
    console.log(`  failed: cwd=${result.failed.cwd} branch=${result.failed.gitBranch ?? "-"} prompt="${result.failed.prompt}"`);
    console.log(`  good:   cwd=${result.good.cwd} branch=${result.good.gitBranch ?? "-"} prompt="${result.good.prompt}"`);
    console.log();
  }

  console.log(`matched depth: ${result.matchedDepth} span(s)`);
  console.log();
  console.log(summarize(result.firstDivergence, "FAILED divergence", color));
  console.log(summarize(result.goodDivergence, "GOOD    divergence", color));
  console.log();
  console.log(paint(color, "2", result.reason));
  console.log(paint(color, "2", line));

  if (result.firstDivergence) {
    const s = result.firstDivergence;
    if (s.tool_use?.input) {
      console.log(paint(color, "1;31", "divergent tool_use input:"));
      console.log(JSON.stringify(s.tool_use.input, null, 2));
    }
    if (s.tool_result) {
      console.log(paint(color, "1;31", "tool_result:"));
      console.log(`  is_error: ${s.tool_result.is_error ?? false}`);
      console.log(`  content:  ${(s.tool_result.content ?? "").slice(0, 240)}`);
    }
  }
}

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
