import { afterEach, describe, expect, it, vi } from "vitest";
import { NsisUpdater } from "electron-updater";
import { createAppUpdateController } from "./appUpdater.mjs";
import { DesktopUpdateProvider } from "./updateProvider.mjs";
import { DOWNLOAD_MIRRORS, DOWNLOAD_PAGE, RELEASE_REPOSITORY } from "../docs/downloadSources.mjs";

const version = "1.10.0";
const releases = `https://github.com/${RELEASE_REPOSITORY}/releases`;
const api = `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases`;
const exe = `DouyinDataReview-Setup-${version}.exe`;
const dmg = `DouyinDataReview-${version}-arm64.dmg`;
const deb = `DouyinDataReview-${version}-amd64.deb`;
const sha512 = Buffer.alloc(64, 1).toString("base64");
const manifest = name => `version: ${version}\nfiles:\n  - url: ${name}\n    sha512: ${sha512}\n`;
const release = () => Response.json({ tag_name: `v${version}`, assets: [{ name: exe }, { name: dmg }, { name: "latest.yml", id: 2 }] });
const unavailable = () => new Response(null, { status: 503 });
const offline = async () => { throw new Error("offline"); };
const controllers = [];
afterEach(() => { controllers.splice(0).forEach(controller => controller.dispose()); });

function setup({ platform = "win32", currentVersion = "1.9.0", direct = vi.fn(offline), fetch = vi.fn(unavailable) } = {}) {
  const updater = new NsisUpdater(null, { version: currentVersion, isPackaged: true, whenReady: async () => {} });
  updater.logger = null;
  updater._testOnlyOptions = { platform };
  updater.stagingUserIdPromise = { value: Promise.resolve("test-user") };
  updater.httpExecutor = { request: direct };
  const [owner, repo] = RELEASE_REPOSITORY.split("/");
  updater.setFeedURL({ provider: "custom", owner, repo, updateProvider: DesktopUpdateProvider, fetch });
  const openDownloadPage = vi.fn();
  const controller = createAppUpdateController({ platform, currentVersion, updater, isPackaged: true, openDownloadPage });
  controllers.push(controller);
  return { controller, updater, openDownloadPage, fetch, direct };
}

describe("desktop update sources", () => {
  it("keeps the normal GitHub check first and reuses the official manifest for downloads", async () => {
    const direct = vi.fn()
      .mockResolvedValueOnce(`<feed><entry><link href="${releases}/tag/v${version}"/><title>Release</title></entry></feed>`)
      .mockResolvedValueOnce(JSON.stringify({ tag_name: `v${version}` }))
      .mockResolvedValueOnce(manifest(exe));
    const { controller, fetch } = setup({ direct });
    expect(await controller.check()).toMatchObject({ phase: "available", version, manualDownload: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("loads Windows checksum metadata via the asset API even when github.com is unreachable", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(release()).mockResolvedValueOnce(new Response(manifest(exe)));
    const { controller, updater } = setup({ fetch });
    expect(await controller.check()).toMatchObject({ phase: "available", version, manualDownload: false });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([`${api}/latest`, `${api}/assets/2`]);
    const { info, provider } = updater.updateInfoAndProvider;
    const [file] = provider.resolveFiles(info);
    expect(file.url.href).toBe(`${releases}/download/v${version}/${exe}`);
    expect(file.info.sha512).toBe(sha512);
  });

  it("offers a confirmed API release manually when the official Windows checksum is unavailable", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(release()).mockResolvedValueOnce(unavailable());
    const { controller, openDownloadPage } = setup({ fetch });
    expect(await controller.check()).toMatchObject({ phase: "available", version, manualDownload: true });
    await controller.download();
    expect(openDownloadPage).toHaveBeenCalledWith(DOWNLOAD_PAGE);
  });

  it.each([["darwin", "latest-mac.yml", dmg], ["win32", "latest.yml", exe], ["linux", "latest-linux.yml", deb]])("skips failed/invalid mirrors and uses the working %s route", async (platform, channel, installer) => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(new Response("<html>gateway</html>"))
      .mockResolvedValueOnce(new Response(manifest("unexpected-file")))
      .mockResolvedValueOnce(new Response(manifest(installer)));
    const { controller, openDownloadPage } = setup({ platform, fetch });
    expect(await controller.check()).toMatchObject({ phase: "available", version, manualDownload: true });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      `${api}/latest`, ...DOWNLOAD_MIRRORS.map(mirror => `${mirror}${releases}/latest/download/${channel}`),
    ]);
    await controller.download();
    expect(openDownloadPage).toHaveBeenCalledWith(`${DOWNLOAD_MIRRORS[2]}${releases}/download/v${version}/${installer}`);
  });

  it.each([version, "1.11.0"])("does not offer a downgrade for installed %s", async currentVersion => {
    const fetch = vi.fn().mockResolvedValueOnce(release());
    const { controller } = setup({ currentVersion, fetch });
    expect(await controller.check()).toMatchObject({ phase: "up-to-date" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("shares concurrent checks and leaves the download page available after exhausting all sources", async () => {
    const { controller, fetch, direct, openDownloadPage } = setup();
    await Promise.all([controller.check(), controller.check()]);
    expect(direct).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1 + DOWNLOAD_MIRRORS.length);
    expect(controller.getState()).toMatchObject({ phase: "error", manualDownload: true });
    expect(openDownloadPage).not.toHaveBeenCalled();
    await controller.download();
    expect(openDownloadPage).toHaveBeenCalledWith(DOWNLOAD_PAGE);
  });
});
