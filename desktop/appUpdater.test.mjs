import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { createAppUpdateController } from "./appUpdater.mjs";

class FakeUpdater extends EventEmitter {
  checkForUpdates = vi.fn(async () => undefined);
  downloadUpdate = vi.fn(async () => undefined);
  quitAndInstall = vi.fn();
}

function controllerFor(updater, extra = {}) {
  const states = [];
  const controller = createAppUpdateController({
    updater,
    isPackaged: true,
    platform: "win32",
    currentVersion: "1.2.3",
    emit: (state) => states.push(state),
    initialDelayMs: 0,
    checkIntervalMs: 60_000,
    ...extra,
  });
  return { controller, states };
}

describe("desktop app updater", () => {
  it("keeps the updater opt-in and publishes an available update", async () => {
    const updater = new FakeUpdater();
    const { controller } = controllerFor(updater);
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);

    updater.checkForUpdates.mockImplementationOnce(async () => {
      updater.emit("update-available", {
        version: "1.3.0",
        releaseName: "春季更新",
        releaseNotes: [{ note: "修复稳定性问题" }],
      });
    });
    await controller.check();

    expect(controller.getState()).toMatchObject({
      phase: "available",
      currentVersion: "1.2.3",
      version: "1.3.0",
      releaseName: "春季更新",
      releaseNotes: "修复稳定性问题",
      progress: 0,
    });
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it("reports progress and only installs after a downloaded update", async () => {
    const updater = new FakeUpdater();
    const beforeInstall = vi.fn(async () => undefined);
    const { controller } = controllerFor(updater, { beforeInstall });

    expect(await controller.install()).toBe(false);
    updater.emit("update-available", { version: "1.3.0" });
    updater.emit("download-progress", { percent: 43.4, bytesPerSecond: 12, transferred: 43, total: 100 });
    expect(controller.getState()).toMatchObject({ phase: "downloading", progress: 43.4, transferred: 43, total: 100 });
    updater.emit("update-downloaded", { version: "1.3.0" });

    expect(await controller.install()).toBe(true);
    expect(beforeInstall).toHaveBeenCalledTimes(1);
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it("does not start two installation flows at once", async () => {
    const updater = new FakeUpdater();
    let releaseInstall;
    const beforeInstall = vi.fn(() => new Promise((resolve) => {
      releaseInstall = resolve;
    }));
    const { controller } = controllerFor(updater, { beforeInstall });

    updater.emit("update-downloaded", { version: "1.3.0" });
    const first = controller.install();
    const second = controller.install();

    expect(await second).toBe(false);
    expect(beforeInstall).toHaveBeenCalledTimes(1);
    releaseInstall();
    expect(await first).toBe(true);
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed installer launch in an error state", async () => {
    const updater = new FakeUpdater();
    updater.quitAndInstall.mockReturnValueOnce(false);
    const { controller } = controllerFor(updater);

    updater.emit("update-downloaded", { version: "1.3.0" });
    expect(await controller.install()).toBe(false);
    expect(controller.getState()).toMatchObject({ phase: "error", message: "安装更新失败。" });
  });

  it("starts a download only for an available update", async () => {
    const updater = new FakeUpdater();
    const { controller } = controllerFor(updater);

    expect(await controller.download()).toMatchObject({ phase: "idle" });
    updater.emit("update-available", { version: "1.3.0" });
    await controller.download();

    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(controller.getState().phase).toBe("downloading");
  });

  it("does not call the updater in development or on unsupported platforms", async () => {
    const updater = new FakeUpdater();
    const development = createAppUpdateController({ updater, isPackaged: false, platform: "win32" });
    await development.check();
    expect(development.getState()).toMatchObject({ phase: "unsupported", message: "开发模式不会检查应用更新。" });
    expect(updater.checkForUpdates).not.toHaveBeenCalled();

    const linux = createAppUpdateController({ updater, isPackaged: true, platform: "linux" });
    await linux.check();
    expect(linux.getState().phase).toBe("unsupported");
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it("turns updater errors into a retryable state", async () => {
    const updater = new FakeUpdater();
    updater.checkForUpdates.mockRejectedValueOnce(new Error("network unavailable"));
    const { controller } = controllerFor(updater);

    await controller.check();

    expect(controller.getState()).toMatchObject({ phase: "error", error: "network unavailable" });
  });
});
