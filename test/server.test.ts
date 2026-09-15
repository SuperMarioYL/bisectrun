import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseJsonlText } from "../src/parse-jsonl.js";
import { align } from "../src/align.js";
import { startServer, createApp } from "../src/server.js";

const here = dirname(fileURLToPath(import.meta.url));
const failedText = readFileSync(join(here, "fixtures/failed-session.jsonl"), "utf8");
const goodText = readFileSync(join(here, "fixtures/good-session.jsonl"), "utf8");
const failedRun = parseJsonlText(failedText);
const goodRun = parseJsonlText(goodText);

// fix-ui-server-binds-all-interfaces — the --ui server must bind to the
// loopback interface (127.0.0.1), NOT to all interfaces (:: / 0.0.0.0). Before
// the fix the serve() call passed no `hostname`, so the vendored
// @hono/node-server forwarded `undefined` into `server.listen(port,
// undefined, ...)`; Node treats an omitted host as the unspecified address
// and bound the demo UI to every interface, leaking the transcript (file
// paths, bash commands which may carry tokens, code snippets) to anyone on
// the same network. The fix passes `hostname: "127.0.0.1"`; the bound
// address is now loopback. This test inspects the actual bound address
// (server.address()) — it would be "::" or "0.0.0.0" before the fix and
// "127.0.0.1" after.
test("startServer binds the UI to 127.0.0.1, not all interfaces", async () => {
  const result = align(failedRun, goodRun);
  const origLog = console.log;
  console.log = () => {}; // silence the "BisectRun UI → ..." banner
  let server: ReturnType<typeof startServer> | null = null;
  try {
    server = startServer(result, { failedRun, goodRun }, { port: 0 });
    // serve() calls listen() asynchronously; await the listening event so
    // server.address() reflects the actual bound interface.
    await once(server, "listening");
    const addr = server.address();
    assert.ok(addr && typeof addr === "object", "server is bound to a TCP address");
    // Before the fix this was "::" (IPv6 unspecified) or "0.0.0.0" (IPv4
    // unspecified); it must now be the loopback address only.
    assert.equal((addr as { address: string }).address, "127.0.0.1");
  } finally {
    if (server) {
      server.close();
      await once(server, "close").catch(() => {});
    }
    console.log = origLog;
  }
});

// fix-ui-result-json-escaping — the --ui page used to embed the result
// payload HTML-escaped inside <script type="application/json">, but HTML
// entities are NOT decoded in script raw text, so every & < > " in the
// payload was silently corrupted for any consumer reading #result's
// textContent (valid JSON, wrong strings). The payload is now embedded with
// "<" escaped as \u003c: breakout-safe AND byte-identical for JSON.parse.
test("the embedded #result payload round-trips markup exactly through JSON.parse", async () => {
  // A transcript pair whose prompts contain markup-like text — the payload's
  // failed/good signatures carry it verbatim.
  const prompt = "fix </script> & <b>markup</b> in views";
  const base = { cwd: "/repo/x", gitBranch: "main" };
  const transcript = (command: string) =>
    [
      JSON.stringify({ parentUuid: null, uuid: "u1", type: "user", message: { role: "user", content: [{ type: "text", text: prompt }] }, timestamp: "2026-09-16T09:00:00.000Z", ...base }),
      JSON.stringify({ parentUuid: "u1", uuid: "a1", type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command } }] }, timestamp: "2026-09-16T09:00:05.000Z", ...base }),
      JSON.stringify({ parentUuid: "a1", uuid: "u2", type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok", is_error: false }] }, timestamp: "2026-09-16T09:00:06.000Z", ...base }),
    ].join("\n");
  const failedRun = parseJsonlText(transcript("npm test -- --coverage"));
  const goodRun = parseJsonlText(transcript("npm test"));
  const result = align(failedRun, goodRun);

  const app = createApp(result, { failedRun, goodRun });
  const res = await app.request("/");
  assert.equal(res.status, 200);
  const html = await res.text();

  // Extract the embedded payload (the first </script> after the opening tag
  // terminates it — which is exactly what the escaping must make impossible
  // to trigger early from INSIDE the payload).
  const m = html.match(/<script id="result" type="application\/json">([\s\S]*?)<\/script>/);
  assert.ok(m, "page embeds the #result payload script");
  const embedded = m[1];
  // Breakout-safe: every "<" in the payload is escaped, so no literal
  // "</script>" can occur inside it.
  assert.ok(embedded.includes("\\u003c"), "payload escapes < as \\u003c");
  assert.ok(!embedded.includes("</script>"), "payload must not contain a literal </script>");
  // Byte-identical for consumers: JSON.parse round-trips the prompt with the
  // raw "<"/"&" intact (RED on v0.8.0, which embedded "&lt;/script&gt; &amp; ...").
  const parsed = JSON.parse(embedded) as { failed: { prompt: string } };
  assert.equal(parsed.failed.prompt, prompt);
});
