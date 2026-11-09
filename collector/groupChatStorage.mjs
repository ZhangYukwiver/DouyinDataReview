import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

export function parseGroupConversationIds(value, limit = 1_000) {
  if (!Array.isArray(value) || value.length > limit || !value.every(id => typeof id === "string" && /^\d{1,30}$/u.test(id)))
    throw Object.assign(new Error("群聊白名单必须是有效的群会话 ID 列表（最多 1000 个）。"), { code: "invalid_group_allowlist" });
  return [...new Set(value)];
}

/** 每个账号单独授权，只有白名单中的群可以保留正文。 */
export class GroupChatStorage {
  constructor(directory) {
    this.filePath = path.join(directory, "group-chat-storage.json");
    this.conversationIds = [];
    this.queue = Promise.resolve();
  }

  async load() {
    try {
      const value = JSON.parse(await readFile(this.filePath, "utf8"));
      this.conversationIds = parseGroupConversationIds(value.conversationIds);
    } catch (error) {
      // 配置损坏时停止加载，避免把已有群记录当作未授权数据清掉。
      if (error.code !== "ENOENT") throw error;
    }
    return this;
  }

  allows(id) { return this.conversationIds.includes(id); }

  save(value) {
    const conversationIds = parseGroupConversationIds(value);
    const work = this.queue.then(async () => {
      const temporary = `${this.filePath}.${randomUUID()}.tmp`;
      await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      await writeFile(temporary, JSON.stringify({ conversationIds }), { mode: 0o600 });
      await rename(temporary, this.filePath);
      this.conversationIds = conversationIds;
    });
    this.queue = work.catch(() => undefined);
    return work;
  }
}
