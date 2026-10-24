import { describe, expect, it } from "vitest";

import { jimengRequest, volcSign, xDate } from "./volcSign.mjs";

// 官方《签名方法》（volcengine.com/docs/6369/67269）里的示例：同样的输入要算出文档给的签名。
// 签名只跟 SK 有关，AccessKeyId 只写进 Credential，这里用占位值（文档里那串示例会被 GitHub 当成真 Key 拦下推送）
const DOC = {
  accessKeyId: "AKLT-doc-example",
  secretKey: "WkRZeE1EQmxPVGhsWWpWak5HVmtNbUUxTXpZeU9UVXlOMlE1TmpZeVlqTQ==",
  region: "cn-beijing",
  service: "billing",
  headers: { Host: "billing.volcengineapi.com", "X-Date": "20250329T180937Z" },
};

describe("volcSign", () => {
  it("matches the GET and POST examples in the official docs", () => {
    const get = volcSign({ ...DOC, method: "GET", query: { Action: "QueryBalanceAcct", Version: "2022-01-01" } });
    expect(get.authorization).toBe(`HMAC-SHA256 Credential=${DOC.accessKeyId}/20250329/cn-beijing/billing/request, SignedHeaders=host;x-date, Signature=1eda9e7e6b1728151a8e8791fdaf67cfbd28bd5c80d0fce2eb208746cf483105`);
    const post = volcSign({ ...DOC, method: "POST", query: { Version: "2022-01-01", Action: "ListBill" }, body: '{"Limit":10,"BillPeriod":"2023-08"}' });
    expect(post.canonicalQuery).toBe("Action=ListBill&Version=2022-01-01");
    expect(post.authorization).toMatch(/Signature=5e8480ceea12d0000a23c054151c50dd02c1a7dec835004057d19f13d53a7658$/u);
  });

  it("signs a Jimeng call over content-type, host, the body hash and the date", () => {
    expect(xDate(new Date(Date.UTC(2026, 9, 24, 3, 4, 5)))).toBe("20261024T030405Z");
    const { url, init } = jimengRequest({
      baseUrl: "https://visual.volcengineapi.com", action: "CVSync2AsyncSubmitTask", payload: { req_key: "jimeng_ti2v_v30_pro", prompt: "海浪" },
      accessKeyId: "AK", secretKey: "SK", date: new Date(Date.UTC(2026, 9, 24, 3, 4, 5)),
    });
    expect(url).toBe("https://visual.volcengineapi.com/?Action=CVSync2AsyncSubmitTask&Version=2022-08-31");
    expect(init.body).toBe('{"req_key":"jimeng_ti2v_v30_pro","prompt":"海浪"}');
    expect(init.headers).toMatchObject({ "Content-Type": "application/json", "X-Date": "20261024T030405Z", "X-Content-Sha256": expect.stringMatching(/^[0-9a-f]{64}$/u) });
    expect(init.headers.Authorization).toMatch(/^HMAC-SHA256 Credential=AK\/20261024\/cn-north-1\/cv\/request, SignedHeaders=content-type;host;x-content-sha256;x-date, Signature=[0-9a-f]{64}$/u);
  });
});
