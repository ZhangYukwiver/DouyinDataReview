// 下载站上的 docs/notice.json：反馈问卷地址和公告。改这份文件就能发公告，不用发版；
// github.io 国内不是处处打得开，拿不到就当没有，别的功能不受影响。
export const SITE_NOTICE_URL = "https://zhangyukwiver.github.io/DouyinDataReview/notice.json";
const DISMISSED_KEY = "content-insights.dismissed-notices";

export interface SiteNotice {
  id: string;
  text: string;
  url: string | null;
}

export interface SiteNotices {
  feedbackUrl: string | null;
  notices: SiteNotice[];
}

interface NoticeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const httpsUrl = (value: unknown) => (typeof value === "string" && /^https:\/\/\S+$/u.test(value) ? value : null);

// 点分数字版本号（1.37.0）；a 比 b 新返回正数
function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] || 0) - (right[index] || 0);
    if (difference) return difference;
  }
  return 0;
}

/**
 * 远端文件谁都可能写错：字段不对的条目丢掉，链接只认 https。
 * 写了 fixedIn 的是已知问题，当前版本已经到了那一版就不再显示；不知道当前版本时照样显示。
 */
export function parseSiteNotices(value: unknown, version: string): SiteNotices {
  const data = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const items: unknown[] = Array.isArray(data.notices) ? data.notices : [];
  return {
    feedbackUrl: httpsUrl(data.feedbackUrl),
    notices: items.flatMap((item) => {
      const { id, text, url, fixedIn } = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
      if (typeof id !== "string" || !id || typeof text !== "string" || !text.trim()) return [];
      if (typeof fixedIn === "string" && version && compareVersions(version, fixedIn) >= 0) return [];
      return [{ id, text: text.trim(), url: httpsUrl(url) }];
    }),
  };
}

export async function loadSiteNotices(version: string): Promise<SiteNotices> {
  const response = await fetch(SITE_NOTICE_URL, { cache: "no-cache" });
  if (!response.ok) throw new Error(`notice_${response.status}`);
  return parseSiteNotices(await response.json(), version);
}

export function loadDismissedNotices(storage: NoticeStorage | undefined = globalThis.localStorage): string[] {
  try {
    const stored: unknown = JSON.parse(storage?.getItem(DISMISSED_KEY) ?? "[]");
    return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function saveDismissedNotices(ids: string[], storage: NoticeStorage | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(DISMISSED_KEY, JSON.stringify(ids));
  } catch {
    // 存不下就只在这次打开期间不再显示
  }
}
