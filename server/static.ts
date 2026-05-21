import express from 'express';
import type { Express, Request, Response } from 'express';
import fs from "node:fs";
import path from "node:path";

export function serveStatic(app: Express) {
  const distPath = path.resolve(__dirname, "public");
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }

  app.use(express.static(distPath));

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
