import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

export const DEFAULT_REPOSITORY = "ZhangYukwiver/DouyinDataReview";
export const API_ROOT = "https://api.github.com";
export const TRAFFIC_WINDOW_DAYS = 14;
export const REPORT_WINDOW_DAYS = 7;
export const SNAPSHOT_RETENTION_DAYS = 90;

const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function resolveDataDirectory(explicitDirectory = process.env.DOUYIN_OPS_DATA_DIR) {
  if (explicitDirectory) return path.resolve(explicitDirectory);

  if (process.platform === "win32") {
    return path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
      "DouyinDataReview",
      "ops",
      "traffic",
    );
  }

  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "DouyinDataReview", "ops", "traffic");
  }

  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "DouyinDataReview", "ops", "traffic");
}

export function parseArguments(argv = process.argv.slice(2)) {
  const options = {
    repository: process.env.GITHUB_REPOSITORY || DEFAULT_REPOSITORY,
    dataDirectory: undefined,
    capturedAt: new Date(),
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--repo") {
      options.repository = argv[++index];
    } else if (argument === "--data-dir") {
      options.dataDirectory = argv[++index];
    } else if (argument === "--as-of") {
      const capturedAt = new Date(argv[++index]);
      if (Number.isNaN(capturedAt.valueOf())) throw new Error("--as-of 必须是有效的 ISO 时间");
      options.capturedAt = capturedAt;
    } else if (argument === "--json") {
      options.json = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new Error(`未知参数：${argument}`);
    }
  }

  if (!options.repository || !/^[^/]+\/[^/]+$/u.test(options.repository)) {
    throw new Error("--repo 必须是 owner/repository 格式");
  }

  return options;
}

