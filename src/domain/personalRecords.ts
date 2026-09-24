import type { ChatConversationSummary, ChatMessage } from "./chatRecords";

export const PERSONAL_RECORD_TYPES = [
  { id: "watch_history", label: "观看历史" },
  { id: "liked_videos", label: "点赞列表" },
  { id: "favorite_videos", label: "收藏列表" },
] as const;

export type PersonalRecordType = (typeof PERSONAL_RECORD_TYPES)[number]["id"];

/** The source of an event timestamp.  Publication/collection timestamps are
 * deliberately kept separate so annual reports never infer a user action. */
export type PersonalEventTimeSource = "platform_action" | "archive_action" | "unknown";

export type PersonalVideoMediaType = "video" | "image" | "live" | "unknown";

export interface PersonalVideoMusic {
  id?: string | null;
  title?: string | null;
  author?: string | null;
  url?: string | null;
}

export interface PersonalVideoStats {
  playCount?: number | null;
  diggCount?: number | null;
  commentCount?: number | null;
  shareCount?: number | null;
  collectCount?: number | null;
  downloadCount?: number | null;
}

export interface PersonalVideoProgress {
  watchedSeconds?: number | null;
  percent?: number | null;
}

export interface PersonalVideoRecord {
  id: string;
  title: string;
  author: string | null;
  occurredAt: string | null;
  url: string | null;
  /** Stable aweme/video identifier shared by watch, like and favorite rows. */
  videoId?: string | null;
  authorId?: string | null;
  authorAvatarUrl?: string | null;
  occurredAtSource?: PersonalEventTimeSource;
  publishedAt?: string | null;
  coverUrl?: string | null;
  mediaType?: PersonalVideoMediaType;
  durationSeconds?: number | null;
  music?: PersonalVideoMusic | null;
  topics?: string[];
  stats?: PersonalVideoStats | null;
  watchProgress?: PersonalVideoProgress | null;
}

export type PersonalRecordCollection = Record<PersonalRecordType, PersonalVideoRecord[]>;

export interface PersonalArchiveData {
  format: "json" | "zip";
  records: PersonalRecordCollection;
  parsedFileCount: number;
  ignoredFileCount: number;
  warnings: string[];
  // 只有本应用「导出数据」存的文件才带下面这几项
  updatedAt?: string | null;
  chatMessages?: ChatMessage[];
  chatConversations?: ChatConversationSummary[];
  // 记录出自采集器，编号和本机一致，才能并入本机记录；官方档案的编号是另一套，并进去会重复计数
  fromCollector?: boolean;
}

export function createEmptyPersonalRecords(): PersonalRecordCollection {
  return {
    watch_history: [],
    liked_videos: [],
    favorite_videos: [],
  };
}

export function countPersonalRecords(records: PersonalRecordCollection): number {
  return PERSONAL_RECORD_TYPES.reduce((total, item) => total + records[item.id].length, 0);
}
