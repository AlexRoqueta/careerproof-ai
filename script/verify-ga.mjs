/**
 * GA4 verification harness.
 *
 * Two modes:
 *   1) Static: scan the built bundle in dist/public for the well-formed
 *      gtag stub (dataLayer.push(arguments)) and the gtag.js loader URL.
 *      No browser required. Always runs.
 *   2) Browser (optional): if `playwright` is installed AND VITE_GA_MEASUREMENT_ID
 *      is exported in the environment, spin up a static server, load the
 *      built app, and assert at least one request to
 *      google-analytics.com/g/collect fires. Skipped otherwise so the
 *      script is safe in minimal CI.
 *
 * Run with: node script/verify-ga.mjs
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const DIST = join(ROOT, "dist", "public");

function findBundle() {
  const assets = join(DIST, "assets");
  if (!existsSync(assets)) return null;
  const js = readdirSync(assets).find((f) => f.startsWith("index-") && f.endsWith(".js"));
  return js ? join(assets, js) : null;
}

function staticChecks() {
  const bundle = findBundle();
  if (!bundle) {
    console.error("FAIL: no built bundle found at dist/public/assets/index-*.js — run `npm run build` first");
    process.exit(1);
  }
  const src = readFileSync(bundle, "utf8");
  const checks = [
    {
      name: "gtag stub pushes `arguments` (not a plain array)",
      ok: /dataLayer\.push\(arguments\)/.test(src),
    },
    {
      name: "gtag.js loader URL is present",
      ok: /googletagmanager\.com\/gtag\/js\?id=/.test(src),
    },
    {
      name: "config call with send_page_view is emitted",
      ok: /send_page_view/.test(src),
    },
  ];
  let failed = 0;
  for (const c of checks) {
    console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}`);
    if (!c.ok) failed++;
  }
  return failed;
}

async function browserCheck() {
  const id = process.env.VITE_GA_MEASUREMENT_ID?.trim();
  if (!id) {
    console.log("SKIP  browser check: VITE_GA_MEASUREMENT_ID not set");
    return 0;
  }
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    console.log("SKIP  browser check: playwright not installed (npm i -D playwright && npx playwright install chromium)");
    return 0;
  }
  const { createServer } = await import("node:http");
  const { readFile } = await import("node:fs/promises");
  const { extname } = await import("node:path");
  const MIME = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".css": "text/css",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".json": "application/json",
  };
  const server = createServer(async (req, res) => {
    const url = (req.url || "/").split("?")[0];
    const path = url === "/" ? "/index.html" : url;
    try {
      const body = await readFile(join(DIST, path));
      res.writeHead(200, { "Content-Type": MIME[extname(path)] || "text/plain" });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/`;

  const browser = await chromium.launch();
  const page = await browser.newPage();
  let collectFired = false;
  page.on("request", (req) => {
    if (req.url().includes("google-analytics.com/g/collect")) collectFired = true;
  });
  await page.goto(url, { waitUntil: "networkidle" });
  // Give GA's beacon a chance to flush.
  await page.waitForTimeout(2000);
  await browser.close();
  server.close();

  if (collectFired) {
    console.log("PASS  browser check: google-analytics.com/g/collect request fired");
    return 0;
  }
  console.error("FAIL  browser check: no /g/collect request observed");
  return 1;
}

const staticFailed = staticChecks();
const browserFailed = await browserCheck();
const total = staticFailed + browserFailed;
if (total > 0) {
  console.error(`\n${total} check(s) failed`);
  process.exit(1);
}
console.log("\nAll GA verification checks passed.");