export function getGitHubToken() {
  const configuredToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (configuredToken) return configuredToken.trim();

  const result = spawnSync("gh", ["auth", "token"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status === 0 && result.stdout?.trim()) return result.stdout.trim();

  throw new Error("未找到 GitHub 认证。请设置 GH_TOKEN，或先运行 gh auth login。");
}

async function requestJson(endpoint, token) {
  const response = await fetch(`${API_ROOT}${endpoint}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "DouyinDataReview-traffic-monitor",
    },
  });

  const rawBody = await response.text();
  let body = null;
  try {
    body = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    body = null;
  }

  if (!response.ok) {
    const error = new Error(`GitHub API ${response.status} ${response.statusText}`);
    error.status = response.status;
    error.bodyMessage = typeof body?.message === "string" ? body.message : null;
    throw error;
  }

  return body;
}

async function requestOptional(endpoint, token) {
  try {
    return { available: true, status: 200, data: await requestJson(endpoint, token) };
  } catch (error) {
    return {
      available: false,
      status: error.status || null,
      message: error.bodyMessage || error.message,
      data: null,
    };
  }
}

function normalizeTrafficResult(result) {
  if (!result.available) return result;
  return {
    available: true,
    status: result.status,
    data: result.data,
  };
}

function normalizeRepository(repository) {
  return {
    fullName: repository.full_name,
    htmlUrl: repository.html_url,
    description: repository.description,
    stars: repository.stargazers_count,
    forks: repository.forks_count,
    openIssues: repository.open_issues_count,
    watchers: repository.watchers_count,
    updatedAt: repository.updated_at,
  };
}

function normalizeReleases(releases) {
  return releases.map((release) => ({
    tagName: release.tag_name,
    name: release.name,
    htmlUrl: release.html_url,
    publishedAt: release.published_at,
    draft: release.draft,
    prerelease: release.prerelease,
    downloads: release.assets.reduce((total, asset) => total + (asset.download_count || 0), 0),
    assets: release.assets.map((asset) => ({
      name: asset.name,
      downloadCount: asset.download_count || 0,
      size: asset.size,
      contentType: asset.content_type,
      url: asset.browser_download_url,
    })),
  }));
}

export async function collectSnapshot({ repository = DEFAULT_REPOSITORY, token = getGitHubToken(), capturedAt = new Date() } = {}) {
  const encodedRepository = repository.split("/").map(encodeURIComponent).join("/");
  const [repositoryResponse, views, clones, popularPaths, referrers, releases] = await Promise.all([
    requestJson(`/repos/${encodedRepository}`, token),
    requestOptional(`/repos/${encodedRepository}/traffic/views`, token),
    requestOptional(`/repos/${encodedRepository}/traffic/clones`, token),
    requestOptional(`/repos/${encodedRepository}/traffic/popular/paths`, token),
    requestOptional(`/repos/${encodedRepository}/traffic/referrers`, token),
    requestJson(`/repos/${encodedRepository}/releases?per_page=100`, token),
  ]);

  return {
    schemaVersion: 1,
    capturedAt: capturedAt.toISOString(),
    repository: normalizeRepository(repositoryResponse),
    traffic: {
      views: normalizeTrafficResult(views),
      clones: normalizeTrafficResult(clones),
      popularPaths: normalizeTrafficResult(popularPaths),
      referrers: normalizeTrafficResult(referrers),
    },
    releases: normalizeReleases(releases),
  };
}

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

function parseSnapshotDate(filename) {
  const match = /^snapshot-(\d{4}-\d{2}-\d{2})\.json$/u.exec(filename);
  if (!match) return null;
  const parsed = new Date(`${match[1]}T00:00:00.000Z`);
  return Number.isNaN(parsed.valueOf()) ? null : parsed;
}

export async function saveSnapshot(snapshot, dataDirectory = resolveDataDirectory()) {
  await mkdir(dataDirectory, { recursive: true });
  const filename = `snapshot-${dateKey(new Date(snapshot.capturedAt))}.json`;
  const content = `${JSON.stringify(snapshot, null, 2)}\n`;
  await writeFile(path.join(dataDirectory, filename), content, "utf8");
  await writeFile(path.join(dataDirectory, "latest.json"), content, "utf8");

  const cutoff = Date.now() - SNAPSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const entry of await readdir(dataDirectory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const parsed = parseSnapshotDate(entry.name);
    if (parsed && parsed.valueOf() < cutoff) await unlink(path.join(dataDirectory, entry.name));
  }

  return path.join(dataDirectory, filename);
}

export async function loadSnapshots(dataDirectory = resolveDataDirectory()) {
  let entries;
  try {
    entries = await readdir(dataDirectory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  const snapshots = [];
  for (const entry of entries) {
    if (!entry.isFile() || !parseSnapshotDate(entry.name)) continue;
    try {
      snapshots.push(JSON.parse(await readFile(path.join(dataDirectory, entry.name), "utf8")));
    } catch {
      // Ignore an incomplete snapshot and keep the rest of the local history usable.
    }
  }
  return snapshots.sort((left, right) => new Date(left.capturedAt) - new Date(right.capturedAt));
}

export function trafficEntries(snapshot, metric) {
  const result = snapshot?.traffic?.[metric];
  return result?.available && Array.isArray(result.data?.[metric]) ? result.data[metric] : [];
}

export function sumEntries(entries) {
  return entries.reduce((total, entry) => total + (Number(entry.count) || 0), 0);
}

export function uniqueEntries(entries) {
  return entries.reduce((total, entry) => total + (Number(entry.uniques) || 0), 0);
}

export function splitWindow(entries, windowSize = REPORT_WINDOW_DAYS) {
  const ordered = [...entries].sort((left, right) => new Date(left.timestamp) - new Date(right.timestamp));
  return {
    current: ordered.slice(-windowSize),
    previous: ordered.slice(-(windowSize * 2), -windowSize),
  };
}

export function percentChange(current, previous) {
  if (!Number.isFinite(previous) || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

export function latestReleaseDownloads(snapshot) {
  return (snapshot?.releases || []).reduce((total, release) => total + (Number(release.downloads) || 0), 0);
}

function formatPercent(value) {
  if (value === null) return "数据不足";
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function availableStatus(result) {
  if (result?.available) return "可用";
  if (result?.status) return `不可用（HTTP ${result.status}）`;
  return "不可用";
}

function latestSnapshot(snapshots) {
  return snapshots.at(-1) || null;
}

function snapshotAtOrBefore(snapshots, date) {
  const target = date.valueOf();
  return snapshots.filter((snapshot) => new Date(snapshot.capturedAt).valueOf() <= target).at(-1) || null;
}

function pathRows(snapshot) {
  const paths = snapshot?.traffic?.popularPaths;
  if (!paths?.available || !Array.isArray(paths.data)) return [];
  return paths.data.slice(0, 5).map((item) => `| ${item.path} | ${item.title || ""} | ${item.count || 0} | ${item.uniques || 0} |`);
}

function metricRow(label, current, previous) {
  return `| ${label} | ${current} | ${previous} | ${formatPercent(percentChange(current, previous))} |`;
}

function buildRecommendations({ latest, views, clones, downloads, stars, now }) {
  const recommendations = [];
  const latestPublishedAt = latest?.releases?.find((release) => !release.draft && !release.prerelease)?.publishedAt;
  const releaseAgeMs = latestPublishedAt ? now.valueOf() - new Date(latestPublishedAt).valueOf() : Number.POSITIVE_INFINITY;
  const insideReleaseCooldown = releaseAgeMs >= 0 && releaseAgeMs < 48 * 60 * 60 * 1000;

  if (insideReleaseCooldown) {
    recommendations.push("最近 48 小时内有新 Release，本周趋势暂不做强结论，至少等待 48 小时再调整宣传素材。");
  } else {
    const viewEntries = trafficEntries(latest, "views");
    const { current: recentThree, previous: previousThree } = splitWindow(viewEntries, 3);
    const recentThreeTotal = sumEntries(recentThree);
    const previousThreeTotal = sumEntries(previousThree);
    const threeDayChange = percentChange(recentThreeTotal, previousThreeTotal);
    const recentDaysDecrease = recentThree.length === 3 && recentThree.every((entry, index) => index === 0 || Number(entry.count) < Number(recentThree[index - 1].count));

    if (recentDaysDecrease && threeDayChange !== null && threeDayChange <= -30) {
      recommendations.push("Views 连续三天下降超过 30%，建议更换 README 首屏封面或标题，并把当前 poster 素材与另一种风格轮换测试。");
    }

    if (views.change !== null && views.change >= 30 && (stars.change === null || stars.change < 10) && (downloads.change === null || downloads.change < 10)) {
      recommendations.push("访问增长没有带来 Stars 或下载增长，建议缩短首屏说明，强化项目价值和 Star 入口。");
    }

    if (clones.change !== null && clones.change >= 30 && (downloads.change === null || downloads.change < 10)) {
      recommendations.push("Clone 增长而安装包下载没有同步增长，建议把源码运行、架构说明和贡献入口前移。");
    }

    if (downloads.change !== null && downloads.change >= 30 && (stars.change === null || stars.change < 10)) {
      recommendations.push("下载增长而 Stars 没有同步增长，建议在 Release 和 README 增加版本亮点、截图和 Star 提示。");
    }

    if (!recommendations.length) {
      recommendations.push("当前没有触发明确阈值，保持现有素材并继续积累一周数据。");
    }
  }

  if (latest?.traffic?.referrers?.available === false) {
    recommendations.push("来源接口不可用，报告不对外部来源做推断；如需来源分析，请使用有仓库访问权限的认证令牌重试。");
  }

  const oldPath = latest?.traffic?.popularPaths?.data?.find((item) => item.path?.includes("DouyinReview"));
  if (oldPath && oldPath.count > 0) {
    recommendations.push(`旧路径 ${oldPath.path} 仍有访问，建议在 README 或 Release 中保留迁移提示；本报告不自动改动旧路径。`);
  }

  return recommendations;
}

export function buildWeeklyReport(snapshots, { variant = null, now = new Date() } = {}) {
  const latest = latestSnapshot(snapshots);
  if (!latest) return "# GitHub 宣传周报\n\n暂无流量快照，请先运行 `npm run ops:traffic`。\n";

  const previous = snapshotAtOrBefore(snapshots, new Date(new Date(latest.capturedAt).valueOf() - REPORT_WINDOW_DAYS * 24 * 60 * 60 * 1000));
  const viewsWindow = splitWindow(trafficEntries(latest, "views"));
  const clonesWindow = splitWindow(trafficEntries(latest, "clones"));
  const views = {
    current: sumEntries(viewsWindow.current),
    previous: sumEntries(viewsWindow.previous),
    change: percentChange(sumEntries(viewsWindow.current), sumEntries(viewsWindow.previous)),
    uniqueCurrent: uniqueEntries(viewsWindow.current),
    uniquePrevious: uniqueEntries(viewsWindow.previous),
  };
  const clones = {
    current: sumEntries(clonesWindow.current),
    previous: sumEntries(clonesWindow.previous),
    change: percentChange(sumEntries(clonesWindow.current), sumEntries(clonesWindow.previous)),
    uniqueCurrent: uniqueEntries(clonesWindow.current),
    uniquePrevious: uniqueEntries(clonesWindow.previous),
  };
  const currentDownloads = latestReleaseDownloads(latest);
  const previousDownloads = previous ? latestReleaseDownloads(previous) : 0;
  const currentStars = latest.repository?.stars || 0;
  const previousStars = previous?.repository?.stars || currentStars;
  const downloads = { current: currentDownloads, previous: previousDownloads, change: percentChange(currentDownloads, previousDownloads) };
  const stars = { current: currentStars, previous: previousStars, change: percentChange(currentStars, previousStars) };
  const recommendations = buildRecommendations({ latest, views, clones, downloads, stars, now });
  const capturedAt = new Date(latest.capturedAt).toISOString();
  const dataAge = Math.max(0, Math.round((now.valueOf() - new Date(latest.capturedAt).valueOf()) / (60 * 60 * 1000)));
  const variantLine = variant ? `${variant.id}（${variant.label}，位置：${variant.placement}）` : "未配置素材变体";

  return [
    `# GitHub 宣传周报 · ${dateKey(new Date(latest.capturedAt))}`,
    "",
    `数据截至：${capturedAt}（距现在约 ${dataAge} 小时）  `,
    `仓库：${latest.repository?.fullName || DEFAULT_REPOSITORY}`,
    "",
    "## 指标变化",
    "",
    "| 指标 | 当前窗口 | 上一窗口 | 变化 |",
    "| --- | ---: | ---: | ---: |",
    `| Views | ${views.current}（独立访客 ${views.uniqueCurrent}） | ${views.previous}（独立访客 ${views.uniquePrevious}） | ${formatPercent(views.change)} |`,
    `| Clones | ${clones.current}（独立访客 ${clones.uniqueCurrent}） | ${clones.previous}（独立访客 ${clones.uniquePrevious}） | ${formatPercent(clones.change)} |`,
    metricRow("Release 资源下载", downloads.current, downloads.previous),
    metricRow("Stars", stars.current, stars.previous),
    "",
    "## 当前素材",
    "",
    `- 变体：${variantLine}`,
    "- 周期：按 7 天窗口比较，Release 发布后 48 小时内不作强结论。",
    "",
    "## 热门页面",
    "",
    "| 路径 | 页面 | Views | 独立访客 |",
    "| --- | --- | ---: | ---: |",
    ...(pathRows(latest).length ? pathRows(latest) : ["| 数据不可用 | - | - | - |"]),
    "",
    "## 建议动作",
    "",
    ...recommendations.map((recommendation) => `- ${recommendation}`),
    "",
    "## 数据缺口",
    "",
    `- Views：${availableStatus(latest.traffic?.views)}`,
    `- Clones：${availableStatus(latest.traffic?.clones)}`,
    `- 热门页面：${availableStatus(latest.traffic?.popularPaths)}`,
    `- 来源：${availableStatus(latest.traffic?.referrers)}`,
    "",
    "本报告只生成建议，不自动修改 README、Release 或对外发布。",
    "",
  ].join("\n");
}

export async function readVariantFile(filePath = path.join(MODULE_ROOT, "docs", "promotion", "variants.json")) {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    return parsed.variants?.find((variant) => variant.id === parsed.active) || null;
  } catch {
    return null;
  }
}

