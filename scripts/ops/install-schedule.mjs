import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPOSITORY = "ZhangYukwiver/DouyinDataReview";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function run(command, args) {
  execFileSync(command, args, { cwd: ROOT, stdio: "inherit", windowsHide: true });
}

function windowsTask(name, schedule, startTime, script, extraArgs = [], days = null) {
  const command = process.execPath;
  const args = [script, "--repo", REPOSITORY, ...extraArgs];
  run("schtasks", [
    "/Create", "/TN", name, "/SC", schedule,
    ...(days ? ["/D", days] : []),
    "/ST", startTime,
    "/TR", `\"${command}\" ${args.map((value) => `\"${value}\"`).join(" ")}`,
    "/F",
  ]);
}

async function installWindows() {
  windowsTask("DouyinDataReview GitHub traffic", "DAILY", "09:00", path.join(ROOT, "scripts", "ops", "github-traffic.mjs"));
  windowsTask("DouyinDataReview weekly promotion report", "WEEKLY", "09:15", path.join(ROOT, "scripts", "ops", "github-traffic-report.mjs"), [], "SUN");
  console.log("已安装 Windows 每日流量采集（09:00）和每周报告（周日 09:15）任务。");
}

async function installMac() {
  const launchAgents = path.join(os.homedir(), "Library", "LaunchAgents");
  await mkdir(launchAgents, { recursive: true });
  const nodePath = process.execPath;
  const trafficScript = path.join(ROOT, "scripts", "ops", "github-traffic.mjs");
  const reportScript = path.join(ROOT, "scripts", "ops", "github-traffic-report.mjs");
  const makePlist = (label, script, calendarInterval) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>${nodePath}</string><string>${script}</string><string>--repo</string><string>${REPOSITORY}</string></array>
  <key>StartCalendarInterval</key><dict>${calendarInterval}</dict>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>StandardOutPath</key><string>/tmp/${label}.out.log</string>
  <key>StandardErrorPath</key><string>/tmp/${label}.err.log</string>
</dict></plist>`;
  const jobs = [
    ["local.douyin-data-review.traffic", trafficScript, "<key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer>"],
    ["local.douyin-data-review.report", reportScript, "<key>Weekday</key><integer>0</integer><key>Hour</key><integer>9</integer><key>Minute</key><integer>15</integer>"],
  ];
  for (const [label, script, interval] of jobs) {
    const plistPath = path.join(launchAgents, `${label}.plist`);
    await writeFile(plistPath, makePlist(label, script, interval), "utf8");
    run("launchctl", ["load", plistPath]);
  }
  console.log("已安装 macOS 每日流量采集（09:00）和每周报告（周日 09:15）任务。");
}

async function main() {
  if (process.platform === "win32") return installWindows();
  if (process.platform === "darwin") return installMac();
  throw new Error("当前自动安装仅支持 Windows 和 macOS；Linux 可使用 cron 调用 npm run ops:traffic 和 npm run ops:traffic:report。");
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`安装运营调度失败：${error.message}`);
    process.exitCode = 1;
  });
}
