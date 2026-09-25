import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildWeeklyReport,
  loadSnapshots,
  parseArguments,
  readVariantFile,
  resolveDataDirectory,
} from "./github-traffic.mjs";

const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export async function runReport(options = parseArguments()) {
  if (options.help) {
    console.log("用法：npm run ops:traffic:report -- [--data-dir path]");
    return null;
  }

  const dataDirectory = resolveDataDirectory(options.dataDirectory);
  const snapshots = await loadSnapshots(dataDirectory);
  const variant = await readVariantFile(path.join(MODULE_ROOT, "docs", "promotion", "variants.json"));
  const report = buildWeeklyReport(snapshots, { variant });
  await mkdir(dataDirectory, { recursive: true });
  const reportPath = path.join(dataDirectory, `weekly-report-${new Date().toISOString().slice(0, 10)}.md`);
  await writeFile(reportPath, report, "utf8");
  console.log(report);
  console.log(`报告已保存：${reportPath}`);
  return report;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runReport().catch((error) => {
    console.error(`流量报告失败：${error.message}`);
    process.exitCode = 1;
  });
}