export function formatSnapshotSummary(snapshot, outputPath) {
  const views = snapshot.traffic.views;
  const clones = snapshot.traffic.clones;
  const viewsCount = views.available ? `${sumEntries(views.data.views)} / ${uniqueEntries(views.data.views)}` : "不可用";
  const clonesCount = clones.available ? `${sumEntries(clones.data.clones)} / ${uniqueEntries(clones.data.clones)}` : "不可用";
  return `已保存 GitHub 流量快照：${outputPath}\nViews（总数 / 独立访客）：${viewsCount}\nClones（总数 / 独立访客）：${clonesCount}`;
}

export async function runCollection(options = parseArguments()) {
  if (options.help) {
    console.log("用法：npm run ops:traffic -- [--repo owner/name] [--data-dir path] [--as-of ISO]");
    return null;
  }
  const token = getGitHubToken();
  const snapshot = await collectSnapshot({ repository: options.repository, token, capturedAt: options.capturedAt });
  const outputPath = await saveSnapshot(snapshot, resolveDataDirectory(options.dataDirectory));
  if (options.json) console.log(JSON.stringify(snapshot, null, 2));
  else console.log(formatSnapshotSummary(snapshot, outputPath));
  return snapshot;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runCollection().catch((error) => {
    console.error(`流量采集失败：${error.message}`);
    process.exitCode = 1;
  });
}
