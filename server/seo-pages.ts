/* Public SEO landing pages.
 *
 * Each entry maps a clean (non-hash) URL to a pre-rendered static HTML
 * file in client/public/seo/. The file ships with all the SEO metadata
 * (title, description, Open Graph, schema markup) embedded so crawlers
 * see real content even though the rest of the app is a hash-routed SPA.
 *
 * Server registration lives in server/static.ts (production) and
 * server/vite.ts (dev). Keep both wired in sync. Adding a new SEO page
 * is: drop the .html in client/public/seo/, add a row here, and add the
 * <loc> to client/public/sitemap.xml.
 */
export interface SeoPageRoute {
  path: string;
  file: string;
}

export const SEO_PAGE_ROUTES: SeoPageRoute[] = [
  { path: "/ai-job-risk-assessment", file: "ai-job-risk-assessment.html" },
  { path: "/will-ai-replace-my-job", file: "will-ai-replace-my-job.html" },
  { path: "/jobs-at-risk-from-ai", file: "jobs-at-risk-from-ai.html" },
  { path: "/future-proof-your-career", file: "future-proof-your-career.html" },
];
