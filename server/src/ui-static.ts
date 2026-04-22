import express from "express";
import fs from "node:fs";
import path from "node:path";
import { applyUiBranding } from "./ui-branding.js";

function readCurrentIndexHtml(indexHtmlPath: string): string {
  return applyUiBranding(fs.readFileSync(indexHtmlPath, "utf-8"));
}

export function isStaticAssetRequestPath(requestPath: string): boolean {
  return requestPath.startsWith("/assets/") || path.extname(requestPath).length > 0;
}

export function mountStaticUi(app: express.Express, uiDist: string): void {
  const indexHtmlPath = path.join(uiDist, "index.html");

  app.use(express.static(uiDist));
  app.get(/.*/, (req, res) => {
    if (isStaticAssetRequestPath(req.path)) {
      res.status(404).type("text/plain").end("Not found");
      return;
    }

    res.status(200).type("html").end(readCurrentIndexHtml(indexHtmlPath));
  });
}
