import { GitHubProvider } from "electron-updater/out/providers/GitHubProvider.js";
import { parseUpdateInfo } from "electron-updater/out/providers/Provider.js";
import { DOWNLOAD_MIRRORS, DOWNLOAD_PAGE } from "../docs/downloadSources.mjs";

const REQUEST_TIMEOUT_MS = 8_000;

export class DesktopUpdateProvider extends GitHubProvider {
  constructor(options, updater, runtime) {
    // GitHubProvider uses this executor for its feed, tag and manifest requests.
    // Cancel the actual request on timeout so a slow direct route yields to the API.
    const metadataExecutor = {
      async request(requestOptions, token) {
        const timer = setTimeout(() => token.cancel(), REQUEST_TIMEOUT_MS);
        try {
          return await runtime.executor.request(requestOptions, token);
        } finally {
          clearTimeout(timer);
        }
      },
    };
    super(options, updater, { ...runtime, executor: metadataExecutor });
    this.fetch = options.fetch;
    this.platform = runtime.platform;
    this.repository = `${options.owner}/${options.repo}`;
    this.api = `https://api.github.com/repos/${this.repository}/releases`;
    this.releases = `https://github.com/${this.repository}/releases`;
    this.manifest = { win32: "latest.yml", linux: "latest-linux.yml" }[this.platform] ?? "latest-mac.yml";
  }

  async getLatestVersion() {
    try {
      const info = await super.getLatestVersion();
      this.updater.currentVersion.compare(info.version); // native semver validation
      return info;
    } catch {
      this.updater.emit("checking-update-source", "GitHub API");
    }

    try {
      return await this.fromApi();
    } catch {
      // A rate limit, invalid release or unreachable API falls through to mirrors.
    }

    for (const mirror of DOWNLOAD_MIRRORS) {
      this.updater.emit("checking-update-source", new URL(mirror).hostname);
      try {
        const url = `${mirror}${this.releases}/latest/download/${this.manifest}`;
        const info = await this.readManifest(url);
        const installer = this.installerName(info.version);
        if (this.updater.currentVersion.compare(info.version) > 0 || !info.files?.some(file => file.url === installer)) continue;
        // The mirror can identify a release, but cannot authorize an in-app install.
        // Construct the manual link locally, ignoring URLs and hashes in its manifest.
        const tag = `v${info.version}`;
        return { version: info.version, tag, manualInstallerUrl: `${mirror}${this.releases}/download/${tag}/${installer}` };
      } catch {
        // Try the next configured route, including after HTML or invalid YAML.
      }
    }
    throw new Error("GitHub、GitHub API 和所有下载镜像均未返回有效的版本信息。");
  }

  installerName(version) {
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/u.test(version)) throw new Error("版本号无效");
    this.updater.currentVersion.compare(version);
    if (this.platform === "win32") return `DouyinDataReview-Setup-${version}.exe`;
    // AppImage 运行时带 APPIMAGE 环境变量，没有就是 deb 装的
    if (this.platform === "linux") return process.env.APPIMAGE ? `DouyinDataReview-${version}-x86_64.AppImage` : `DouyinDataReview-${version}-amd64.deb`;
    return `DouyinDataReview-${version}-arm64.dmg`;
  }

  async request(url, accept = "application/octet-stream") {
    const response = await this.fetch(url, {
      headers: { Accept: accept }, credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response;
  }

  async readManifest(url) {
    const response = await this.request(url);
    return parseUpdateInfo(await response.text(), this.manifest, url);
  }

  async fromApi() {
    const response = await this.request(`${this.api}/latest`, "application/vnd.github+json");
    const release = await response.json();
    const tag = release.tag_name;
    if (release.draft || release.prerelease || !tag?.startsWith("v")) throw new Error("缺少正式发布版本");
    const version = tag.slice(1);
    const installer = this.installerName(version);
    if (!release.assets.some(asset => asset.name === installer)) throw new Error("缺少本平台安装包");
    const info = { version, tag, releaseName: release.name, releaseNotes: release.body, releaseDate: release.published_at };
    const manifest = release.assets.find(asset => asset.name === this.manifest);
    if (this.platform === "win32" && this.updater.currentVersion.compare(version) < 0 && Number.isSafeInteger(manifest?.id)) {
      // Obtain the checksum from the official asset API even when github.com is unreachable.
      try {
        const url = `${this.api}/assets/${manifest.id}`;
        const data = await this.readManifest(url);
        const file = data.files?.find(entry => entry.url === installer && /^[A-Za-z0-9+/]{86}==$/u.test(entry.sha512));
        if (data.version === version && file) {
          return { ...data, ...info, files: [file] };
        }
      } catch {
        // The API already confirmed the release. A missing checksum still permits a manual download.
      }
    }
    return { ...info, manualInstallerUrl: DOWNLOAD_PAGE };
  }
}
