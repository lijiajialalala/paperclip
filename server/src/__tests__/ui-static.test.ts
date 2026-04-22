import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { isStaticAssetRequestPath, mountStaticUi } from "../ui-static.ts";

function writeUiDist(uiDist: string, assetName: string): void {
  fs.mkdirSync(path.join(uiDist, "assets"), { recursive: true });
  fs.writeFileSync(
    path.join(uiDist, "index.html"),
    `<!DOCTYPE html><html><body><div id="root"></div><script type="module" src="/assets/${assetName}"></script></body></html>`,
    "utf8",
  );
  fs.writeFileSync(path.join(uiDist, "assets", assetName), "console.log('ok');", "utf8");
}

function createStaticUiApp(uiDist: string) {
  const app = express();
  mountStaticUi(app, uiDist);
  return app;
}

describe("static UI fallback", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const tempDir = tempDirs.pop();
      if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("serves the current index shell for company-prefixed navigation routes", async () => {
    const uiDist = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-ui-static-"));
    tempDirs.push(uiDist);
    writeUiDist(uiDist, "index-old.js");

    const app = createStaticUiApp(uiDist);

    const initialNavigation = await request(app).get("/CMPA/inbox/mine");
    expect(initialNavigation.status).toBe(200);
    expect(initialNavigation.text).toContain("/assets/index-old.js");

    fs.rmSync(path.join(uiDist, "assets", "index-old.js"));
    writeUiDist(uiDist, "index-new.js");

    const rootShell = await request(app).get("/");
    expect(rootShell.status).toBe(200);
    expect(rootShell.text).toContain("/assets/index-new.js");

    const companyNavigation = await request(app).get("/CMPA/inbox/mine");
    expect(companyNavigation.status).toBe(200);
    expect(companyNavigation.text).toContain("/assets/index-new.js");
    expect(companyNavigation.text).not.toContain("/assets/index-old.js");
  });

  it("does not fall back to the HTML shell for missing asset requests", async () => {
    const uiDist = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-ui-static-"));
    tempDirs.push(uiDist);
    writeUiDist(uiDist, "index-current.js");

    const app = createStaticUiApp(uiDist);

    const response = await request(app).get("/assets/missing.js");

    expect(response.status).toBe(404);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.text).toBe("Not found");
  });
});

describe("isStaticAssetRequestPath", () => {
  it("treats hashed assets and file-extension requests as static assets", () => {
    expect(isStaticAssetRequestPath("/assets/index-abc123.js")).toBe(true);
    expect(isStaticAssetRequestPath("/favicon.ico")).toBe(true);
    expect(isStaticAssetRequestPath("/CMPA/inbox/mine")).toBe(false);
  });
});
