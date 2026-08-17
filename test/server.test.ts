import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseJsonlText } from "../src/parse-jsonl.js";
import { align } from "../src/align.js";
import { startServer } from "../src/server.js";

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
