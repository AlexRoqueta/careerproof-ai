import express from 'express';
import type { Express, Request, Response } from 'express';
import fs from "node:fs";
import path from "node:path";
import { SEO_PAGE_ROUTES } from "./seo-pages";

export function serveStatic(app: Express) {
  const distPath = path.resolve(__dirname, "public");
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }

  app.use(express.static(distPath));

  // Public SEO routes — crawler-friendly clean URLs that resolve to
  // pre-rendered static HTML in dist/public/seo/. The SPA hash-router
  // owns /#/* paths; these take the bare path (no fragment) so search
  // engines can index real <title> / <meta> / schema markup.
  for (const route of SEO_PAGE_ROUTES) {
    app.get(route.path, (_req: Request, res: Response) => {
      res.sendFile(path.resolve(distPath, "seo", route.file));
    });
  }

  // SPA fallback. Only serve index.html for navigation-style requests
  // (no file extension, or explicit .html). Returning index.html for a
  // missing /assets/fonts/Inter-*.woff2 made the browser try to decode
  // HTML as a font and surface OTS "invalid sfntVersion" errors. Any
  // request that looks like a static asset (has an extension other than
  // .html) gets a proper 404 instead.
  app.use("/{*path}", (req: Request, res: Response) => {
    const urlPath = req.path;
    const ext = path.extname(urlPath).toLowerCase();
    if (ext && ext !== ".html") {
      res.status(404).type("text/plain").send("Not found");
      return;
    }
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
