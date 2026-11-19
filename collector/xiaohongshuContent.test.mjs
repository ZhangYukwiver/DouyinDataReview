import { expect, it } from "vitest";
import { contentOptions } from "./xiaohongshuContent.mjs";

it("accepts note links from search and excludes unrelated URL parameters", () => {
  const id = "aaaaaaaaaaaaaaaaaaaaaaaa";
  const params = "xsec_token=example&xsec_source=pc_search";
  const input = { url: `https://www.xiaohongshu.com/search_result/${id}?${params}&tracking=example` };
  expect(contentOptions("detail", input)).toEqual({ id, url: `https://www.xiaohongshu.com/explore/${id}?${params}` });
  expect(() => contentOptions("comments", { url: `https://example.com/explore/${id}` })).toThrow();
  expect(() => contentOptions("profile", input)).toThrow();
});
