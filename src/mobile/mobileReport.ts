import { buildAnnualIndex, buildAnnualReport, buildPersonalSummary,
  type AnnualCard, type AnnualOverviewData, type AnnualRhythmData, type AnnualMonthlyData,
  type AnnualCreatorsData, type AnnualInterestsData, type AnnualKeptData, type AnnualHighlightsData,
  type AnnualSummaryData } from "../domain/annualReport";
import { buildLivingReport } from "../domain/livingReport";
import { COLLECTION_TYPES, personalRecords, type MobileSnapshot } from "./collectionData";

export type ReportMode = "summary" | "living" | "annual";
export interface ReportSection {
  title: string;
  description: string;
  metrics: Array<{ label: string; value: string }>;
  bars: Array<{ label: string; count: number }>;
  notes: string[];
}
export interface MobileReport {
  title: string;
  subtitle: string;
  coverage: string;
  years: number[];
  year: number | null;
  sections: ReportSection[];
}

function cardSection(card: AnnualCard): ReportSection {
  const section: ReportSection = { title: card.title, description: card.description,
    metrics: [], bars: [], notes: [...new Set([card.reason, ...card.notices].filter((item): item is string => Boolean(item)))] };
  const metric = (label: string, value: string | number | null) => section.metrics.push({ label, value: value === null ? "暂无" : String(value) });
  switch (card.id) {
    case "overview": {
      const data = card.data as AnnualOverviewData;
      metric("观看作品", data.counts.watch); metric("喜欢作品", data.counts.liked); metric("收藏作品", data.counts.favorite); metric("活跃天数", data.activeDays);
      if (data.dateRange) section.notes.push(`行为时间覆盖 ${data.dateRange.start} 至 ${data.dateRange.end}`);
      break;
    }
    case "rhythm": {
      const data = card.data as AnnualRhythmData;
      if (card.status === "ok") {
        metric("最活跃时段", data.mostActiveHour ? `${data.mostActiveHour.hour}:00` : null);
        metric("最活跃星期", data.mostActiveWeekday ? `周${["一", "二", "三", "四", "五", "六", "日"][data.mostActiveWeekday.weekday]}` : null);
        section.bars = Array.from({ length: 6 }, (_, group) => ({ label: `${group * 4}—${group * 4 + 3} 时`,
          count: data.heatmap.filter(item => Math.floor(item.hour / 4) === group).reduce((sum, item) => sum + item.count, 0) }));
      }
      break;
    }
    case "monthly": {
      section.description = "按可靠的喜欢、收藏行为时间观察每月变化";
      const data = card.data as AnnualMonthlyData;
      if (card.status === "ok") section.bars = data.months.map(item => ({ label: item.label, count: (item.liked ?? 0) + (item.favorite ?? 0) }));
      break;
    }
    case "creators": {
      const data = card.data as AnnualCreatorsData;
      metric("创作者", data.creatorCount);
      section.bars = data.top.slice(0, 8).map(item => ({ label: item.name, count: item.count }));
      break;
    }
    case "interests": {
      const data = card.data as AnnualInterestsData;
      section.bars = data.topics.slice(0, 8).map(item => ({ label: `#${item.name}`, count: item.count }));
      metric("平均作品时长", data.durationStats.averageSeconds === null ? null : `${Math.round(data.durationStats.averageSeconds)} 秒`);
      if (data.music[0]) metric("常见音乐", data.music[0].title);
      break;
    }
    case "kept": {
      const data = card.data as AnnualKeptData;
      metric("看过且喜欢", data.pairwise.watchLiked); metric("看过且收藏", data.pairwise.watchFavorite);
      metric("喜欢且收藏", data.pairwise.likedFavorite); metric("三类交集", data.allThree);
      section.notes.push("基于本机累计采集的列表；取消喜欢或收藏不会删除已保存的记录。");
      break;
    }
    case "highlights": {
      const data = card.data as AnnualHighlightsData;
      if (data.first) metric("最早的记录", data.first.title);
      if (data.last) metric("最近的记录", data.last.title);
      if (data.longest) metric("最长的作品", data.longest.title);
      break;
    }
    case "summary": {
      section.title = "你的内容摘要";
      section.description = "把这份本机记录里的主要线索放在一起";
      const data = card.data as AnnualSummaryData;
      metric("不同作品", data.metrics.totalUniqueVideos); metric("创作者", data.metrics.creatorCount);
      if (data.metrics.topCreator) metric("常见创作者", data.metrics.topCreator.name);
      if (data.metrics.topTopic) metric("常见话题", data.metrics.topTopic.name);
      break;
    }
  }
  return section;
}

