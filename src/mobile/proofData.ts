// The proof stores one bounded page, with no cookies, request URLs, or raw responses.
export interface ProofRecord {
  id: string;
  title: string;
  author: string;
  watchedAt: string | null;
}

export interface ProofSnapshot {
  version: 1;
  revision: number;
  savedAt: string;
  account: { id: string; nickname: string };
  records: ProofRecord[];
  hasMore: boolean;
}

export const MAX_PROOF_BYTES = 128_000;
export const HISTORY_PAGE = "https://www.douyin.com/user/self?showTab=record";
export const BROWSER_BOOTSTRAP_URL = "https://localhost.invalid/";

export function isBootstrapSource(value: string): boolean {
  if (value === "about:blank") return true;
  try {
    // Android WebMessageListener reports an origin; the fallback bridge reports the full URL.
    return new URL(value).href === BROWSER_BOOTSTRAP_URL;
  } catch { return false; }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("数据格式不正确，原有记录已保留。");
  return value as Record<string, unknown>;
}

function text(value: unknown, limit: number): string {
  if (typeof value !== "string" || value.length > limit) throw new Error("数据字段不正确，原有记录已保留。");
  return value;
}

function identifier(value: unknown): string {
  const id = text(value, 30);
  if (!/^[1-9]\d{0,29}$/u.test(id)) throw new Error("账号或视频编号无效，未保存本次结果。");
  return id;
}

export function isDouyinPage(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "www.douyin.com" && !url.port && !url.username && !url.password;
  } catch { return false; }
}

export function isLoginNavigation(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.port && !url.username && !url.password
      && ["douyin.com", "iesdouyin.com", "snssdk.com", "amemv.com", "bytedance.com", "zijieapi.com"]
        .some(host => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch { return false; }
}

export function parsePage(value: unknown): Pick<ProofSnapshot, "account" | "records" | "hasMore"> {
  const payload = object(value);
  const account = object(payload.account);
  if (!Array.isArray(payload.records) || payload.records.length > 20 || typeof payload.hasMore !== "boolean") {
    throw new Error("读取结果不是有效的一页记录，未保存本次结果。");
  }
  const records = payload.records.map((item): ProofRecord => {
    const row = object(item);
    let watchedAt: string | null = null;
    if (row.watchedAt !== null) {
      const raw = text(row.watchedAt, 30);
      const date = new Date(raw);
      if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 2000 || date.getUTCFullYear() > 2100) {
        throw new Error("观看时间格式无效，未保存本次结果。");
      }
      watchedAt = date.toISOString();
    }
    return { id: identifier(row.id), title: text(row.title, 500), author: text(row.author, 100), watchedAt };
  });
  return { account: { id: identifier(account.id), nickname: text(account.nickname, 100) }, records, hasMore: payload.hasMore };
}

export function parseSnapshot(raw: string): ProofSnapshot {
  if (raw.length > MAX_PROOF_BYTES) throw new Error("本机记录文件超过验证版容量。");
  const value = object(JSON.parse(raw));
  if (value.version !== 1 || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1) {
    throw new Error("本机记录文件版本不正确。");
  }
  const savedAt = text(value.savedAt, 30);
  if (!Number.isFinite(Date.parse(savedAt))) throw new Error("本机记录保存时间无效。");
  return { version: 1, revision: Number(value.revision), savedAt, ...parsePage(value) };
}

export const READER_ERRORS: Record<string, string> = {
  page: "请回到抖音个人主页后再读取。",
  template: "请在下方网页登录，并打开自己的「观看历史」，等待列表显示后再点读取。",
  login: "抖音尚未确认登录，请在下方网页完成登录或身份验证。",
  account: "读取过程中账号发生变化，请确认账号后重试。",
  timeout: "读取超时，原有记录已保留。请检查网络后重试。",
  network: "网络请求失败，原有记录已保留。",
  rejected: "抖音拒绝了本次请求，请在网页检查登录或验证提示。原有记录已保留。",
  limited: "抖音暂时限制了读取，请稍后再试。",
  format: "抖音返回的记录格式暂不兼容，原有记录已保留。",
};
