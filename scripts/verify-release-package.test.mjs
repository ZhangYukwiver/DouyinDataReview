import { describe, expect, it } from "vitest";

import { assertPublicPackagePath } from "./verify-release-package.mjs";

describe("release privacy boundary", () => {
  it.each([
    ".local-data/records.json",
    "collector/records.json",
    "dist/direct-history-template.json",
    "browser-profile/Default/Cookies",
    "app.asar.unpacked/browser-profile/Default/Network/Cookies",
    "dist/profile/Preferences",
    "dist/Local State",
    "dist/Login Data-journal",
    "dist/.env.local",
    "dist/../records.json",
    "collector\\records.json",
  ])("rejects personal runtime data at any package depth: %s", (name) => {
    expect(() => assertPublicPackagePath(name)).toThrow();
  });

  it.each([
    "collector/directHistory.mjs",
    "collector/douyinCollector.mjs",
    "app.asar.unpacked/collector/directSignerRunner.cjs",
    "node_modules/playwright-core/lib/server/cookieStore.js",
    "direct-signer/lib/runtime/bdms/env.js",
    "dist/_expo/static/js/web/AppEntry-example.js",
  ])("allows shipped application code: %s", (name) => {
    expect(() => assertPublicPackagePath(name)).not.toThrow();
  });
});