export function buildMobileReport(snapshot: MobileSnapshot, mode: ReportMode, requestedYear?: number): MobileReport {
  const records = personalRecords(snapshot);
  const unfinished = COLLECTION_TYPES.filter(({ id }) => !snapshot.collections[id].updatedAt || snapshot.collections[id].hasMore);
  const options = { source: "collector", partial: unfinished.length > 0, sourceUpdatedAt: snapshot.savedAt,
    warnings: [] as string[] };
  const index = buildAnnualIndex(records, options);
  const year = requestedYear && index.availableYears.includes(requestedYear) ? requestedYear : index.defaultYear;
  const coverage = `${index.coverage.recordCount} 条记录 · ${index.coverage.uniqueVideoCount} 个作品 · ${index.coverage.reliableRecordCount} 条有可靠行为时间。`
    + (unfinished.length ? ` ${unfinished.map(item => item.label).join("、")}尚未读到末页。` : " 已到平台当前可读取的末页，不代表完整历史。")
    + " 喜欢与收藏按本机累计列表统计，缺失操作时间不推测。";
  const subtitle = `${snapshot.account.nickname} · 数据更新于 ${new Date(snapshot.savedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })} · 北京时间`;
  if (mode === "living") {
    const living = buildLivingReport(records, options);
    return { title: "近期报告", subtitle, coverage, years: index.availableYears, year,
      sections: living.chapters.map(chapter => ({ title: chapter.title, description: chapter.narrative,
        metrics: chapter.signals.slice(0, 6).map(signal => ({ label: signal.label, value: signal.value })), bars: [],
        notes: chapter.notice ? [chapter.notice] : [],
      })) };
  }
  if (mode === "annual" && year === null) return { title: "年度回顾", subtitle, coverage, years: [], year: null,
    sections: [{ title: "还没有可归属年份的记录", description: "采集到带有真实观看时间的历史后，会自动出现可选年份。你仍可查看内容概览与喜欢、收藏的交集。", metrics: [], bars: [], notes: [] }] };
  const report = mode === "annual" ? buildAnnualReport(index, year!) : buildPersonalSummary(records, options);
  return { title: mode === "annual" ? `${report.periodLabel} · 年度回顾` : "内容概览", subtitle, coverage,
    years: index.availableYears, year, sections: report.cards.map(cardSection) };
}

// Hermes has no JIT: one report costs a few hundred ms on a phone. A snapshot never mutates, so key the results by it.
const reports = new WeakMap<MobileSnapshot, Map<string, MobileReport>>();
export function cachedReport(snapshot: MobileSnapshot, mode: ReportMode, year?: number): MobileReport | undefined {
  return reports.get(snapshot)?.get(`${mode}:${year ?? ""}`);
}
export function reportFor(snapshot: MobileSnapshot, mode: ReportMode, year?: number): MobileReport {
  let byKey = reports.get(snapshot);
  if (!byKey) reports.set(snapshot, byKey = new Map());
  const key = `${mode}:${year ?? ""}`;
  let report = byKey.get(key);
  if (!report) byKey.set(key, report = buildMobileReport(snapshot, mode, year));
  return report;
}

export function reportHtml(report: MobileReport): string {
  const escape = (value: string) => value.replace(/[&<>"']/gu, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(report.title)}</title>
<style>body{max-width:760px;margin:0 auto;padding:28px 20px;background:#f6f5f0;color:#203a2a;font:16px/1.7 system-ui,sans-serif}h1{line-height:1.3}h2{font-size:21px}section{background:white;border:1px solid #dfe5dc;border-radius:18px;padding:22px;margin:20px 0}small,p{color:#59655b}.metrics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.metric{overflow-wrap:anywhere}.metric strong{display:block;font-size:21px}label{display:block;margin-top:12px}meter{width:100%;height:12px}li{font-size:13px}</style>
<small>DOUYIN DATA REVIEW · 本机报告</small><h1>${escape(report.title)}</h1><p>${escape(report.subtitle)}</p><p>${escape(report.coverage)}</p>
${report.sections.map(section => `<section><h2>${escape(section.title)}</h2><p>${escape(section.description)}</p><div class="metrics">${section.metrics.map(item => `<div class="metric"><small>${escape(item.label)}</small><strong>${escape(item.value)}</strong></div>`).join("")}</div>
${section.bars.map(item => `<label>${escape(item.label)} · ${item.count}</label><meter value="${item.count}" max="${Math.max(1, ...section.bars.map(bar => bar.count))}"></meter>`).join("")}
${section.notes.length ? `<ul>${section.notes.map(note => `<li>${escape(note)}</li>`).join("")}</ul>` : ""}</section>`).join("")}
<p>数据和报告在手机本地处理。缺失时间未使用作品发布时间或采集时间填补。</p></html>`;
}
