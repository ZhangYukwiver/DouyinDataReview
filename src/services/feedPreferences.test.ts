import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFeedPreferences } from "./feedPreferences";
import { collectorFeedFilter } from "./localCollector";
import { loadFeedWords, saveFeedWords } from "./appStyle";

vi.mock("./localCollector", () => ({ collectorFeedFilter: vi.fn() }));
vi.mock("./appStyle", () => ({ loadFeedWords: vi.fn(), saveFeedWords: vi.fn() }));
const settings = (words: string | null) => ({ words, webPicks: false, rules: "", mode: "off" as const, extension: { lastSeenAt: null, removing: false } });
beforeEach(() => { vi.resetAllMocks(); vi.mocked(loadFeedWords).mockReturnValue("旧词条"); });
describe("共用推荐词条迁移", () => {
  it("仅旧数据首次迁移本机词条，之后读取采集器", async () => {
    vi.mocked(collectorFeedFilter).mockResolvedValueOnce(settings(null)).mockResolvedValueOnce(settings("旧词条"));
    expect((await readFeedPreferences("local", "token")).words).toBe("旧词条");
    expect(collectorFeedFilter).toHaveBeenLastCalledWith("local", "token", { words: "旧词条" });
  });
  it("用户清空后不从旧缓存恢复，刷新本机缓存", async () => {
    vi.mocked(collectorFeedFilter).mockResolvedValue(settings(""));
    expect((await readFeedPreferences("local", "token")).words).toBe("");
    expect(collectorFeedFilter).toHaveBeenCalledTimes(1);
    expect(saveFeedWords).toHaveBeenCalledWith("");
  });
  it("读取失败不覆盖已有本机词条", async () => {
    vi.mocked(collectorFeedFilter).mockRejectedValue(new Error("offline"));
    await expect(readFeedPreferences("local", "token")).rejects.toThrow("offline");
    expect(saveFeedWords).not.toHaveBeenCalled();
  });

  it("晚到的后台读取不覆盖用户刚保存的词条缓存", async () => {
    let finish!: (value: ReturnType<typeof settings>) => void;
    vi.mocked(collectorFeedFilter).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = readFeedPreferences("local", "token");
    vi.mocked(loadFeedWords).mockReturnValue("新词条");
    finish(settings("旧词条")); await pending;
    expect(saveFeedWords).not.toHaveBeenCalled();
  });
});
