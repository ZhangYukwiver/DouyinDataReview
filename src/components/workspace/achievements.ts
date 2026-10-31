import { useSyncExternalStore } from "react";

/**
 * 成就：38 枚奖章（数据采集 15、功能使用 18、初次成就 5），奖章和收藏卡是 public/achievements 下的 SVG。
 * 计数规则：数据类按当前记录数，够了就解锁、记录少了也不收回；功能类只从这一版起数成功的那几次，以前的不追算；
 * 下载和文件夹整理按不同作品数。全存在本机 localStorage（dy2.achievements）。
 * ponytail: 不分账号，换号以后各账号的计数混在一起；要分账号再按 account id 分键存。
 */
const FAMILIES = [
  ["watch", "观看历史", "data", ["拾光者", "时光编目员", "记忆馆长"], [100, 1000, 10000], "保存 {n} 条观看记录", "把看过的片刻，编成自己的时间。"],
  ["likes", "喜欢列表", "data", ["心动留痕", "喜好收藏家", "品味档案馆"], [50, 500, 5000], "保存 {n} 条喜欢记录", "每一次心动，都有迹可循。"],
  ["favorites", "收藏列表", "data", ["随手珍藏", "私人宝库", "灵感博物馆"], [20, 200, 2000], "保存 {n} 条收藏记录", "舍不得划走的，值得好好珍藏。"],
  ["chat", "好友聊天", "data", ["字里行间", "对话成册", "万语千言"], [100, 1000, 10000], "保存 {n} 条好友聊天消息", "那些说过的话，仍有回响。"],
  ["total", "数据总量", "data", ["档案起步", "万条成卷", "十万珍藏"], [1000, 10000, 100000], "保存 {n} 条视频类记录", "零散的记录，汇成一座档案馆。"],
  ["export", "数据导出", "usage", ["留一份底稿", "备份有方", "记忆守护者"], [1, 5, 20], "成功导出 {n} 次非空备份", "给珍贵的记忆，留一份底稿。"],
  ["download", "视频下载", "usage", ["随身一份", "离线片库", "私人放映室"], [1, 20, 100], "成功下载 {n} 个不同作品", "喜欢的作品，随时都能重逢。"],
  ["search", "内容搜索", "usage", ["寻迹", "顺藤摸瓜", "档案侦探"], [1, 20, 100], "完成 {n} 次有效搜索", "沿着线索，找回记忆中的那一条。"],
  ["organize", "文件夹整理", "usage", ["收拾一下", "井井有条", "整理大师"], [10, 100, 500], "归档 {n} 个不同作品", "让每一份喜欢，都有自己的位置。"],
  ["report", "年度报告导出", "usage", ["故事成形", "时光装订", "年度出版人"], [1, 5, 20], "成功导出 {n} 次年度报告", "把一年的片刻，装订成自己的故事。"],
  ["assistant", "AI 助手", "usage", ["初次对话", "默契搭档", "灵感同行"], [1, 20, 100], "完成 {n} 轮有效问答", "从一个问题，走向更多发现。"],
] as const;
const SPECIALS = [
  ["first-memory", "第一片记忆", "首次成功保存真实数据", "从这一刻开始，记忆有了自己的位置。"],
  ["three-volumes", "三册齐备", "观看、喜欢、收藏三类均有记录", "看过的、喜欢的、舍不得丢的，都在这里。"],
  ["found-it", "找回那一条", "首次从搜索结果打开作品", "原来它一直在这里。"],
  ["restore", "有备而来", "首次成功导入非空备份", "旧日记录，重新归位。"],
  ["my-year", "属于我的年度", "首次打开真实数据生成的年度报告", "这一年的故事，由你的记录写成。"],
] as const;

export type AchievementGroup = "data" | "usage" | "special";
export type SpecialAchievement = (typeof SPECIALS)[number][0];
type Counted = "export" | "search" | "report" | "assistant";
type UniqueWorks = "download" | "organize";

export interface Achievement {
  id: string;
  family: string;
  name: string;
  category: string;
  group: AchievementGroup;
  /** 0 是初次成就的纪念章 */
  tier: number;
  threshold: number;
  condition: string;
  line: string;
  medal: string;
  card: string;
}

export const ACHIEVEMENTS: Achievement[] = [
  ...FAMILIES.flatMap(([family, category, group, names, thresholds, condition, line]) => names.map((name, index) => ({
    id: `${family}-${index + 1}`, family, name, category, group, tier: index + 1, threshold: thresholds[index]!,
    condition: condition.replace("{n}", thresholds[index]!.toLocaleString("en-US")), line,
  }))),
  ...SPECIALS.map(([id, name, condition, line]) => ({ id, family: id, name, category: "初次成就", group: "special" as const, tier: 0, threshold: 1, condition, line })),
].map((item) => ({ ...item, medal: `/achievements/medals/${item.id}.svg`, card: `/achievements/cards/${item.id}.svg` }));

