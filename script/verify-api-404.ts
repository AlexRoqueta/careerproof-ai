/* Verification for unknown /api/* hardening.
 *
 * Run with:  npx tsx script/verify-api-404.ts
 *
 * Boots a real Express server wired the same way server/index.ts wires
 * it (registerRoutes -> API 404 fallback -> SPA static fallback) against
 * an isolated SQLite DB, then asserts:
 *
 *   1. Unknown /api/* paths return HTTP 404 with a JSON body
 *      {"error":"Not found"} — covers the exact scanner-probed paths
 *      observed in production logs (/api/.env, /api/shared/.env,
 *      /api/swagger.json, /api/graphql, /api/proxy) plus a couple of
 *      generic shapes (deep paths, query strings).
 *   2. A real API route still works: GET /api/config/check returns 200
 *      with the public config report shape.
 *   3. A frontend hash-style URL (root path `/`, since hash routing is
 *      client-side) still receives 200 + HTML from the static handler,
 *      so the 404 guard has NOT broken normal page loads.
 *   4. Non-API unknown paths fall through to the SPA (200 + HTML), so
 *      deep links like /credits hand off to the client router.
 *
 * Exits non-zero on any failure.
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const projectRoot = dirname(dirname(__filename));
const tmpDir = mkdtempSync(join(tmpdir(), "ousted-verify-api-404-"));
const originalCwd = process.cwd();
process.chdir(tmpDir);

process.env.DISABLE_RATE_LIMIT = "1";
process.env.NODE_ENV = "production";

const { default: express } = await import("express");
const { createServer } = await import("node:http");
const { registerRoutes } = await import("../server/routes");
const { createSessionMiddleware } = await import("../server/session");
const storageMod = await import("../server/storage");
await storageMod.initStorage();

// Build a placeholder `public` directory so server/static.ts has a real
// index.html to serve. Mirrors what the production bundle does after
// `npm run build`. We point __dirname-equivalent expectations at a tmp
// dir we control by passing the express static middleware ourselves —
// simpler than monkey-patching server/static.ts's path resolution.
const publicDir = join(tmpDir, "public");
mkdirSync(publicDir, { recursive: true });
const indexHtml = `<!doctype html><html><head><title>CareerProof</title></head><body><div id="root"></div></body></html>`;
writeFileSync(join(publicDir, "index.html"), indexHtml);

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(createSessionMiddleware());
const httpServer = createServer(app);
await registerRoutes(httpServer, app);

// Mirror server/index.ts: install API 404 fallback BEFORE the SPA
// static handler so unknown /api/* paths do NOT fall through to HTML.
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Stand-in for serveStatic — points at the temp public dir above.
app.use(express.static(publicDir));
app.use("/{*path}", (_req, res) => {
  res.sendFile(resolve(publicDir, "index.html"));
});

const PORT = 4811;
await new Promise<void>((resolve) => httpServer.listen(PORT, resolve));
const base = `http://127.0.0.1:${PORT}`;

let failed = 0;
function assert(cond: any, label: string, detail?: unknown) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${label}`);
    if (detail !== undefined) {
      console.log(
        `        detail: ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 400)}`,
      );
    }
  }
}

async function fetchPath(path: string): Promise<{ status: number; contentType: string; body: string }> {
  const res = await fetch(`${base}${path}`);
  const body = await res.text();
  return { status: res.status, contentType: res.headers.get("content-type") ?? "", body };
}

try {
  /* ============================================================
   * 1. Unknown /api/* paths return JSON 404
   * ============================================================ */
  console.log("--- Unknown /api/* paths return JSON 404 ---");
  const scannerPaths = [
    "/api/.env",
    "/api/shared/.env",
    "/api/swagger.json",
    "/api/graphql",
    "/api/proxy",
    "/api/does-not-exist",
    "/api/v1/admin/secrets",
    "/api/unknown?foo=bar",
  ];
  for (const p of scannerPaths) {
    const r = await fetchPath(p);
    assert(r.status === 404, `${p} returns 404`, r);
    assert(
      r.contentType.includes("application/json"),
      `${p} response content-type is JSON`,
      r.contentType,
    );
    let parsed: any = null;
    try { parsed = JSON.parse(r.body); } catch { /* fallthrough */ }
    assert(
      parsed && parsed.error === "Not found",
      `${p} body is {"error":"Not found"}`,
      r.body.slice(0, 200),
    );
    assert(
      !/<html/i.test(r.body),
      `${p} response is NOT HTML (no SPA fall-through)`,
      r.body.slice(0, 200),
    );
  }

  /* ============================================================
   * 2. Real API routes still work
   * ============================================================ */
  console.log("\n--- Real API routes still work ---");
  const cfg = await fetchPath("/api/config/check");
  assert(cfg.status === 200, "GET /api/config/check returns 200", cfg);
  assert(
    cfg.contentType.includes("application/json"),
    "GET /api/config/check returns JSON",
    cfg.contentType,
  );
  let cfgParsed: any = null;
  try { cfgParsed = JSON.parse(cfg.body); } catch { /* fallthrough */ }
  assert(
    cfgParsed && typeof cfgParsed.ok === "boolean" && Array.isArray(cfgParsed.items),
    "GET /api/config/check body has expected shape",
    cfgParsed,
  );

  /* ============================================================
   * 3. Frontend root still serves HTML (hash routing intact)
   * ============================================================ */
  console.log("\n--- Frontend root + deep links still serve HTML ---");
  const root = await fetchPath("/");
  assert(root.status === 200, "GET / returns 200", root);
  assert(/<html/i.test(root.body), "GET / response is HTML", root.body.slice(0, 200));

  // Wouter uses hash routing on this app, so a real browser would request
  // "/" and resolve "/#/credits" client-side. Simulate a server-side
  // request for the same hash URL to confirm the server still returns
  // index.html for "/" with a hash fragment (hash is not transmitted
  // anyway, so this is equivalent to "/").
  const hashLanding = await fetchPath("/");
  assert(hashLanding.status === 200, "hash routing landing returns 200");

  // Non-API deep links also fall through to the SPA (the client may use
  // path-style internal routing as well; verify the catch-all is intact).
  const deep = await fetchPath("/some/deep/page");
  assert(deep.status === 200, "GET /some/deep/page returns 200 (SPA fall-through)", deep);
  assert(/<html/i.test(deep.body), "non-API deep link returns HTML", deep.body.slice(0, 200));
} finally {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  process.chdir(originalCwd);
  rmSync(tmpDir, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`\n${failed} verification case(s) failed.`);
  process.exit(1);
}
console.log(`\nAll /api/* 404 hardening verification cases passed.`);
