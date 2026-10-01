import type { PersonalVideoRecord } from "../domain/personalRecords";

// 空格隔开的几个词都要出现在标题、作者、话题或音乐里才算命中，不分大小写，话题前的 # 可带可不带
export function searchRecords(records: PersonalVideoRecord[], query: string): PersonalVideoRecord[] {
  const terms = query.toLowerCase().split(/\s+/u).map((term) => term.replace(/^#+/u, "")).filter(Boolean);
  if (terms.length === 0) return records;
  return records.filter((record) => {
    // 字段之间用换行隔开，免得一个词跨着标题结尾和作者开头凑出命中
    const text = [record.title, record.author, record.music?.title, record.music?.author, ...(record.topics ?? [])]
      .filter(Boolean)
      .join("\n")
      .toLowerCase();
    return terms.every((term) => text.includes(term));
  });
}

export function earliestRecordDate(records: PersonalVideoRecord[]): string | null {
  let earliest: string | null = null;
  for (const record of records) {
    if (record.occurredAt && (!earliest || record.occurredAt < earliest)) earliest = record.occurredAt;
  }
  return earliest;
}