const TOP = Object.fromEntries(FAMILIES.map(([family, , , , thresholds]) => [family, thresholds[2]]));

export interface AchievementState {
  /** 已获得：id → 获得日期 2026.10.31 */
  got: Record<string, string>;
  /** 各类当前计数 */
  n: Record<string, number>;
  /** 下载、整理过的作品编号，按不同作品数，满了最高一档就不再记 */
  ids: Partial<Record<UniqueWorks, string[]>>;
  /** 点开看过的；获得了还没看过的在侧栏挂个小点 */
  seen: string[];
  /** 侧栏徽章墙拖出来的顺序：pioneer 和成就的类别（family），升档不挪位置；没拖过就没有 */
  order?: string[];
}

const KEY = "dy2.achievements";
const EMPTY: AchievementState = { got: {}, n: {}, ids: {}, seen: [] };
const listeners = new Set<() => void>();
let current: AchievementState | null = null;

function read(): AchievementState {
  if (current) return current;
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? "null") as Partial<AchievementState> | null;
    current = { ...EMPTY, ...(saved && typeof saved === "object" ? saved : {}) };
  } catch { current = EMPTY; }
  return current;
}

function today(): string {
  const now = new Date();
  return `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, "0")}.${String(now.getDate()).padStart(2, "0")}`;
}

/** 当前进度：初次成就是 0 / 1 */
export function progressOf(state: AchievementState, item: Achievement): number {
  return item.group === "special" ? (state.got[item.id] ? 1 : 0) : state.n[item.family] ?? 0;
}

// 改完再看一遍够没够门槛；没变就不写、不通知
function update(change: (draft: AchievementState) => void) {
  const before = read();
  const draft: AchievementState = { ...before, got: { ...before.got }, n: { ...before.n }, ids: { ...before.ids } };
  change(draft);
  for (const item of ACHIEVEMENTS) {
    if (!draft.got[item.id] && item.group !== "special" && progressOf(draft, item) >= item.threshold) draft.got[item.id] = today();
  }
  if (JSON.stringify(draft) === JSON.stringify(before)) return;
  current = draft;
  try { globalThis.localStorage?.setItem(KEY, JSON.stringify(draft)); } catch { /* 存不下就只在这次打开里算 */ }
  listeners.forEach((listener) => listener());
}

/** 数据类：真实数据（采集器或导入的文件）的当前条数 */
export function syncDataAchievements(counts: { watch: number; likes: number; favorites: number; chat: number }) {
  update((draft) => {
    const total = counts.watch + counts.likes + counts.favorites;
    Object.assign(draft.n, { watch: counts.watch, likes: counts.likes, favorites: counts.favorites, chat: counts.chat, total });
    if (total + counts.chat > 0) draft.got["first-memory"] ??= today();
    if (counts.watch && counts.likes && counts.favorites) draft.got["three-volumes"] ??= today();
  });
}

/** 功能类：成功一次记一次 */
export function countAchievement(family: Counted, times = 1) {
  if (times > 0) update((draft) => { draft.n[family] = (draft.n[family] ?? 0) + times; });
}

/** 下载、整理：按不同作品记 */
export function noteAchievementWorks(family: UniqueWorks, keys: string[]) {
  update((draft) => {
    const known = new Set(draft.ids[family] ?? []);
    for (const key of keys) if (known.size < TOP[family]!) known.add(key);
    draft.ids[family] = [...known];
    draft.n[family] = known.size;
  });
}

export function unlockAchievement(id: SpecialAchievement) {
  update((draft) => { draft.got[id] ??= today(); });
}

export function setBadgeOrder(keys: string[]) {
  update((draft) => { draft.order = keys; });
}

/** 按拖过的顺序排；没拖过的（新获得的）按原来的先后接在最后，不打乱已经排好的 */
export function arrangeBadges(keys: string[], saved: string[] | undefined): string[] {
  const rank = new Map((saved ?? []).map((key, index) => [key, index]));
  const place = (key: string, index: number) => rank.get(key) ?? rank.size + index;
  return keys.map((key, index) => ({ key, at: place(key, index) })).sort((a, b) => a.at - b.at).map((item) => item.key);
}

export function markAchievementSeen(id: string) {
  update((draft) => { if (!draft.seen.includes(id)) draft.seen = [...draft.seen, id]; });
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const useAchievements = (): AchievementState => useSyncExternalStore(subscribe, read, read);

/** 只给测试用：清掉内存里的那份，下次重新从 localStorage 读 */
export function resetAchievementCache() { current = null; }
