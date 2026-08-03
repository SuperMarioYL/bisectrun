/**
 * index — public library entry point for BisectRun.
 *
 * Re-exports the programmatic API so `npm run build` emits `dist/index.js`
 * and `package.json` `main` / `exports["."]` resolve. The CLI (`dist/cli.js`)
 * remains the primary user-facing surface; this module is for non-CLI consumers
 * that want to parse transcripts or run alignment in code.
 */

export * from "./parse-jsonl.js";
export * from "./align.js";
export type * from "./types.js";
