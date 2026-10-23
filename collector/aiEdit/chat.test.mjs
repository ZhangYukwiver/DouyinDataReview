import { describe, expect, it } from "vitest";

import { MAX_TOOL_CALLS, compactHistory, parseEditConfig, recallLines, requestCompletion, requestHistory, runConversation, saysCantSeeImages, sealHistory, trimHistory } from "./chat.mjs";

const OMITTED = "较早的内容，细节已省略；还要用就用同样的参数再调一次（参考解析和节拍一般有缓存、马上返回，应用重启过就要重新解析，很慢，没必要别重调）；时间线和素材以工程现状和系统提示为准";

const ARK = { baseUrl: "https://ark.cn-beijing.volces.com/api/v3", apiKey: "test-key", model: "doubao-seed-2-1-lite-260915" };

/** 把一组 chunk 拼成 SSE 响应；split 让每个 data 行再拆成两半送达，测跨包拼接。 */
function sse(chunks, { split = false } = {}) {
  const text = `${chunks.map((chunk) => `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
  const encoder = new TextEncoder();
  const pieces = split ? text.match(/[\s\S]{1,7}/gu) : [text];
  return new Response(new ReadableStream({
    start(controller) {
      for (const piece of pieces) controller.enqueue(encoder.encode(piece));
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

const delta = (value, finish = null) => ({ choices: [{ index: 0, delta: value, finish_reason: finish }] });
const textReply = (text) => sse([delta({ role: "assistant", content: "" }), delta({ content: text }), delta({}, "stop")]);
const toolReply = (calls) => sse([
  ...calls.map((call, index) => delta({ tool_calls: [{ index, id: `call_${call.name}_${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) } }] })),
  delta({}, "tool_calls"),
]);

function scripted(replies) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body), headers: init.headers, signal: init.signal });
    const next = replies.shift();
    if (!next) throw new Error("no more scripted replies");
    return typeof next === "function" ? next(init) : next;
  };
  return { fetchImpl, requests };
}

describe("parseEditConfig", () => {
  it("accepts http(s) with a key and model, and asks for the AI edit settings otherwise", () => {
    expect(parseEditConfig({ baseUrl: " https://example.com/v1/ ", apiKey: " k ", model: " m " })).toEqual({ baseUrl: "https://example.com/v1", apiKey: "k", model: "m", videoInput: null });
    expect(parseEditConfig({ baseUrl: "https://example.com/v1", apiKey: "k", model: "m", videoInput: false }).videoInput).toBe(false);
    expect(parseEditConfig({ baseUrl: "https://example.com/v1", apiKey: "k", model: "m", videoInput: "yes" }).videoInput).toBeNull();
    expect(parseEditConfig({ baseUrl: "https://api.huiliu.one", apiKey: "k", model: "m" }).baseUrl).toBe("https://api.huiliu.one/v1");
    expect(() => parseEditConfig({ baseUrl: "file:///etc", apiKey: "k", model: "m" })).toThrow("接口地址要以 https:// 开头。");
    expect(() => parseEditConfig({ baseUrl: "https://example.com", apiKey: "", model: "m" })).toThrow("先在 AI 剪辑的接口设置里填好 Key 和模型。");
    expect(() => parseEditConfig(null)).toThrow(expect.objectContaining({ code: "invalid_config" }));
  });
});

describe("requestCompletion", () => {
  it("joins streamed tool-call deltas by index, including the arguments in the first piece, for parallel calls", async () => {
    const { fetchImpl, requests } = scripted([sse([
      delta({ role: "assistant", content: "好的，" }),
      delta({ content: "我先看看。" }),
      // 第一片同时带 id、名字和一段参数；第二个调用穿插着来
      delta({ tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "create_track", arguments: "{\"track_" } }] }),
      delta({ tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "get_timeline", arguments: "" } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: "type\":\"vid" } }] }),
      delta({ tool_calls: [{ index: 1, function: { arguments: "{}" } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: "eo\"}" } }] }),
      delta({}, "tool_calls"),
    ], { split: true })]);
    const seen = [];
    const reply = await requestCompletion({ config: ARK, messages: [{ role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "x" } }], fetchImpl, onText: (text) => seen.push(text) });
    expect(reply.text).toBe("好的，我先看看。");
    expect(seen.at(-1)).toBe("好的，我先看看。");
    expect(reply.finishReason).toBe("tool_calls");
    expect(reply.toolCalls).toEqual([
      { id: "call_a", name: "create_track", arguments: "{\"track_type\":\"video\"}" },
      { id: "call_b", name: "get_timeline", arguments: "{}" },
    ]);
    const { body, headers, url } = requests[0];
    expect(url).toBe(`${ARK.baseUrl}/chat/completions`);
    expect(headers.Authorization).toBe("Bearer test-key");
    expect(body).toMatchObject({ model: ARK.model, stream: true, max_tokens: 16_000, tool_choice: "auto", thinking: { type: "disabled" } });
  });

  it("only turns thinking off for Ark, tolerates missing index and repeated names, and reads plain JSON answers", async () => {
    const other = { ...ARK, baseUrl: "https://api.example.com/v1" };
    const { fetchImpl, requests } = scripted([
      sse([
        delta({ tool_calls: [{ id: "c1", function: { name: "list_media", arguments: "{" } }] }),
        delta({ tool_calls: [{ function: { name: "list_media", arguments: "}" } }] }),
      ]),
      new Response(JSON.stringify({ choices: [{ message: { content: "完成", tool_calls: [{ id: "c9", type: "function", function: { name: "get_timeline", arguments: "{}" } }] }, finish_reason: "tool_calls" }] }), { headers: { "content-type": "application/json" } }),
    ]);
    const first = await requestCompletion({ config: other, messages: [], fetchImpl });
    expect(first.toolCalls).toEqual([{ id: "c1", name: "list_media", arguments: "{}" }]);
    expect(requests[0].body.thinking).toBeUndefined();
    expect(requests[0].body.tools).toBeUndefined();
    const second = await requestCompletion({ config: other, messages: [], fetchImpl });
    expect(second).toEqual({ text: "完成", toolCalls: [{ id: "c9", name: "get_timeline", arguments: "{}" }], finishReason: "tool_calls" });
  });

  it("explains provider errors in Chinese", async () => {
    const { fetchImpl } = scripted([
      new Response(JSON.stringify({ error: { message: "The API key is invalid" } }), { status: 401 }),
      sse([{ error: { message: "quota" } }]),
    ]);
    await expect(requestCompletion({ config: ARK, messages: [], fetchImpl })).rejects.toMatchObject({ code: "provider_error", status: 502, message: "接口 Key 不对或没有权限：The API key is invalid" });
    await expect(requestCompletion({ config: ARK, messages: [], fetchImpl })).rejects.toMatchObject({ code: "provider_error" });
  });
});

describe("runConversation", () => {
  it("loops through tool calls until the model stops, feeding results (and errors) back", async () => {
    const { fetchImpl, requests } = scripted([
      toolReply([{ name: "create_track", args: { track_type: "video" } }, { name: "add_media_clip", args: { media_id: "x" } }]),
      toolReply([{ name: "get_timeline" }]),
      textReply("加好了，现在 3 秒。"),
    ]);
    const history = [{ role: "user", content: "加个视频" }];
    const executed = [];
    let systemCalls = 0;
    const result = await runConversation({
      config: ARK, history, tools: [{ type: "function", function: { name: "t" } }], fetchImpl,
      system: async () => `system ${++systemCalls}`,
      execute: async (call) => {
        executed.push(call.name);
        return call.name === "add_media_clip" ? { ok: false, code: "media_not_found", message: "素材库里没有 x" } : { ok: true };
      },
    });
    expect(result).toEqual({ text: "加好了，现在 3 秒。", toolCalls: 3 });
    expect(executed).toEqual(["create_track", "add_media_clip", "get_timeline"]);
    expect(requests).toHaveLength(3);
    // 每次请求前都重新生成系统提示
    expect(requests.map((request) => request.body.messages[0])).toEqual([1, 2, 3].map((index) => ({ role: "system", content: `system ${index}` })));
    const second = requests[1].body.messages;
    expect(second[2]).toMatchObject({ role: "assistant", tool_calls: [{ id: "call_create_track_0" }, { id: "call_add_media_clip_1" }] });
    expect(second[3]).toEqual({ role: "tool", tool_call_id: "call_create_track_0", content: JSON.stringify({ ok: true }) });
    expect(JSON.parse(second[4].content)).toEqual({ ok: false, code: "media_not_found", message: "素材库里没有 x" });
    expect(history.map((message) => message.role)).toEqual(["user", "assistant", "tool", "tool", "assistant", "tool", "assistant"]);
    expect(history.at(-1)).toEqual({ role: "assistant", content: "加好了，现在 3 秒。" });
  });

  it(`stops after ${MAX_TOOL_CALLS} tool calls and asks for a text-only wrap-up`, async () => {
    const rounds = MAX_TOOL_CALLS / 2;
    const replies = Array.from({ length: rounds }, () => toolReply([{ name: "a" }, { name: "b" }]));
    const { fetchImpl, requests } = scripted([...replies, sse([delta({ content: "先做到这里。" }), delta({ tool_calls: [{ index: 0, id: "late", function: { name: "a", arguments: "{}" } }] })])]);
    const history = [{ role: "user", content: "做很多事" }];
    let executed = 0;
    const result = await runConversation({ config: ARK, history, tools: [{}], fetchImpl, system: async () => "s", execute: async () => { executed += 1; return { ok: true }; } });
    expect(executed).toBe(MAX_TOOL_CALLS);
    expect(requests).toHaveLength(rounds + 1);
    expect(requests.at(-1).body.tool_choice).toBe("none");
    expect(requests.slice(0, -1).every((request) => request.body.tool_choice === "auto")).toBe(true);
    expect(result.text).toBe("先做到这里。");
    // 收尾那次就算接口还回了工具调用也不执行、不留在历史里
    expect(history.at(-1)).toEqual({ role: "assistant", content: "先做到这里。" });
    expect(history.filter((message) => message.role === "tool")).toHaveLength(MAX_TOOL_CALLS);
  });

  it("answers over-limit calls in the same batch with a limit error", async () => {
    const { fetchImpl, requests } = scripted([toolReply([{ name: "a" }, { name: "b" }, { name: "c" }]), textReply("好")]);
    const history = [{ role: "user", content: "x" }];
    const executed = [];
    await runConversation({ config: ARK, history, tools: [{}], fetchImpl, system: async () => "s", maxToolCalls: 2, execute: async (call) => { executed.push(call.name); return { ok: true }; } });
    expect(executed).toEqual(["a", "b"]);
    expect(JSON.parse(history[4].content)).toMatchObject({ ok: false, code: "tool_limit" });
    expect(requests[1].body.tool_choice).toBe("none");
  });

  it("stops when aborted and keeps the half-written answer in the history", async () => {
    const controller = new AbortController();
    const encoder = new TextEncoder();
    const fetchImpl = async (_url, init) => new Response(new ReadableStream({
      start(stream) {
        stream.enqueue(encoder.encode(`data: ${JSON.stringify(delta({ content: "我先把" }))}\n\n`));
        init.signal.addEventListener("abort", () => stream.error(init.signal.reason));
      },
    }), { headers: { "content-type": "text/event-stream" } });
    const history = [{ role: "user", content: "剪一下" }];
    const texts = [];
    const running = runConversation({ config: ARK, history, tools: [{}], fetchImpl, system: async () => "s", execute: async () => ({ ok: true }), signal: controller.signal, onText: (text) => {
      texts.push(text);
      controller.abort();
    } });
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(texts).toEqual(["我先把"]);
    expect(history.at(-1)).toEqual({ role: "assistant", content: "我先把" });
  });
});

describe("runConversation edge replies", () => {
  it("appends the context last on every request without storing it, so the prefix stays the same within a turn", async () => {
    const { fetchImpl, requests } = scripted([toolReply([{ name: "a" }]), toolReply([{ name: "b" }]), textReply("好了")]);
    const history = [{ role: "user", content: "剪" }];
    let step = 0;
    await runConversation({
      config: ARK, history, tools: [{}], fetchImpl, system: async () => "固定的系统提示",
      context: async () => `工程现状 ${step}`,
      execute: async () => { step += 1; return { ok: true }; },
    });
    expect(requests.map((request) => request.body.messages.at(-1))).toEqual([0, 1, 2].map((index) => ({ role: "user", content: `工程现状 ${index}` })));
    // 后一次请求的前面部分和前一次完全一样（只多了新的助手消息和工具结果）
    for (let index = 1; index < requests.length; index += 1) {
      const before = requests[index - 1].body.messages.slice(0, -1);
      expect(requests[index].body.messages.slice(0, before.length)).toEqual(before);
    }
    expect(history.some((message) => String(message.content).startsWith("工程现状"))).toBe(false);
  });

  it("reports a reply blocked by content moderation instead of ending silently", async () => {
    const { fetchImpl } = scripted([sse([delta({ role: "assistant", content: "" }), delta({}, "content_filter")])]);
    const history = [{ role: "user", content: "剪" }];
    await expect(runConversation({ config: ARK, history, tools: [{}], fetchImpl, system: async () => "s", execute: async () => ({ ok: true }) }))
      .rejects.toMatchObject({ code: "provider_error", message: expect.stringContaining("内容审核") });
    expect(history).toEqual([{ role: "user", content: "剪" }]);
  });

  it("names the network cause, retries a connection that drops at once, and keeps gateway HTML pages out of the message", async () => {
    const dropError = () => new TypeError("terminated", { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) });
    let calls = 0;
    const alwaysDrops = async () => { calls += 1; throw dropError(); };
    await expect(requestCompletion({ config: ARK, messages: [], fetchImpl: alwaysDrops }))
      .rejects.toMatchObject({ code: "provider_unreachable", dropped: true, message: "接口连接中途断开了（UND_ERR_SOCKET），自动重发了 2 次还是断开。" });
    expect(calls).toBe(3);
    // 回答流到一半被掐断：重发拿完整回答，新回答一来就替换掉页面上的半句
    const shown = [];
    let tries = 0;
    const halfThenDrop = () => {
      let sent = false;
      const body = new ReadableStream({ pull(controller) { if (sent) return controller.error(dropError()); sent = true; controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(delta({ content: "半句" }))}\n\n`)); } });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const cutMidway = async (url, init) => {
      tries += 1;
      if (tries > 1) return scripted([sse([delta({ role: "assistant", content: "完整" }), delta({ content: "回答" }), delta({}, "stop")])]).fetchImpl(url, init);
      return halfThenDrop();
    };
    await expect(requestCompletion({ config: ARK, messages: [], fetchImpl: cutMidway, onText: (text) => shown.push(text) })).resolves.toMatchObject({ text: "完整回答" });
    expect(shown).toEqual(["半句", "完整", "完整回答"]);
    // 断过之后重发连握手都被重置：也占「最多两次」，两次用完照样叫用户发「继续」，半句留在历史里
    const reset = () => new TypeError("fetch failed", { cause: Object.assign(new Error("Client network socket disconnected before secure TLS connection was established"), { code: "ECONNRESET" }) });
    tries = 0;
    const thenResets = async () => { tries += 1; if (tries > 1) throw reset(); return halfThenDrop(); };
    const history = [{ role: "user", content: "剪" }];
    await expect(runConversation({ config: ARK, history, tools: [{}], fetchImpl: thenResets, system: async () => "s", execute: async () => ({ ok: true }) }))
      .rejects.toMatchObject({ code: "provider_unreachable", message: "连接还没建立好就被断开了（ECONNRESET），检查一下网络、代理和地址，自动重发了 2 次还是断开。可以发「继续」接着做。" });
    expect(tries).toBe(3);
    expect(history.at(-1)).toEqual({ role: "assistant", content: "半句" });
    // 还没收到回答连接就断（第一次复用了断掉的连接）：马上重发一次就好
    const flaky = scripted([sse([delta({ role: "assistant", content: "好" }), delta({}, "stop")])]);
    tries = 0;
    const staleSocket = new TypeError("fetch failed", { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) });
    const once = async (url, init) => { tries += 1; if (tries === 1) throw staleSocket; return flaky.fetchImpl(url, init); };
    await expect(requestCompletion({ config: ARK, messages: [], fetchImpl: once })).resolves.toMatchObject({ text: "好" });
    expect(tries).toBe(2);
    // 握手阶段就被重置、重发也一样：只重发一次，说连不上，不叫用户发「继续」
    tries = 0;
    const blocked = async () => { tries += 1; throw reset(); };
    await expect(requestCompletion({ config: ARK, messages: [], fetchImpl: blocked }))
      .rejects.toMatchObject({ code: "provider_unreachable", message: "连接还没建立好就被断开了（ECONNRESET），检查一下网络、代理和地址。" });
    expect(tries).toBe(2);
    const dns = async () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND x"), { code: "ENOTFOUND" }) }); };
    await expect(requestCompletion({ config: ARK, messages: [], fetchImpl: dns })).rejects.toMatchObject({ message: expect.stringContaining("找不到接口地址的域名") });
    // 不是网络错误的 TypeError 原样抛出，不冒充「连不上」
    const bug = async () => { throw new TypeError("x is not a function"); };
    await expect(requestCompletion({ config: ARK, messages: [], fetchImpl: bug })).rejects.toThrow("x is not a function");
    const timeout = async () => new Response("<!DOCTYPE html><html>A timeout occurred</html>", { status: 524, headers: { "content-type": "text/html" } });
    const error = await requestCompletion({ config: ARK, messages: [], fetchImpl: timeout }).catch((failure) => failure);
    expect(error).toMatchObject({ code: "provider_error", message: expect.stringContaining("两分钟左右") });
    expect(error.message).not.toContain("<");
    // new-api 没有这个模型的渠道：别叫用户稍后再试
    const noChannel = async () => new Response(JSON.stringify({ error: { message: "分组 default 下模型 gpt-x 无可用渠道（distributor）", code: "model_not_found" } }), { status: 503 });
    await expect(requestCompletion({ config: ARK, messages: [], fetchImpl: noChannel })).rejects.toMatchObject({ message: expect.stringContaining("中转站里没有能用的这个模型") });
  });

  it("resends when the relay says its upstream stream failed, and asks the user to continue if it keeps failing", async () => {
    const upstream = { error: { message: "Upstream HTTP/2 stream failed", type: "upstream_error" } };
    let calls = 0;
    const flaky = async () => { calls += 1; return calls === 1 ? sse([delta({ role: "assistant", content: "" }), upstream]) : textReply("好"); };
    await expect(requestCompletion({ config: ARK, messages: [], fetchImpl: flaky })).resolves.toMatchObject({ text: "好" });
    expect(calls).toBe(2);
    calls = 0;
    const broken = async () => { calls += 1; return sse([upstream]); };
    // 设置里测模型也走这里：不叫用户发「继续」
    await expect(requestCompletion({ config: ARK, messages: [], fetchImpl: broken }))
      .rejects.toMatchObject({ code: "provider_error", message: "接口报错：Upstream HTTP/2 stream failed，自动重发了 2 次还是这样。" });
    expect(calls).toBe(3);
    // 对话里才提示发「继续」
    await expect(runConversation({ config: ARK, history: [{ role: "user", content: "剪" }], tools: [{}], fetchImpl: broken, system: async () => "s", execute: async () => ({ ok: true }) }))
      .rejects.toMatchObject({ code: "provider_error", message: "接口报错：Upstream HTTP/2 stream failed，自动重发了 2 次还是这样。可以发「继续」接着做。" });
    // 网关 502 也重发；参数不对的 400 不重发
    calls = 0;
    const gateway = async () => { calls += 1; return calls === 1 ? new Response("<html>502 Bad Gateway</html>", { status: 502, headers: { "content-type": "text/html" } }) : textReply("好"); };
    await expect(requestCompletion({ config: ARK, messages: [], fetchImpl: gateway })).resolves.toMatchObject({ text: "好" });
    expect(calls).toBe(2);
    calls = 0;
    const invalid = async () => { calls += 1; return new Response(JSON.stringify({ error: { message: "Invalid value for tool_choice" } }), { status: 400 }); };
    await expect(requestCompletion({ config: ARK, messages: [], tools: [{}], fetchImpl: invalid })).rejects.toMatchObject({ code: "provider_error" });
    expect(calls).toBe(1);
  });

  it("reports an empty reply or a body that is not JSON, and never stores an empty assistant message", async () => {
    const empty = scripted([sse([delta({ role: "assistant", content: "" }), delta({}, "stop")])]);
    const history = [{ role: "user", content: "剪" }];
    await expect(runConversation({ config: ARK, history, tools: [{}], fetchImpl: empty.fetchImpl, system: async () => "s", execute: async () => ({ ok: true }) }))
      .rejects.toMatchObject({ code: "provider_error", message: expect.stringContaining("什么都没回") });
    expect(history).toEqual([{ role: "user", content: "剪" }]);

    const html = scripted([new Response("<html>gateway</html>", { status: 200, headers: { "content-type": "text/html" } })]);
    await expect(requestCompletion({ config: ARK, messages: [], fetchImpl: html.fetchImpl })).rejects.toMatchObject({ code: "provider_error", message: expect.stringContaining("不是 JSON") });

    // 做过事之后最后一句是空的：正常收尾，但不留空的助手消息
    const quiet = scripted([toolReply([{ name: "a" }]), sse([delta({}, "stop")])]);
    const after = [{ role: "user", content: "剪" }];
    const result = await runConversation({ config: ARK, history: after, tools: [{}], fetchImpl: quiet.fetchImpl, system: async () => "s", execute: async () => ({ ok: true }) });
    expect(result).toEqual({ text: "", toolCalls: 1 });
    expect(after.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
  });

  it("does not run a tool call whose arguments were cut off at the length limit", async () => {
    const { fetchImpl, requests } = scripted([
      sse([
        delta({ tool_calls: [{ index: 0, id: "whole", type: "function", function: { name: "a", arguments: "{\"x\":1}" } }] }),
        delta({ tool_calls: [{ index: 1, id: "cut", type: "function", function: { name: "add_subtitles", arguments: "{\"captions\":[{\"start\":0," } }] }),
        delta({}, "length"),
      ]),
      textReply("我分两批加"),
    ]);
    const history = [{ role: "user", content: "加字幕" }];
    const executed = [];
    await runConversation({ config: ARK, history, tools: [{}], fetchImpl, system: async () => "s", execute: async (call) => { executed.push(call.id); return { ok: true }; } });
    expect(executed).toEqual(["whole"]);
    const results = requests[1].body.messages.filter((message) => message.role === "tool").map((message) => [message.tool_call_id, JSON.parse(message.content)]);
    expect(results).toEqual([["whole", { ok: true }], ["cut", expect.objectContaining({ ok: false, code: "output_truncated" })]]);
  });
});

describe("history helpers", () => {
  it("adds a result for every tool call left unanswered", () => {
    const history = [
      { role: "user", content: "x" },
      { role: "assistant", content: "", tool_calls: [{ id: "a" }, { id: "b" }, { id: "c" }] },
      { role: "tool", tool_call_id: "a", content: "{}" },
    ];
    sealHistory(history);
    expect(history.slice(2).map((message) => message.tool_call_id)).toEqual(["a", "b", "c"]);
    expect(JSON.parse(history[3].content)).toMatchObject({ ok: false, code: "stopped" });
    const done = [{ role: "user", content: "x" }, { role: "assistant", content: "ok" }];
    sealHistory(done);
    expect(done).toHaveLength(2);
  });

  it("drops whole old turns but always keeps the latest one", () => {
    const turn = (index) => [
      { role: "user", content: `u${index}`.padEnd(100, "x") },
      { role: "assistant", content: "", tool_calls: [{ id: `t${index}`, type: "function", function: { name: "f", arguments: "{}" } }] },
      { role: "tool", tool_call_id: `t${index}`, content: "y".repeat(100) },
      { role: "assistant", content: "done" },
    ];
    const history = [1, 2, 3, 4].flatMap(turn);
    const trimmed = trimHistory(history, 700);
    expect(trimmed[0]).toMatchObject({ role: "user" });
    expect(trimmed.length % 4).toBe(0);
    expect(trimmed.length).toBeLessThan(history.length);
    expect(trimmed.at(-1)).toBe(history.at(-1));
    expect(trimHistory(history.slice(-4), 10)).toEqual(history.slice(-4));
  });

  it("compacts long old tool results and arguments in place, keeping words, pairing and the latest turn", () => {
    const turn = (index, big) => [
      { role: "user", content: `第 ${index} 轮：字幕用黄色描边` },
      { role: "assistant", content: "", tool_calls: [{ id: `t${index}`, type: "function", function: { name: "add_subtitles", arguments: JSON.stringify({ items: "字".repeat(big) }) } }] },
      { role: "tool", tool_call_id: `t${index}`, content: JSON.stringify({ ok: index !== 2, ...(index === 2 ? { code: "TIMELINE_OVERLAP", message: "和别的片段重叠了" } : {}), timeline: "x".repeat(big) }) },
      { role: "assistant", content: `第 ${index} 轮做完了` },
    ];
    const small = [1, 2].flatMap((index) => turn(index, 100));
    const before = structuredClone(small);
    compactHistory(small, 10_000);
    expect(small).toEqual(before);

    const history = [1, 2, 3, 4].flatMap((index) => turn(index, 2000));
    const latest = structuredClone(history.slice(-4));
    compactHistory(history, 10_000);
    expect(history).toHaveLength(16);
    expect(history.slice(-4)).toEqual(latest);
    expect(history.filter((entry) => entry.role === "user").map((entry) => entry.content)).toEqual([1, 2, 3, 4].map((index) => `第 ${index} 轮：字幕用黄色描边`));
    expect(history[3].content).toBe("第 1 轮做完了");
    expect(JSON.parse(history[2].content)).toEqual({ ok: true, omitted: OMITTED });
    expect(JSON.parse(history[6].content)).toEqual({ ok: false, code: "TIMELINE_OVERLAP", message: "和别的片段重叠了", omitted: OMITTED });
    expect(history[1].tool_calls[0]).toMatchObject({ id: "t1", function: { name: "add_subtitles" } });
    expect(JSON.parse(history[1].tool_calls[0].function.arguments).omitted).toMatch(/^较早的参数，细节已省略：\{"items":"字/u);
    const total = history.reduce((sum, entry) => sum + (typeof entry.content === "string" ? entry.content.length : 0) + JSON.stringify(entry.tool_calls ?? "").length, 0);
    expect(total).toBeLessThanOrEqual(5_000 + 4_100);
    const once = structuredClone(history);
    compactHistory(history, 1_000);
    expect(history.slice(0, 12)).toEqual(once.slice(0, 12));
  });

  it("compacts before each request so an oversized old turn is sent briefly", async () => {
    const { fetchImpl, requests } = scripted([textReply("好了")]);
    const history = [
      { role: "user", content: "先剪一版" },
      { role: "assistant", content: "", tool_calls: [{ id: "old", type: "function", function: { name: "get_timeline", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "old", content: JSON.stringify({ ok: true, timeline: "x".repeat(130_000) }) },
      { role: "assistant", content: "剪好了" },
      { role: "user", content: "再快一点" },
    ];
    await runConversation({ config: ARK, history, tools: [{}], fetchImpl, system: async () => "系统提示", execute: async () => ({ ok: true }) });
    const sent = requests[0].body.messages;
    expect(sent.map((message) => message.role)).toEqual(["system", "user", "assistant", "tool", "assistant", "user"]);
    expect(JSON.parse(sent[3].content)).toEqual({ ok: true, omitted: OMITTED });
    expect(history[2].content).toBe(sent[3].content);
  });

  it("keeps the start of results the model still needs, and does not compact them twice", () => {
    const analysis = JSON.stringify({ ok: true, video: { title: "参考" }, analysis: "镜头".repeat(5_000) });
    const history = [
      { role: "user", content: "照这条剪" },
      { role: "assistant", content: "", tool_calls: [
        { id: "r1", type: "function", function: { name: "analyze_reference", arguments: "{\"url\":\"https://v.douyin.com/x\"}" } },
        { id: "g1", type: "function", function: { name: "get_timeline", arguments: "{}" } },
        { id: "s1", type: "function", function: { name: "search_douyin", arguments: "{}" } },
      ] },
      { role: "tool", tool_call_id: "r1", content: analysis },
      { role: "tool", tool_call_id: "g1", content: JSON.stringify({ ok: true, timeline: "x".repeat(10_000) }) },
      // 没比要留的长多少：压了反而更长，不动
      { role: "tool", tool_call_id: "s1", content: JSON.stringify({ ok: true, videos: "链".repeat(1_400) }) },
      { role: "assistant", content: "解析好了" },
      { role: "user", content: "开始剪" },
    ];
    const searched = history[4].content;
    compactHistory(history, 10_000);
    expect(JSON.parse(history[2].content)).toEqual({ ok: true, kept: `${analysis.slice(0, 6_000)}…`, omitted: OMITTED });
    expect(JSON.parse(history[3].content)).toEqual({ ok: true, omitted: OMITTED });
    expect(history[4].content).toBe(searched);
    const once = structuredClone(history);
    compactHistory(history, 1_000);
    expect(history).toEqual(once);
  });

  it("never cuts an emoji in half when shortening old arguments", () => {
    const args = JSON.stringify({ text: `${"字".repeat(70)}😀${"尾".repeat(300)}` });
    // 第 80 个字正好落在 emoji 的两半之间
    expect(args.slice(0, 80)).toMatch(/[\ud800-\udbff]$/u);
    const history = [
      { role: "user", content: "加字幕" },
      { role: "assistant", content: "", tool_calls: [{ id: "a", type: "function", function: { name: "add_text_clip", arguments: args } }] },
      { role: "tool", tool_call_id: "a", content: JSON.stringify({ ok: false, code: "x", message: `${"错".repeat(119)}😀${"y".repeat(500)}` }) },
      { role: "user", content: "再来" },
    ];
    compactHistory(history, 100);
    const omitted = JSON.parse(history[1].tool_calls[0].function.arguments).omitted;
    const message = JSON.parse(history[2].content).message;
    for (const text of [omitted, message]) {
      expect(text).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/u);
      expect(text.endsWith("…")).toBe(true);
      expect(text.endsWith("……")).toBe(false);
    }
  });
});

describe("what the model still knows after old turns are dropped", () => {
  const call = (id) => ({ id, type: "function", function: { name: "f", arguments: "{}" } });
  const turn = (index, said) => [
    { role: "user", content: said },
    { role: "assistant", content: "", tool_calls: [call(`t${index}`)] },
    { role: "tool", tool_call_id: `t${index}`, content: "y".repeat(100) },
    { role: "assistant", content: `第 ${index} 轮做完了` },
  ];
  const noted = (said) => `【应用自动附上，不是用户说的话】\n用户在看板上手动改过（以工程现状为准）：\n- 挪了片段\n【用户这次说的话】\n${said}`;

  it("puts the dropped user words in front of the first kept message for this request only", () => {
    const history = [...turn(1, "字幕用黄色\n描边"), ...turn(2, noted("节奏快一点")), ...turn(3, "第三轮"), ...turn(4, "第四轮")];
    const before = structuredClone(history);
    const budget = history.slice(8).reduce((sum, entry) => sum + (entry.content?.length ?? 0) + JSON.stringify(entry.tool_calls ?? "").length, 0);
    const { entries, trimmed } = requestHistory(history, budget);
    expect(trimmed).toBe(true);
    expect(entries).toHaveLength(8);
    // 只取用户真正说的话，换行并成空格
    expect(entries[0]).toEqual({ role: "user", content: "【应用自动附上，不是用户说的话】更早的对话已经省略，用户之前说过：\n- 字幕用黄色 描边\n- 节奏快一点\n【用户这次说的话】\n第三轮" });
    expect(entries.slice(1)).toEqual(history.slice(9));
    expect(history).toEqual(before);

    // 留下的第一条本来就带着应用附上的说明：并成一段，不重复开头
    const merged = requestHistory([...turn(1, "字幕用黄色"), ...turn(2, noted("第二轮"))], budget).entries[0].content;
    expect(merged).toBe("【应用自动附上，不是用户说的话】更早的对话已经省略，用户之前说过：\n- 字幕用黄色\n用户在看板上手动改过（以工程现状为准）：\n- 挪了片段\n【用户这次说的话】\n第二轮");
    expect(requestHistory(history)).toEqual({ entries: history, trimmed: false });
  });

  it("cuts each recalled message at 200 characters and all of them at 3000, keeping the latest", () => {
    const dropped = Array.from({ length: 30 }, (_, index) => ({ role: "user", content: `第 ${index} 句${"字".repeat(500)}` }));
    const lines = recallLines([...dropped, { role: "assistant", content: "好" }]);
    expect(lines).toHaveLength(14);
    expect(lines.every((line) => line.length <= 2 + 200 + 1 && line.endsWith("…"))).toBe(true);
    expect(lines.reduce((sum, line) => sum + line.length - 2, 0)).toBeLessThanOrEqual(3_000);
    expect(lines[0].startsWith("- 第 16 句")).toBe(true);
    expect(lines.at(-1).startsWith("- 第 29 句")).toBe(true);
    // 应用附上的说明不算用户的话；只说了说明、没说话的不列
    expect(recallLines([{ role: "user", content: noted("加转场") }, { role: "user", content: "【应用自动附上，不是用户说的话】\n【用户这次说的话】\n" }])).toEqual(["- 加转场"]);
  });

  it("tells the caller when a request dropped turns, without writing the recall back", async () => {
    const { fetchImpl, requests } = scripted([textReply("好")]);
    const words = (index) => `第 ${index} 轮：${"说".repeat(10)}`;
    const history = [1, 2, 3].flatMap((index) => [{ role: "user", content: words(index) }, { role: "assistant", content: "回".repeat(50_000) }]);
    history.push({ role: "user", content: "再快一点" });
    const before = structuredClone(history);
    let trimmed = 0;
    await runConversation({ config: ARK, history, tools: [{}], fetchImpl, system: async () => "s", execute: async () => ({ ok: true }), onTrimmed: () => { trimmed += 1; } });
    expect(trimmed).toBe(1);
    const sent = requests[0].body.messages;
    expect(sent[1].content).toBe(`【应用自动附上，不是用户说的话】更早的对话已经省略，用户之前说过：\n- ${words(1)}\n【用户这次说的话】\n${words(2)}`);
    expect(history.slice(0, before.length)).toEqual(before);
    // 没丢东西就不叫
    trimmed = 0;
    await runConversation({ config: ARK, history: [{ role: "user", content: "剪" }], tools: [{}], fetchImpl: scripted([textReply("好")]).fetchImpl, system: async () => "s", execute: async () => ({ ok: true }), onTrimmed: () => { trimmed += 1; } });
    expect(trimmed).toBe(0);
  });

  it("counts each attached image towards the history size", () => {
    const history = [
      { role: "user", content: "照这几张图剪", attachments: [1, 2, 3].map((index) => ({ id: `${index}`.repeat(16), media_id: "a".repeat(32), name: `${index}.png`, mime: "image/png" })) },
      { role: "assistant", content: "好" },
      { role: "user", content: "再快一点" },
    ];
    expect(trimHistory(history, 5_000)).toEqual(history.slice(2));
    expect(trimHistory(history, 7_000)).toEqual(history);
  });

  it("only counts the images that are sent, so old pictures alone never drop a turn", () => {
    const image = (index) => ({ id: `${index}`.padStart(16, "0"), media_id: "a".repeat(32), name: `${index}.png`, mime: "image/png" });
    const history = Array.from({ length: 30 }, (_, index) => [
      { role: "user", content: `第 ${index} 张`, attachments: [image(index * 2), image(index * 2 + 1)] },
      { role: "assistant", content: "好" },
    ]).flat();
    // 正文加起来不到 300 字；只有最近两条的 4 张图算数
    expect(requestHistory(history, 9_000)).toEqual({ entries: history, trimmed: false });
    const before = structuredClone(history);
    compactHistory(history, 9_000);
    expect(history).toEqual(before);
    expect(trimHistory(history, 7_000)).toEqual(history.slice(-2));
  });
});

describe("images the user pasted into the chat", () => {
  const attachment = (id, name = `${id}.jpg`) => ({ id: id.padEnd(16, "0"), media_id: "a".repeat(32), name, mime: "image/jpeg" });
  const pasted = () => [
    { role: "user", content: "第一张", attachments: [attachment("1")] },
    { role: "assistant", content: "好" },
    { role: "user", content: "第二张", attachments: [attachment("2")] },
    { role: "assistant", content: "好" },
    { role: "user", content: "这两张一起", attachments: [attachment("3"), attachment("4")] },
  ];
  const readAttachment = (reads) => async ({ id }) => { reads.push(id); return `data:image/jpeg;base64,${id}`; };
  const imageUrls = (message) => (Array.isArray(message.content) ? message.content.filter((part) => part.type === "image_url").map((part) => part.image_url) : []);

  it("sends the images of the last two messages that have any, names only for older ones, and never the attachments key", async () => {
    const { fetchImpl, requests } = scripted([toolReply([{ name: "get_timeline" }]), textReply("看到了")]);
    const reads = [];
    const history = pasted();
    await runConversation({ config: { ...ARK, model: "sees-images" }, history, tools: [{}], fetchImpl, system: async () => "s", execute: async () => ({ ok: true }), readAttachment: readAttachment(reads) });
    for (const request of requests) {
      const users = request.body.messages.filter((message) => message.role === "user");
      expect(users[0].content).toBe("第一张");
      expect(users[1].content).toEqual([{ type: "text", text: "第二张" }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${"2".padEnd(16, "0")}`, detail: "low" } }]);
      expect(imageUrls(users[2]).map((image) => image.url)).toEqual(["3", "4"].map((id) => `data:image/jpeg;base64,${id.padEnd(16, "0")}`));
      expect(request.body.messages.some((message) => "attachments" in message)).toBe(false);
    }
    // 一轮里每张图只读一次；历史里还是原样
    expect(reads.sort()).toEqual(["2", "3", "4"].map((id) => id.padEnd(16, "0")));
    expect(history[4]).toMatchObject({ content: "这两张一起", attachments: [{ name: "3.jpg" }, { name: "4.jpg" }] });
    // 图读不出来（文件没了）就照纯文字发
    const missing = scripted([textReply("好")]);
    await runConversation({ config: { ...ARK, model: "sees-images" }, history: pasted(), tools: [{}], fetchImpl: missing.fetchImpl, system: async () => "s", execute: async () => ({ ok: true }), readAttachment: async () => null });
    expect(missing.requests[0].body.messages.every((message) => typeof message.content === "string" && !("attachments" in message))).toBe(true);
  });

  it("resends without images when the model refuses them, remembers that and says so once", async () => {
    const config = { ...ARK, model: "no-eyes" };
    const actions = [];
    const refused = scripted([new Response(JSON.stringify({ error: { message: "Invalid content type. image_url is only supported by certain models." } }), { status: 400 }), toolReply([{ name: "a" }]), textReply("好了")]);
    const history = pasted();
    const result = await runConversation({ config, history, tools: [{}], fetchImpl: refused.fetchImpl, system: async () => "s", execute: async () => ({ ok: true }), readAttachment: readAttachment([]), onAction: (action) => actions.push(action) });
    expect(result.text).toBe("好了");
    expect(refused.requests.map((request) => request.body.messages.some((message) => Array.isArray(message.content)))).toEqual([true, false, false]);
    expect(actions).toEqual([{ name: "see_images", summary: "这个模型看不了图片，只告诉了它图片的名字", ok: false }]);

    // 之后都只写文字：不再试图，但用户这次又贴了图就再告诉用户一声
    const later = scripted([textReply("好")]);
    actions.length = 0;
    await runConversation({ config, history: pasted(), tools: [{}], fetchImpl: later.fetchImpl, system: async () => "s", execute: async () => ({ ok: true }), readAttachment: readAttachment([]), onAction: (action) => actions.push(action) });
    expect(later.requests[0].body.messages.some((message) => Array.isArray(message.content))).toBe(false);
    expect(actions).toHaveLength(1);
    const quiet = [];
    await runConversation({ config, history: [...pasted(), { role: "assistant", content: "好" }, { role: "user", content: "再快一点" }], tools: [{}], fetchImpl: scripted([textReply("好")]).fetchImpl, system: async () => "s", execute: async () => ({ ok: true }), readAttachment: readAttachment([]), onAction: (action) => quiet.push(action) });
    expect(quiet).toEqual([]);
  });

  it("does not blame the images when the request fails without them too", async () => {
    const config = { ...ARK, model: "broken-tools" };
    const invalid = () => new Response(JSON.stringify({ error: { message: "tools are not supported" } }), { status: 400 });
    const actions = [];
    await expect(runConversation({ config, history: pasted(), tools: [{}], fetchImpl: scripted([invalid(), invalid()]).fetchImpl, system: async () => "s", execute: async () => ({ ok: true }), readAttachment: readAttachment([]), onAction: (action) => actions.push(action) }))
      .rejects.toMatchObject({ code: "provider_error" });
    expect(actions).toEqual([]);
    const next = scripted([textReply("好")]);
    await runConversation({ config, history: pasted(), tools: [{}], fetchImpl: next.fetchImpl, system: async () => "s", execute: async () => ({ ok: true }), readAttachment: readAttachment([]) });
    expect(next.requests[0].body.messages.some((message) => Array.isArray(message.content))).toBe(true);
    // 流里报错、说的是图：也算拒收
    const streamed = scripted([sse([{ error: { message: "unknown variant `image_url`, expected `text`" } }]), textReply("好")]);
    const seen = [];
    await runConversation({ config: { ...ARK, model: "relay-text-only" }, history: pasted(), tools: [{}], fetchImpl: streamed.fetchImpl, system: async () => "s", execute: async () => ({ ok: true }), readAttachment: readAttachment([]), onAction: (action) => seen.push(action.name) });
    expect(seen).toEqual(["see_images"]);
  });

  it("resends without images when the answer says it cannot see them, keeping that answer out of the history", async () => {
    const shown = [];
    const { fetchImpl, requests } = scripted([textReply("抱歉，我无法查看图片，请描述一下。"), textReply("按名字理解，先放上去了。")]);
    const history = pasted();
    const result = await runConversation({ config: { ...ARK, model: "says-blind" }, history, tools: [{}], fetchImpl, system: async () => "s", execute: async () => ({ ok: true }), readAttachment: readAttachment([]), onText: (text) => shown.push(text) });
    expect(result.text).toBe("按名字理解，先放上去了。");
    expect(requests.map((request) => request.body.messages.some((message) => Array.isArray(message.content)))).toEqual([true, false]);
    expect(history.at(-1)).toEqual({ role: "assistant", content: "按名字理解，先放上去了。" });
    expect(shown.at(-1)).toBe("按名字理解，先放上去了。");
    // 看得到图、只是图里没有字：不算
    const fine = scripted([textReply("看不到图片里有文字，我加一行标题。")]);
    await runConversation({ config: { ...ARK, model: "sees-fine" }, history: pasted(), tools: [{}], fetchImpl: fine.fetchImpl, system: async () => "s", execute: async () => ({ ok: true }), readAttachment: readAttachment([]) });
    expect(fine.requests).toHaveLength(1);
  });

  it("only listens for 'cannot see' in the first answer after new images, and not to talk about the timeline", async () => {
    const config = { ...ARK, model: "sees-timeline" };
    // 图是更早贴的，这一轮回答说的是时间线上没有图
    const earlier = [...pasted(), { role: "assistant", content: "好" }, { role: "user", content: "片头那张图怎么不见了" }];
    const first = scripted([textReply("时间线上没有看到图片，只有两段视频。我看不到你发的图片的话会直说。")]);
    await runConversation({ config, history: earlier, tools: [{}], fetchImpl: first.fetchImpl, system: async () => "s", execute: async () => ({ ok: true }), readAttachment: readAttachment([]) });
    expect(first.requests).toHaveLength(1);
    // 这一轮贴了图，但做完事以后的总结里才说看不到：也不算
    const later = scripted([toolReply([{ name: "a" }]), textReply("我看不到你发的图片里的字幕，先按名字放了。")]);
    await runConversation({ config, history: pasted(), tools: [{}], fetchImpl: later.fetchImpl, system: async () => "s", execute: async () => ({ ok: true }), readAttachment: readAttachment([]) });
    expect(later.requests).toHaveLength(2);
    // 没记成看不了图：下一次照样带图
    const next = scripted([textReply("好")]);
    await runConversation({ config, history: pasted(), tools: [{}], fetchImpl: next.fetchImpl, system: async () => "s", execute: async () => ({ ok: true }), readAttachment: readAttachment([]) });
    expect(next.requests[0].body.messages.some((message) => Array.isArray(message.content))).toBe(true);
    // 这一轮刚贴了图、第一句就说看不到：照常去图重发
    const blind = scripted([textReply("我看不到你发的图片，能描述一下吗？"), textReply("好")]);
    await runConversation({ config: { ...ARK, model: "says-blind-2" }, history: pasted(), tools: [{}], fetchImpl: blind.fetchImpl, system: async () => "s", execute: async () => ({ ok: true }), readAttachment: readAttachment([]) });
    expect(blind.requests).toHaveLength(2);
  });

  it("tells answers about the user's pictures from talk about the project", () => {
    for (const text of [
      "抱歉，我无法查看图片，请描述一下。", "我看不到你发的图片，能描述一下吗？", "抱歉，目前无法查看图片内容。", "您上传的图片我看不到。",
      "我是纯文本模型，没法看图。", "看不到这张图，能说说里面是什么吗", "我无法查看图片中的内容", "I'm sorry, but I can't view images.",
    ]) expect(saysCantSeeImages(text)).toBe(true);
    for (const text of [
      "时间线上没有看到图片，只有两段视频", "素材库里没有看到图片素材", "我没法直接处理图片格式的字幕", "剪映里不能直接显示截图水印",
      "片头那段现在看不到图片了，我把它加回去了", "画面里看不见照片，因为被视频盖住了", "看不到图片里有文字，我加一行标题。",
    ]) expect(saysCantSeeImages(text)).toBe(false);
  });

  it("drops the images once when the relay says the request is too large, without calling the model blind, and keeps later turns light", async () => {
    const config = { ...ARK, model: "too-big" };
    const requests = [];
    const withPictures = (body) => body.messages.some((message) => Array.isArray(message.content));
    const fetchImpl = async (_url, init) => {
      const body = JSON.parse(init.body);
      requests.push(body);
      return withPictures(body) && requests.length <= 2
        ? new Response("<html><center><h1>413 Request Entity Too Large</h1></center></html>", { status: 413, headers: { "content-type": "text/html" } })
        : textReply("好");
    };
    const actions = [];
    const history = pasted();
    const turn = () => runConversation({ config, history, tools: [{}], fetchImpl, system: async () => "s", execute: async () => ({ ok: true }), readAttachment: readAttachment([]), onAction: (action) => actions.push(action) });
    await expect(turn()).resolves.toMatchObject({ text: "好" });
    expect(requests.map(withPictures)).toEqual([true, false]);
    expect(actions).toEqual([{ name: "see_images", summary: "图太大，接口收不下，这次只告诉了它图片的名字", ok: false }]);
    // 下一轮没贴图：旧消息里的图不再发，不会每轮都撞一次
    history.push({ role: "user", content: "再快一点" });
    actions.length = 0;
    await expect(turn()).resolves.toMatchObject({ text: "好" });
    expect(requests.slice(2).map(withPictures)).toEqual([false]);
    expect(actions).toEqual([]);
    // 没被记成看不了图：又贴了图就只发这一条自己的图
    history.push({ role: "user", content: "换这张", attachments: [attachment("5")] });
    await turn();
    const users = requests.at(-1).messages.filter((message) => message.role === "user");
    expect(users.slice(0, -1).every((message) => typeof message.content === "string")).toBe(true);
    expect(imageUrls(users.at(-1)).map((image) => image.url)).toEqual([`data:image/jpeg;base64,${"5".padEnd(16, "0")}`]);
    // 纯文字的请求真遇到 413 也有线索
    const plainTooBig = async () => new Response("<html>413</html>", { status: 413, headers: { "content-type": "text/html" } });
    await expect(requestCompletion({ config, messages: [], fetchImpl: plainTooBig })).rejects.toMatchObject({ message: "请求太大，接口收不下（多半是图太多或太大）。" });
  });
});
