import { describe, expect, it } from "vitest";

import { MAX_TOOL_CALLS, parseEditConfig, requestCompletion, runConversation, sealHistory, trimHistory } from "./chat.mjs";

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
    const replies = Array.from({ length: 30 }, () => toolReply([{ name: "a" }, { name: "b" }]));
    const { fetchImpl, requests } = scripted([...replies.slice(0, 20), sse([delta({ content: "先做到这里。" }), delta({ tool_calls: [{ index: 0, id: "late", function: { name: "a", arguments: "{}" } }] })])]);
    const history = [{ role: "user", content: "做很多事" }];
    let executed = 0;
    const result = await runConversation({ config: ARK, history, tools: [{}], fetchImpl, system: async () => "s", execute: async () => { executed += 1; return { ok: true }; } });
    expect(executed).toBe(MAX_TOOL_CALLS);
    expect(requests).toHaveLength(21);
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

  it("asks reasoning models to think less, and stops sending that to an endpoint that refuses it", async () => {
    // 远端 gpt-6.1-sol 排时间线时想了 100 多秒，中转站回 524
    const relay = { baseUrl: "https://relay.example.com/v1", apiKey: "k", model: "gpt-x" };
    const first = scripted([textReply("好")]);
    await requestCompletion({ config: relay, messages: [], fetchImpl: first.fetchImpl });
    expect(first.requests[0].body).toMatchObject({ reasoning_effort: "low" });
    const ark = scripted([textReply("好")]);
    await requestCompletion({ config: ARK, messages: [], fetchImpl: ark.fetchImpl });
    expect(ark.requests[0].body.reasoning_effort).toBeUndefined();
    expect(ark.requests[0].body.thinking).toEqual({ type: "disabled" });
    // 本地 Ollama 上不会思考的模型：400 正文里没提参数名，照样去掉重发，之后这个接口不再带
    const ollama = { baseUrl: "http://127.0.0.1:11434/v1", apiKey: "k", model: "gemma3:12b" };
    const refusing = scripted([new Response(JSON.stringify({ error: { message: "\"gemma3:12b\" does not support thinking" } }), { status: 400 }), textReply("好"), textReply("又好")]);
    await expect(requestCompletion({ config: ollama, messages: [], fetchImpl: refusing.fetchImpl })).resolves.toMatchObject({ text: "好" });
    await expect(requestCompletion({ config: ollama, messages: [], fetchImpl: refusing.fetchImpl })).resolves.toMatchObject({ text: "又好" });
    expect(refusing.requests.map((request) => request.body.reasoning_effort)).toEqual(["low", undefined, undefined]);
    // 别的 400（不支持工具调用）：重发一次也一样，照常报，也不记成「不认这个参数」
    const noTools = { baseUrl: "https://no-tools.example.com/v1", apiKey: "k", model: "m" };
    const invalid = () => new Response(JSON.stringify({ error: { message: "tools is not supported" } }), { status: 400 });
    const rejecting = scripted([invalid(), invalid(), textReply("好")]);
    await expect(requestCompletion({ config: noTools, messages: [], tools: [{}], fetchImpl: rejecting.fetchImpl })).rejects.toMatchObject({ code: "provider_error", message: expect.stringContaining("tools is not supported") });
    await requestCompletion({ config: noTools, messages: [], fetchImpl: rejecting.fetchImpl });
    expect(rejecting.requests.map((request) => request.body.reasoning_effort)).toEqual(["low", undefined, "low"]);
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
});
