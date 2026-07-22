/**
 * server — Hono web UI rendering the two span trees side by side,
 * highlighting the first divergence span.
 */

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { spanFingerprint } from "./align.js";
import type { AlignmentResult, Span } from "./types.js";
import type { ParsedRun } from "./parse-jsonl.js";

export interface ServerBundle {
  failedRun: ParsedRun;
  goodRun: ParsedRun;
}

function spanRow(span: Span, side: "failed" | "good", divergenceId: string | null): string {
  const isDiv = divergenceId != null && span.id === divergenceId;
  const cls = isDiv ? "span divergence" : "span";
  const fp = spanFingerprint(span);
  const errFlag = span.tool_result?.is_error ? '<span class="err">error</span>' : "";
  const depth = 0; // visual indentation handled by tree walker
  return `<li class="${cls}" data-id="${escapeAttr(span.id)}" style="margin-left:${depth}rem">
    <div class="name">${escapeHtml(span.name)}</div>
    <div class="fp">${escapeHtml(fp)}</div>
    <div class="ts">${escapeHtml(span.ts)}</div>
    ${errFlag}
  </li>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
}
function escapeAttr(s: string): string {
  return escapeHtml(s);
}

function treeHtml(roots: Span[], side: "failed" | "good", divergenceId: string | null): string {
  const out: string[] = [];
  const walk = (nodes: Span[], depth: number) => {
    out.push(`<ul class="tree">`);
    for (const n of nodes) {
      const isDiv = divergenceId != null && n.id === divergenceId;
      const cls = isDiv ? "span divergence" : "span";
      const errFlag = n.tool_result?.is_error ? '<span class="err">error</span>' : "";
      out.push(
        `<li class="${cls}" style="margin-left:${depth}rem">` +
          `<span class="name">${escapeHtml(n.name)}</span>` +
          `<span class="fp">${escapeHtml(spanFingerprint(n))}</span>` +
          `<span class="ts">${escapeHtml(n.ts)}</span>` +
          errFlag +
          `</li>`,
      );
      if (n.children.length) walk(n.children, depth + 1);
    }
    out.push(`</ul>`);
  };
  walk(roots, 0);
  return out.join("\n");
}

function page(result: AlignmentResult, bundle: ServerBundle): string {
  const failedDivId = result.firstDivergence?.id ?? null;
  const goodDivId = result.goodDivergence?.id ?? null;
  const failedTrees = treeHtml(bundle.failedRun.roots.length ? bundle.failedRun.roots : bundle.failedRun.spans, "failed", failedDivId);
  const goodTrees = treeHtml(bundle.goodRun.roots.length ? bundle.goodRun.roots : bundle.goodRun.spans, "good", goodDivId);

  const sigMatch = result.signaturesMatch;
  const payload = {
    reason: result.reason,
    matchedDepth: result.matchedDepth,
    signaturesMatch: sigMatch,
    failed: result.failed,
    good: result.good,
    firstDivergence: result.firstDivergence,
    goodDivergence: result.goodDivergence,
  };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>BisectRun — span diff</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; background:#0d1117; color:#c9d1d9; }
  header { padding: 1.2rem 1.6rem; background: linear-gradient(90deg,#1f6feb,#8957e5); color:#fff; }
  header h1 { margin:0; font-size:1.4rem; font-weight:700; letter-spacing:-0.02em; }
  header p { margin:.3rem 0 0; opacity:.85; font-size:.9rem; }
  .meta { display:flex; gap:1rem; padding:.8rem 1.6rem; background:#161b22; border-bottom:1px solid #21262d; flex-wrap:wrap; font-size:.85rem; }
  .meta code { color:#79c0ff; }
  .badge { padding:.15rem .5rem; border-radius:6px; background:#21262d; }
  .badge.ok { color:#3fb950; } .badge.warn { color:#d29922; }
  main { display:grid; grid-template-columns:1fr 1fr; gap:0; min-height:70vh; }
  .pane { padding:1rem 1.2rem; overflow:auto; }
  .pane h2 { position:sticky; top:0; background:#0d1117; margin:0 0 .6rem; font-size:1rem; padding:.4rem 0; border-bottom:1px solid #21262d; }
  .pane.failed { border-right:1px solid #21262d; }
  ul.tree { list-style:none; padding:0; margin:0; }
  li.span { display:grid; grid-template-columns: 9rem 1fr auto; gap:.5rem; padding:.35rem .5rem; border-radius:6px; align-items:center; }
  li.span .name { color:#79c0ff; font-weight:600; font-size:.82rem; }
  li.span .fp { color:#8b949e; font-size:.8rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  li.span .ts { color:#6e7681; font-size:.7rem; font-variant-numeric: tabular-nums; }
  li.span .err { color:#f85149; font-size:.65rem; background:rgba(248,81,73,.12); padding:0 .4rem; border-radius:4px; }
  li.divergence { background: rgba(210,153,34,.16); box-shadow: inset 3px 0 0 #d29922; }
  li.divergence .name { color:#d29922; }
  footer { padding:1rem 1.6rem; color:#6e7681; font-size:.8rem; border-top:1px solid #21262d; }
  @media (max-width:760px){ main{ grid-template-columns:1fr; } .pane.failed{ border-right:none; border-bottom:1px solid #21262d; } }
</style>
</head>
<body>
  <header>
    <h1>BisectRun — first divergence</h1>
    <p>${escapeHtml(result.reason)}</p>
  </header>
  <div class="meta">
    <span class="badge ${sigMatch ? "ok" : "warn"}">${sigMatch ? "signatures match" : "signatures differ"}</span>
    <span>matched depth: <code>${result.matchedDepth}</code></span>
    <span>failed spans: <code>${result.failed.spanCount}</code></span>
    <span>good spans: <code>${result.good.spanCount}</code></span>
  </div>
  <main>
    <section class="pane failed">
      <h2>FAILED run — cwd <code>${escapeHtml(result.failed.cwd)}</code>${result.failed.gitBranch ? ` · branch <code>${escapeHtml(result.failed.gitBranch)}</code>` : ""}</h2>
      ${failedTrees}
    </section>
    <section class="pane good">
      <h2>GOOD run — cwd <code>${escapeHtml(result.good.cwd)}</code>${result.good.gitBranch ? ` · branch <code>${escapeHtml(result.good.gitBranch)}</code>` : ""}</h2>
      ${goodTrees}
    </section>
  </main>
  <footer>
    BisectRun v0.1.0 — span-semantic bisect for coding agents ·
    <code>${escapeHtml(JSON.stringify(payload).slice(0, 0))}</code>
  </footer>
  <script id="result" type="application/json">${escapeHtml(JSON.stringify(payload))}</script>
</body>
</html>`;
}

export function createApp(result: AlignmentResult, bundle: ServerBundle): Hono {
  const app = new Hono();
  app.get("/", (c) => c.html(page(result, bundle)));
  app.get("/health", (c) => c.json({ ok: true, matchedDepth: result.matchedDepth }));
  app.get("/result.json", (c) =>
    c.json({
      signaturesMatch: result.signaturesMatch,
      matchedDepth: result.matchedDepth,
      reason: result.reason,
      failed: result.failed,
      good: result.good,
      firstDivergence: result.firstDivergence,
      goodDivergence: result.goodDivergence,
    }),
  );
  return app;
}

export function startServer(result: AlignmentResult, bundle: ServerBundle, opts: { port: number }): void {
  const app = createApp(result, bundle);
  serve({ fetch: app.fetch, port: opts.port }, (info) => {
    console.log(`BisectRun UI → http://localhost:${info.port}`);
  });
}
