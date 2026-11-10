import { expect, it } from "vitest";
import { mobileFeedProfile } from "./mobileFeedProfile.mjs";

it("导出同一份规则和按词条搜索的可播候选，保留频率并排除屏蔽项、重复项与账户数据", async () => {
  const media = { url_list: ["https://example.douyinvod.com/video"] };
  const video = { aweme_id: "123456", desc: "磨豆", author: { uid: "1", nickname: "小白" },
    video: { play_addr: media, cover: media }, private_field: "excluded" };
  const settings = { rules: "author:广告\n/营销/i@0.5", words: "咖啡\n手冲", mode: "hide", pickEvery: 5 };
  const requested = [];
  const profile = await mobileFeedProfile(settings, async () => ({ async request(_, { query }) {
    requested.push(query.keyword);
    return { status_code: 0, data: [{ aweme_list: [video, { ...video, aweme_id: "123457", author: { uid: "2", nickname: "广告" } }] }] };
  } }));
  expect(requested).toEqual(["咖啡", "手冲"]);
  expect(profile.rules[1]).toMatchObject({ pattern: "营销", flags: "i", weight: .5 });
  expect(profile.pickEvery).toBe(5);
  expect(profile.candidates).toHaveLength(1);
  expect(profile.candidates[0]).toMatchObject({ word: "咖啡", video: { aweme_id: "123456", video: { play_addr: media } } });
  expect(profile.candidates[0].video).not.toHaveProperty("private_field");
});
