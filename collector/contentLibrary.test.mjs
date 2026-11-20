import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ContentLibraryStore, contentKey, normalizeContentLibrarySnapshot } from "./contentLibrary.mjs";

async function directory() {
  return mkdtemp(path.join(tmpdir(), "content-library-"));
}

const douyin = {
  platform: "douyin", contentId: "100", contentType: "video", title: "运镜教程", body: "手机运镜和布光技巧", url: "https://www.douyin.com/video/100",
  accountId: "dy-main", accountName: "主号", signals: ["watched", "favorited"],
};

describe("contentKey and snapshot normalization", () => {
  it("uses platform plus native ID and drops unsafe or unknown records", () => {
    expect(contentKey("douyin", "100")).toBe("douyin:100");
    expect(contentKey("other", "100")).toBeNull();
    const snapshot = normalizeContentLibrarySnapshot({ entries: {
      "douyin:100": douyin,
      "xiaohongshu:101": { platform: "xiaohongshu", contentId: "101", title: "笔记" },
      "bad": { platform: "douyin", contentId: "../bad", title: "坏" },
    } });
    expect(Object.keys(snapshot.entries)).toEqual(["douyin:100", "xiaohongshu:101"]);
    expect(snapshot.entries["douyin:100"].sourceAccounts[0].signals).toEqual(["watched", "favorited"]);
  });
});

