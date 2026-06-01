/**
 * Static SEO verification.
 *
 * Reads the source SEO assets (NOT the build output) and asserts the
 * technical-SEO contract holds:
 *
 *   - sitemap.xml is well-formed XML with <urlset>/<url>/<loc>/<lastmod>
 *   - sitemap contains NO hash (#) URLs and NO private/app routes
 *   - every clean public URL has a matching pre-rendered HTML file with
 *     exactly one <h1>, at least one <h2>, a canonical tag, robots
 *     index/follow, Open Graph + Twitter metadata, and JSON-LD schema
 *   - seo-pages.ts route table and the sitemap stay in sync
 *   - robots.txt references the sitemap and blocks private routes
 *   - the referenced og-image asset exists
 *
 * Run with: `npx tsx script/verify-seo.ts`
 * Exits 1 with diagnostics if any contract is violated, so CI can guard
 * against a regression that silently breaks indexing.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { SEO_PAGE_ROUTES } from "../server/seo-pages";

const repoRoot = resolve(import.meta.dirname ?? __dirname, "..");
const pub = (p: string) => resolve(repoRoot, "client", "public", p);

const failures: string[] = [];
const fail = (m: string) => failures.push(m);

const ORIGIN = "https://careerproof.app";

// Canonical public URLs we expect to be indexable.
const PUBLIC_PATHS = [
  "/",
  "/ai-job-risk-assessment",
  "/will-ai-replace-my-job",
  "/jobs-at-risk-from-ai",
  "/future-proof-your-career",
  "/sample-report",
  "/pricing",
];

const PRIVATE_FRAGMENTS = ["/api", "/admin", "/profile", "/history", "/resumes", "/credits"];

// --- sitemap.xml ---------------------------------------------------------

const sitemap = readFileSync(pub("sitemap.xml"), "utf8");

if (!/^<\?xml\s+version="1\.0"\s+encoding="UTF-8"\s*\?>/.test(sitemap.trim())) {
  fail("sitemap.xml: missing or malformed XML declaration");
}
if (!/<urlset\s+xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/.test(sitemap)) {
  fail("sitemap.xml: missing <urlset> with the sitemap 0.9 namespace");
}
if (!sitemap.includes("</urlset>")) {
  fail("sitemap.xml: missing closing </urlset>");
}
if (sitemap.includes("#")) {
  fail("sitemap.xml: contains a '#' — hash routes must not be canonical SEO URLs");
}

// Balanced <url> / <loc> / <lastmod>.
const urlOpen = (sitemap.match(/<url>/g) ?? []).length;
const urlClose = (sitemap.match(/<\/url>/g) ?? []).length;
if (urlOpen !== urlClose) fail(`sitemap.xml: unbalanced <url> tags (${urlOpen} open, ${urlClose} close)`);

const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
const lastmods = (sitemap.match(/<lastmod>/g) ?? []).length;
if (locs.length === 0) fail("sitemap.xml: no <loc> entries found");
if (lastmods !== locs.length) {
  fail(`sitemap.xml: every <url> must have a <lastmod> (${locs.length} locs, ${lastmods} lastmods)`);
}
for (const lm of [...sitemap.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map((m) => m[1])) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(lm)) fail(`sitemap.xml: <lastmod> "${lm}" is not YYYY-MM-DD`);
}

// Every loc is an absolute careerproof.app URL, no private routes.
for (const loc of locs) {
  if (!loc.startsWith(ORIGIN + "/") && loc !== ORIGIN + "/") {
    fail(`sitemap.xml: <loc> "${loc}" is not an absolute ${ORIGIN} URL`);
  }
  for (const frag of PRIVATE_FRAGMENTS) {
    if (loc.includes(frag)) fail(`sitemap.xml: <loc> "${loc}" points at a private route (${frag})`);
  }
}

// Every expected public path is present in the sitemap.
const sitemapPaths = new Set(locs.map((l) => l.replace(ORIGIN, "") || "/"));
for (const p of PUBLIC_PATHS) {
  if (!sitemapPaths.has(p)) fail(`sitemap.xml: missing expected public URL ${ORIGIN}${p}`);
}

// --- seo-pages.ts <-> sitemap sync --------------------------------------

for (const route of SEO_PAGE_ROUTES) {
  if (!sitemapPaths.has(route.path)) {
    fail(`sitemap.xml: SEO route ${route.path} (seo-pages.ts) is not in the sitemap`);
  }
  if (!existsSync(pub(`seo/${route.file}`))) {
    fail(`seo-pages.ts: file client/public/seo/${route.file} for ${route.path} does not exist`);
  }
}

// --- per-page metadata + headings ---------------------------------------

function checkPage(file: string, canonicalPath: string) {
  const html = readFileSync(pub(`seo/${file}`), "utf8");
  const tag = `seo/${file}`;

  const h1 = (html.match(/<h1[\s>]/g) ?? []).length;
  if (h1 !== 1) fail(`${tag}: must have exactly one <h1> (found ${h1})`);
  const h2 = (html.match(/<h2[\s>]/g) ?? []).length;
  if (h2 < 1) fail(`${tag}: must have at least one <h2> (found ${h2})`);

  const title = html.match(/<title>([^<]+)<\/title>/);
  if (!title) fail(`${tag}: missing <title>`);

  if (!/<meta\s+name="description"\s+content="[^"]{1,300}"/.test(html)) {
    fail(`${tag}: missing meta description`);
  }
  const canonical = `${ORIGIN}${canonicalPath}`;
  if (!html.includes(`<link rel="canonical" href="${canonical}"`)) {
    fail(`${tag}: missing/incorrect canonical (expected ${canonical})`);
  }
  if (!/<meta\s+name="robots"\s+content="[^"]*index[^"]*follow/i.test(html)) {
    fail(`${tag}: missing robots index,follow meta`);
  }
  if (!html.includes('property="og:title"')) fail(`${tag}: missing og:title`);
  if (!html.includes('property="og:url"')) fail(`${tag}: missing og:url`);
  if (!html.includes('content="CareerProof AI"')) fail(`${tag}: missing og:site_name CareerProof AI`);
  if (!html.includes('name="twitter:card"')) fail(`${tag}: missing twitter:card`);
  if (!html.includes("application/ld+json")) fail(`${tag}: missing JSON-LD schema`);
  if (html.includes("/#/sample-report")) {
    fail(`${tag}: still links to hash /#/sample-report — use clean /sample-report`);
  }
}

for (const route of SEO_PAGE_ROUTES) checkPage(route.file, route.path);

// --- robots.txt ----------------------------------------------------------

const robots = readFileSync(pub("robots.txt"), "utf8");
if (!robots.includes(`Sitemap: ${ORIGIN}/sitemap.xml`)) {
  fail("robots.txt: missing Sitemap reference");
}
for (const frag of ["/api/", "/admin", "/profile", "/history", "/resumes", "/credits"]) {
  if (!robots.includes(`Disallow: ${frag}`)) fail(`robots.txt: missing Disallow ${frag}`);
}
if (!/User-agent:\s*\*[\s\S]*Allow:\s*\//.test(robots)) {
  fail("robots.txt: public routes must remain crawlable (Allow: /)");
}

// --- og-image asset ------------------------------------------------------

if (!existsSync(pub("og-image.png"))) {
  fail("og-image.png referenced in metadata but missing from client/public/");
}

// --- report --------------------------------------------------------------

if (failures.length > 0) {
  console.error("SEO verification failed:\n");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log("OK: SEO invariants present.");
console.log(`  - sitemap.xml: valid XML, ${locs.length} clean URLs, all with <lastmod>, no '#'`);
console.log("  - seo-pages.ts routes in sync with sitemap and HTML files");
console.log("  - each SEO page: one H1, H2s, canonical, robots, OG/Twitter, JSON-LD");
console.log("  - robots.txt: sitemap reference + private routes blocked + public crawlable");
console.log("  - og-image.png present");
