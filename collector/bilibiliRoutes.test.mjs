import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createBilibiliRoutes } from "./bilibiliRoutes.mjs";

async function root() { return mkdtemp(path.join(tmpdir(), "bilibili-routes-")); }

describe("bilibili route adapter", () => {
  it("keeps the normal entry closed until explicitly enabled", async () => {
    const directory = await root();
    try {
      const routes = createBilibiliRoutes({ dataDirectory: directory });
      expect(await routes.handle({ method: "GET", pathname: "/v1/bilibili", loopback: true })).toMatchObject({ status: 404, body: { error: "bilibili_not_released" } });
      expect(await routes.handle({ method: "GET", pathname: "/v1/health", loopback: true })).toBeNull();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("restricts every matching route to the local machine", async () => {
    const directory = await root();
    try {
      const routes = createBilibiliRoutes({ dataDirectory: directory, enabled: true });
      expect(await routes.handle({ method: "GET", pathname: "/v1/bilibili", loopback: false })).toMatchObject({ status: 403, body: { error: "loopback_only" } });
      expect(await routes.handle({ method: "GET", pathname: "/v1/bilibili", loopback: true })).toMatchObject({ status: 200, body: { account: null, snapshot: null, job: null } });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("rejects unsafe unregistered ids and retries a failed content-library callback", async () => {
    const directory = await root();
    let attempts = 0;
    try {
      const routes = createBilibiliRoutes({
        dataDirectory: directory,
        enabled: true,
        contentLibrary: { manualSave: async () => { attempts += 1; if (attempts === 1) throw new Error("temporary library failure"); } },
      });
      expect(await routes.handle({ method: "GET", pathname: "/v1/bilibili", searchParams: new URLSearchParams("account=../escape"), loopback: true })).toMatchObject({ status: 400, body: { error: "invalid_account" } });
      await routes.service.save("default", { bvid: "BV1abCDefGHi", title: "手动保存" });
      expect(attempts).toBe(2);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("does not let one account cancel another account's task", async () => {
    const directory = await root();
    try {
      const routes = createBilibiliRoutes({ dataDirectory: directory, enabled: true });
      routes.service.jobs.set("other-account-job", { accountId: "other", controller: { abort() {} } });
      expect(await routes.handle({ method: "POST", pathname: "/v1/bilibili/cancel", body: { account: "default", jobId: "other-account-job" }, loopback: true })).toMatchObject({
        status: 409, body: { error: "bilibili_account_mismatch" },
      });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("uses the registry platform root directly for the profile and snapshot", async () => {
    const directory = await root();
    const registry = {
      activeId: "default",
      get: id => id === "default" ? { id, platform: "bilibili" } : null,
      directory: account => path.join(directory, account.id === "default" ? "" : path.join("accounts", account.id)),
    };
    try {
      const routes = createBilibiliRoutes({ dataDirectory: directory, accountRegistry: registry, enabled: true });
      await routes.service.save("default", { bvid: "BV1abCDefGHi", title: "手动保存" });
      await expect(access(path.join(directory, "snapshot.json"))).resolves.toBeUndefined();
      await expect(access(path.join(directory, "bilibili", "snapshot.json"))).rejects.toThrow();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