describe("ContentLibraryStore", () => {
  it("merges the same platform item while keeping account relationships", async () => {
    const root = await directory();
    try {
      const store = new ContentLibraryStore(root);
      await store.upsert(douyin);
      await store.upsert({ ...douyin, accountId: "dy-alt", accountName: "副号", signals: ["liked"], body: null });
      const item = await store.get("douyin:100");
      expect(item.sourceAccounts.map((account) => account.accountId)).toEqual(["dy-alt", "dy-main"]);
      expect(item.sourceAccounts.find((account) => account.accountId === "dy-main").signals).toEqual(["watched", "favorited"]);
      expect(item.sourceAccounts.find((account) => account.accountId === "dy-alt").signals).toEqual(["liked"]);
      expect(item.body).toContain("运镜");
      expect((await store.read({ accountId: "dy-alt" })).items).toHaveLength(1);
      expect((await store.read({ signal: "favorited" })).items).toHaveLength(1);
      const scoped = await store.read({ accountId: "dy-alt", includeText: true });
      expect(scoped.items[0].sourceAccounts).toEqual([expect.objectContaining({ accountId: "dy-alt" })]);
      expect((await store.get("douyin:100", { accountId: "dy-alt" })).sourceAccounts).toEqual([expect.objectContaining({ accountId: "dy-alt" })]);
      expect(await store.get("douyin:100", { accountId: "missing" })).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("supports mixed-platform topics and removes only a detached account", async () => {
    const root = await directory();
    try {
      const store = new ContentLibraryStore(root);
      await store.upsertMany([douyin, {
        platform: "xiaohongshu", contentId: "note-1", contentType: "note", title: "布光笔记", body: "柔光和侧光", url: "https://www.xiaohongshu.com/explore/note-1", accountId: "xhs-main", signals: ["saved"],
      }]);
      const topic = await store.createTopic({ name: "拍摄参考" });
      await store.addToTopic(topic.id, "douyin:100");
      await store.addToTopic(topic.id, "xiaohongshu:note-1");
      expect(new Set((await store.read({ topicId: topic.id })).items.map((item) => item.platform))).toEqual(new Set(["xiaohongshu", "douyin"]));
      expect((await store.accountImpact("dy-main")).topicCount).toBe(1);
      const result = await store.detachAccount("dy-main");
      expect(result.removed).toEqual([]);
      expect((await store.get("douyin:100")).sourceAccounts).toEqual([]);
      expect((await store.get("xiaohongshu:note-1")).sourceAccounts[0].accountId).toBe("xhs-main");
      expect((await store.listTopics())[0].items).toEqual(["douyin:100", "xiaohongshu:note-1"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns scoped question sources with stable citations and a fenced prompt", async () => {
    const root = await directory();
    try {
      const store = new ContentLibraryStore(root);
      await store.upsert(douyin);
      const sources = await store.questionSources({ query: "布光", scope: "item", key: "douyin:100" });
      expect(sources[0].citation).toBe("C1");
      expect(sources[0].entryKey).toBe("douyin:100");
      expect(sources[0].quote).toContain("布光");
      expect(store.buildQuestionPrompt("怎么布光？", sources)).toContain("[C1]");
      expect((await store.questionSources({ query: "总结一下", scope: "item", key: "douyin:100" })).map(source => source.entryKey)).toEqual(["douyin:100"]);
      const topic = await store.createTopic({ name: "另一个范围" });
      expect(await store.questionSources({ query: "布光", scope: "item", key: "douyin:100", topicId: topic.id })).toEqual([]);
      expect(await store.questionSources({ query: "布光", scope: "item", key: "douyin:100", accountId: "missing" })).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("can detach and delete orphaned entries and topic references", async () => {
    const root = await directory();
    try {
      const store = new ContentLibraryStore(root);
      await store.upsert({ ...douyin, accountId: "dy-only" });
      const topic = await store.createTopic({ name: "临时" });
      await store.addToTopic(topic.id, "douyin:100");
      const result = await store.detachAccount("dy-only", { deleteOrphans: true });
      expect(result.removed).toEqual(["douyin:100"]);
      expect(await store.get("douyin:100")).toBeNull();
      expect((await store.listTopics())[0].items).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rebuilds from account records without removing topics or manual items", async () => {
    const root = await directory();
    try {
      const store = new ContentLibraryStore(root);
      await store.manualSave({ platform: "bilibili", contentId: "manual-1", title: "手动保存", url: "https://www.bilibili.com/video/BVmanual" });
      const topic = await store.createTopic({ name: "长期专题" });
      await store.addToTopic(topic.id, "bilibili:manual-1");
      const snapshot = { records: {
        watch_history: [{ videoId: "100", title: "运镜教程", url: "https://www.douyin.com/video/100", occurredAt: "2026-01-01" }],
        liked_videos: [], favorite_videos: [],
      } };
      const first = await store.rebuildFromSnapshots([{ platform: "douyin", accountId: "dy-main", accountName: "主号", records: snapshot }]);
      expect(first.added).toBe(1);
      expect((await store.get("douyin:100")).sourceAccounts[0].accountId).toBe("dy-main");
      const second = await store.rebuildFromSnapshots([{ platform: "douyin", accountId: "dy-main", accountName: "主号", records: { watch_history: [], liked_videos: [], favorite_videos: [] } }]);
      expect(second.detached).toBe(1);
      expect(await store.get("douyin:100")).toBeNull();
      expect(await store.get("bilibili:manual-1")).not.toBeNull();
      expect((await store.listTopics())[0].items).toEqual(["bilibili:manual-1"]);

      await store.rebuildFromSnapshots([{ platform: "xiaohongshu", accountId: "xhs-main", records: { lists: {
        favorites: { notes: [{ note_id: "note-1", display_title: "布光笔记", url: "https://www.xiaohongshu.com/explore/note-1" }] },
        likes: { notes: [{ note_id: "note-1", display_title: "布光笔记", url: "https://www.xiaohongshu.com/explore/note-1" }] },
      } } }]);
      expect(new Set((await store.get("xiaohongshu:note-1")).sourceAccounts[0].signals)).toEqual(new Set(["liked", "favorited"]));
      expect((await store.get("xiaohongshu:note-1")).mediaType).toBe("image");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("loads existing Douyin analysis with the shared document parser", async () => {
    const root = await directory();
    try {
      const analysis = path.join(root, "video-analysis");
      await mkdir(path.join(analysis, "100", "results"), { recursive: true });
      await writeFile(path.join(analysis, "100", "results", "notes-demo.json"), JSON.stringify({
        kind: "notes", key: "notes-demo", createdAt: "2026-01-01T00:00:00.000Z", article: { title: "布光笔记", overview: "先用柔光", summary: "再调角度" }, entries: [{ title: "步骤", text: "从侧面补光" }],
      }));
      const store = new ContentLibraryStore(root);
      store.registerAccountDirectory("dy-main", analysis);
      await store.upsert(douyin);
      const sources = await store.questionSources({ query: "侧面补光", accountId: "dy-main" });
      expect(sources).toHaveLength(1);
      expect(sources[0].quote).toContain("侧面补光");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("indexes an analysis result even when the platform sync record is absent", async () => {
    const root = await directory();
    try {
      const analysis = path.join(root, "account-analysis");
      await mkdir(path.join(analysis, "100", "results"), { recursive: true });
      await writeFile(path.join(analysis, "100", "results", "transcript-demo.json"), JSON.stringify({
        kind: "transcript", key: "transcript-demo", createdAt: "2026-01-01T00:00:00.000Z", entries: [{ startMs: 0, text: "没有同步记录也要能检索到这段逐字稿" }],
      }));
      const store = new ContentLibraryStore(root);
      const result = await store.rebuildFromSnapshots([{ platform: "douyin", accountId: "dy-main", accountName: "主号", records: { watch_history: [], liked_videos: [], favorite_videos: [] }, analysisDirectory: analysis }]);
      expect(result.added).toBe(1);
      const item = await store.get("douyin:100", { accountId: "dy-main" });
      expect(item.sourceAccounts[0].accountId).toBe("dy-main");
      expect(item.materials[0].text).toContain("没有同步记录");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps account-local analysis out of another account projection", async () => {
    const root = await directory();
    try {
      const analysis = path.join(root, "account-a-analysis");
      await mkdir(path.join(analysis, "100", "results"), { recursive: true });
      await writeFile(path.join(analysis, "100", "results", "notes-private.json"), JSON.stringify({
        kind: "notes", key: "notes-private", article: { title: "账号 A 私密笔记", overview: "账号 A 私密材料", summary: "仅供 A 使用" }, entries: [],
      }));
      const store = new ContentLibraryStore(root);
      await store.rebuildFromSnapshots([
        { platform: "douyin", accountId: "dy-a", records: { watch_history: [], liked_videos: [], favorite_videos: [] }, analysisDirectory: analysis },
        { platform: "douyin", accountId: "dy-b", records: { watch_history: [{ videoId: "100", title: "同一视频", url: "https://www.douyin.com/video/100" }], liked_videos: [], favorite_videos: [] } },
      ]);
      expect((await store.get("douyin:100", { accountId: "dy-a" })).materials[0].text).toContain("账号 A 私密材料");
      expect((await store.get("douyin:100", { accountId: "dy-b" })).materials).toEqual([]);
      expect((await store.search("私密材料", { accountId: "dy-a" })).items[0].materials[0].text).toContain("账号 A 私密材料");
      expect((await store.search("私密材料", { accountId: "dy-b" })).items).toEqual([]);
      expect(await store.questionSources({ query: "私密材料", accountId: "dy-b" })).toEqual([]);
      expect((await store.questionSources({ query: "私密材料", accountId: "dy-a" }))[0].quote).toContain("账号 A 私密材料");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes a deleted account's manual relation without removing another account's source", async () => {
    const root = await directory();
    try {
      const store = new ContentLibraryStore(root);
      await store.manualSave({ platform: "douyin", accountId: "dy-a", contentId: "100", title: "共同内容", url: "https://www.douyin.com/video/100" });
      await store.upsert({ platform: "douyin", accountId: "dy-b", contentId: "100", title: "共同内容", url: "https://www.douyin.com/video/100", signals: ["watched"] });
      await store.detachAccount("dy-a", { platform: "douyin", deleteOrphans: true });
      const item = await store.get("douyin:100");
      expect(item.sourceAccounts).toEqual([expect.objectContaining({ accountId: "dy-b", signals: ["watched"] })]);
      expect(item.savedAt).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps rebuild ordering stable and treats saved/manual as the same filter", async () => {
    const root = await directory();
    try {
      const store = new ContentLibraryStore(root);
      const snapshot = { records: {
        watch_history: [
          { videoId: "b", title: "B", url: "https://www.douyin.com/video/b" },
          { videoId: "a", title: "A", url: "https://www.douyin.com/video/a" },
        ], liked_videos: [], favorite_videos: [],
      } };
      await store.rebuildFromSnapshots([{ platform: "douyin", accountId: "dy-main", records: snapshot }]);
      const first = (await store.read({ limit: 10 })).items.map(item => item.key);
      await store.rebuildFromSnapshots([{ platform: "douyin", accountId: "dy-main", records: snapshot }]);
      expect((await store.read({ limit: 10 })).items.map(item => item.key)).toEqual(first);
      await store.manualSave({ platform: "xiaohongshu", accountId: "xhs-main", contentId: "note-saved", title: "保存", url: "https://www.xiaohongshu.com/explore/note-saved" });
      expect((await store.read({ signal: "saved" })).items.map(item => item.key)).toContain("xiaohongshu:note-saved");
      expect((await store.read({ signal: "manual" })).items.map(item => item.key)).toContain("xiaohongshu:note-saved");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a broken file recoverable and writes valid JSON atomically", async () => {
    const root = await directory();
    try {
      const store = new ContentLibraryStore(root);
      await store.upsert(douyin);
      const raw = await readFile(path.join(root, "content-library.json"), "utf8");
      expect(JSON.parse(raw).entries["douyin:100"].platform).toBe("douyin");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recovers topics and manual saves from metadata when the derived index is deleted", async () => {
    const root = await directory();
    try {
      const store = new ContentLibraryStore(root);
      await store.manualSave({ platform: "xiaohongshu", accountId: "xhs-main", contentId: "note-1", title: "本地保存", url: "https://www.xiaohongshu.com/explore/note-1" });
      const topic = await store.createTopic({ name: "可恢复专题" });
      await store.addToTopic(topic.id, "xiaohongshu:note-1");
      await rm(path.join(root, "content-library.json"));

      const recovered = new ContentLibraryStore(root);
      expect((await recovered.get("xiaohongshu:note-1")).title).toBe("本地保存");
      expect((await recovered.listTopics())[0].items).toEqual(["xiaohongshu:note-1"]);
      await recovered.deleteTopic(topic.id);
      await rm(path.join(root, "content-library.json"));
      expect(await new ContentLibraryStore(root).listTopics()).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recovers a topic-only entry even after its platform relation disappears", async () => {
    const root = await directory();
    try {
      const store = new ContentLibraryStore(root);
      await store.rebuildFromSnapshots([{ platform: "douyin", accountId: "dy-main", records: { watch_history: [{ videoId: "100", title: "专题视频", url: "https://www.douyin.com/video/100" }], liked_videos: [], favorite_videos: [] } }]);
      const topic = await store.createTopic({ name: "保留条目" });
      await store.addToTopic(topic.id, "douyin:100");
      await rm(path.join(root, "content-library.json"));
      const recovered = new ContentLibraryStore(root);
      expect((await recovered.get("douyin:100")).title).toBe("专题视频");
      await recovered.rebuildFromSnapshots([{ platform: "douyin", accountId: "dy-main", records: { watch_history: [], liked_videos: [], favorite_videos: [] } }]);
      expect(await recovered.get("douyin:100")).not.toBeNull();
      expect((await recovered.listTopics())[0].items).toEqual(["douyin:100"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

