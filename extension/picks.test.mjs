import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

const script = readFileSync(new URL("./picks.js", import.meta.url), "utf8");
const filterScript = readFileSync(new URL("./filter.js", import.meta.url), "utf8");
const video = id => ({ aweme_id: String(id), desc: "相关视频", video: { play_addr: { url_list: ["https://example.com/video.mp4"] } } });
const response = (...ids) => ({ status_code: 0, data: ids.map(id => ({ aweme_info: video(id) })), cursor: 10, has_more: 0 });
const feed = (...ids) => ({ status_code: 0, aweme_list: ids.map(video), cursor: "keep", has_more: 1 });
const ids = value => value.aweme_list.map(item => item.aweme_id);
function setup(search, blocked = () => false, now = Date.now) {
  const context = {}; vm.runInNewContext(filterScript, context); vm.runInNewContext(script, context);
  return context.DYF.createPicks({ search, blocked, now });
}

describe("网页词条视频候选池", () => {
  it("每三条插一条、间距跨页延续、词条轮换，并保留完整作品及推荐游标", async () => {
    const search = vi.fn(async word => response(...(word === "露营" ? [90001, 90002] : [80001, 80002])));
    const picks = setup(search);
    picks.configure("露营\n咖啡\n露营", true);
    await picks.prefetch();
    const first = feed(10001, 10002);
    expect(picks.mix(first)).toBe(false);
    const second = feed(10003, 10004, 10005, 10006);
    expect(picks.mix(second)).toBe(true);
    expect(ids(second)).toEqual(["10003", "90001", "10004", "10005", "10006", "80001"]);
    expect(second).toMatchObject({ cursor: "keep", has_more: 1 });
    expect(second.aweme_list[1]).toEqual(video(90001));
    const repeated = feed(90001, 10007);
    expect(picks.mix(repeated)).toBe(true);
    expect(ids(repeated)).toEqual(["10007"]);
    await picks.prefetch();
    expect(search).toHaveBeenCalledTimes(2);
  });

  it("频率可调：每 1 条插一条，改频率不重搜", async () => {
    const search = vi.fn(async () => response(90001, 90002, 90003));
    const picks = setup(search);
    picks.configure("露营", true, 1);
    await picks.prefetch();
    const first = feed(10001, 10002);
    picks.mix(first);
    expect(ids(first)).toEqual(["10001", "90001", "10002", "90002"]);
    picks.configure("露营", true, 2);
    const second = feed(10003, 10004);
    picks.mix(second);
    expect(ids(second)).toEqual(["10003", "10004", "90003"]);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("只看词条：能播的推荐逐条换成词条视频，候选用完留原推荐", async () => {
    const picks = setup(async () => response(90001, 90002));
    picks.configure("露营", true, 0);
    await picks.prefetch();
    const page = { ...feed(10001, 10002, 10003), aweme_list: [video(10001), { ...video(10009), is_ads: true }, video(10002), video(10003)] };
    expect(picks.mix(page)).toBe(true);
    expect(ids(page)).toEqual(["90001", "10009", "90002", "10003"]);
  });

  it("只看词条：候选撞上这页的推荐也留着，被换掉的推荐后来搜到还能插，插过的不再出现", async () => {
    const queues = [[10002, 90001, 90002], [20001, 20002]];
    const picks = setup(async () => ({ ...response(...queues.shift()), has_more: 1 }));
    picks.configure("露营", true, 0);
    await picks.prefetch();
    const first = feed(10001, 10002, 10003);
    expect(picks.mix(first)).toBe(true);
    // 10002 插到了第一个位置，原来那条不再重复出现
    expect(ids(first)).toEqual(["10002", "90001"]);
    const second = feed(20001, 10002);
    picks.mix(second);
    expect(ids(second)).toEqual(["90002"]);
    // 20001 上一页被换掉了，用户没刷到过
    await picks.prefetch();
    const third = feed(30001);
    picks.mix(third);
    expect(ids(third)).toEqual(["20001"]);
  });

  it("不插已见、同批后面会出现、重复、广告、直播或命中屏蔽词的候选；插入时重查规则", async () => {
    let blocked = "禁止";
    const search = vi.fn(async () => ({ ...response(10001, 10004, 90001, 90001, 90002, 90003), data: [
      ...response(10001, 10004, 90001, 90001, 90002, 90003).data,
      { aweme_info: { ...video(90004), is_ads: true } }, { aweme_info: { aweme_id: "90005", live_room: {} } },
      { aweme_info: { ...video(90006), desc: "禁止" } },
      { aweme_info: { ...video(90007), is_ads: "1" } },
    ] }));
    const picks = setup(search, item => item.desc === blocked || item.aweme_id === blocked);
    picks.configure("露营", true);
    picks.rememberPage({ aweme_detail: video(10001) });
    await picks.prefetch();
    blocked = "90002";
    const first = feed(10002, 10003, 10004, 10005, 10006, 10007, 10008, 10009, 10010);
    picks.mix(first);
    expect(ids(first)).toEqual(["10002", "10003", "10004", "90001", "10005", "10006", "10007", "90003", "10008", "10009", "10010"]);
    expect(picks.status().picksInserted).toBe(2);
  });

  it("候选未准备好时推荐立即返回；关闭或换词丢弃迟到响应", async () => {
    let finish;
    const picks = setup(() => new Promise(resolve => { finish = resolve; }));
    picks.configure("露营", true);
    const pending = picks.prefetch();
    const original = feed(10001, 10002, 10003);
    expect(picks.mix(original)).toBe(false);
    expect(ids(original)).toEqual(["10001", "10002", "10003"]);
    picks.configure("咖啡", false);
    finish(response(90001)); await pending;
    expect(picks.status()).toMatchObject({ picksQueued: 0, picksInserted: 0, picksEnabled: false });
    picks.configure("", true);
    expect(picks.mix(feed(10004, 10005, 10006))).toBe(false);
  });

  it("错过的插入位置直接跳过，候选晚到仍等下一组三条", async () => {
    let finish;
    const picks = setup(() => new Promise(resolve => { finish = resolve; }));
    picks.configure("露营", true); const pending = picks.prefetch();
    expect(picks.mix(feed(10001, 10002, 10003))).toBe(false);
    finish(response(90001)); await pending;
    expect(picks.mix(feed(10004, 10005))).toBe(false);
    const next = feed(10006); expect(picks.mix(next)).toBe(true);
    expect(ids(next)).toEqual(["10006", "90001"]);
  });

  it("错误和验证要求暂停五分钟，分页使用各词自己的 cursor 和 search_id", async () => {
    let time = 1;
    const search = vi.fn().mockResolvedValueOnce({ status_code: 0, data: [], search_nil_info: { search_nil_type: "verify_check" } })
      .mockResolvedValueOnce({ ...response(90001), has_more: 1, cursor: 20, log_pb: { impr_id: "search-a" } })
      .mockResolvedValueOnce(response(90002));
    const picks = setup(search, () => false, () => time);
    picks.configure("露营", true);
    await picks.prefetch(); await picks.prefetch();
    expect(search).toHaveBeenCalledTimes(1);
    time += 300_001;
    await picks.prefetch(); picks.mix(feed(10001, 10002, 10003)); await picks.prefetch();
    expect(search.mock.calls).toEqual([["露营", 0, null], ["露营", 0, null], ["露营", 20, "search-a"]]);
    expect(picks.status().pickFailures).toBe(1);
  });

  it("前两个词失败或搜尽后，仍继续预取后面的词", async () => {
    const search = vi.fn(async word => word === "第三个" ? response(90001) : { status_code: 2483 });
    const picks = setup(search); picks.configure("第一个\n第二个\n第三个", true);
    await picks.prefetch(); await picks.prefetch();
    expect(search.mock.calls.map(call => call[0])).toEqual(["第一个", "第二个", "第三个"]);
    const page = feed(10001, 10002, 10003); picks.mix(page);
    expect(ids(page)).toEqual(["10001", "10002", "10003", "90001"]);
  });

  it("嵌套精选回包可插入；空页、错误及详情保持原样", async () => {
    const picks = setup(async () => response(90001)); picks.configure("露营", true); await picks.prefetch();
    for (const page of [feed(), { ...feed(10001, 10002, 10003), status_code: 5 }, { aweme_detail: video(10004) }]) expect(picks.mix(page)).toBe(false);
    const nested = { status_code: 0, data: feed(10005, 10006, 10007) };
    expect(picks.mix(nested)).toBe(true);
    expect(ids(nested.data)).toEqual(["10005", "10006", "10007", "90001"]);
  });
});
