// Browser regression check against the built app, using synthetic local data only.
// Run after exporting the web app. Set DY2_CHROMIUM if Playwright's browser is not installed.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { startCollectorServer } from "../collector/server.mjs";
import { startStaticServer } from "../desktop/staticServer.mjs";
import { createEmptyRecords } from "../collector/normalizer.mjs";
import { DouyinCollector } from "../collector/douyinCollector.mjs";

const directory = await mkdtemp(path.join(os.tmpdir(), "dy2-group-ui-"));
let runtime, web, browser;
let remoteReads = 0;
let initializations = 0;
const messages = Array.from({ length: 400 }, (_, i) => ({ id: String(i + 1), conversationId: "101", conversationType: "group", senderId: "9", senderName: "合成成员",
  text: `合成消息-${String(i).padStart(3, "0")}`, type: "text", sentAt: new Date(Date.UTC(2026, 10, 1, 0, 0, i)).toISOString() }));
const preview = { ...messages[0], id: "cached-preview", conversationId: "202", text: "待授权的群消息" };
const conversations = [{ id: "101", name: "回归测试群", kind: "group", type: 2, messageCount: 400, ownMessageCount: 0 },
  { id: "202", name: "白名单切换测试群", kind: "group", type: 2, messageCount: 1, ownMessageCount: 0 }];
const originalInitialize = DouyinCollector.prototype.initialize;
DouyinCollector.prototype.initialize = async function () {
  await originalInitialize.call(this);
  // Use the real reception and storage lifecycle with a synthetic upstream.
  const client = {
    conversations: new Map(conversations.map(item => [item.id, item])),
    messagePages: new Map([["101", { messages, hasMore: false }], ["202", { messages: [preview], hasMore: false }]]),
    initialize: async ({ onPayload }) => { initializations++; await onPayload({ conversations, messages: [] }); },
    connect: async ({ onConnection }) => onConnection("connected"), close: async () => {},
    messages: async ({ conversationId }) => {
      remoteReads++;
      const page = client.messagePages.get(conversationId);
      return { ...page, pageMessages: page.messages };
    },
  };
  const api = { session: { uid: "9" }, chatClient: client, close: async () => {} };
  this.directApi = api;
  this.ensureDirectApi = async () => api;
  this.startChatObservation();
};
try {
  await writeFile(path.join(directory, "group-chat-storage.json"), JSON.stringify({ conversationIds: ["101"] }));
  await writeFile(path.join(directory, "records.json"), JSON.stringify({ schemaVersion: 2, records: createEmptyRecords(), chatMessages: messages,
    chatConversations: conversations, warnings: [] }));
  runtime = await startCollectorServer({ port: 0, dataDirectory: directory, browserSources: [], desktopSupported: false });
  web = await startStaticServer({ rootDirectory: path.resolve("dist") });
  browser = await chromium.launch({ headless: true, ...(process.env.DY2_CHROMIUM ? { executablePath: process.env.DY2_CHROMIUM } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.addInitScript(() => localStorage.setItem("dy2.pioneerBadge", "1"));
  await page.goto(web.url);
  await page.getByRole("textbox", { name: "采集服务地址", exact: true }).fill(runtime.baseUrl);
  await page.getByRole("button", { name: "连接采集器", exact: true }).click();
  await page.getByRole("button", { name: "关闭设置", exact: true }).click();
  await page.getByRole("button", { name: "进入工作台", exact: true }).click();
  await page.getByRole("tab", { name: /^聊天/ }).click();
  await page.locator('[data-testid="chat-conversation-101"]').click();
  await page.getByText("仅显示最近 320 条，另有 80 条更早消息保留在本地快照中。", { exact: true }).waitFor();
  await page.locator('[data-testid="chat-detail-pane"]').getByText("合成消息-399", { exact: true }).waitFor();
  assert.equal(await page.locator('[data-testid="chat-detail-pane"]').getByText("合成消息-000", { exact: true }).count(), 0, "The local view retains the existing 320-message limit");
  assert.equal(await page.locator('[data-testid="chat-local-older"]').count(), 0, "The allowlist feature has no local pagination control");
  assert.equal(remoteReads, 0, "Opening a stored group must read local data first");
  assert.equal(JSON.parse(await readFile(path.join(directory, "records.json"), "utf8")).chatMessages.length, 400, "The UI limit must not remove stored history");
  const remote = page.locator('[data-testid="chat-group-fetch-older"]');
  await remote.waitFor();
  const response = page.waitForResponse(result => new URL(result.url()).pathname === "/v1/chat/messages" && result.request().method() === "POST");
  await remote.click();
  assert.equal((await response).status(), 200);
  await page.waitForFunction(() => document.body.innerText.includes("没有更早的消息了"));
  assert.ok(remoteReads > 0, "The explicit fetch action must reach the remote read endpoint");
  assert.ok(await page.getByText("合成消息-000", { exact: true }).count(), "A remote page must not replace stored history");
  console.log("PASS: local view shows the latest 320 of 400 stored messages; remote reads require the explicit action");
  await page.locator('[data-testid="chat-conversation-202"]').click();
  await page.locator('[data-testid="chat-detail-pane"]').getByText("待授权的群消息", { exact: true }).waitFor();
  const readsBeforeChange = remoteReads, initializationsBeforeChange = initializations;
  await page.getByRole("button", { name: "打开设置", exact: true }).click();
  await page.locator('[data-testid="settings-tab-privacy"]').click();
  const saved = page.waitForResponse(result => new URL(result.url()).pathname === "/v1/settings/group-chat-storage" && result.request().method() === "POST");
  await page.locator('[data-testid="settings-group-202"]').click();
  assert.equal((await saved).status(), 200);
  await page.getByRole("button", { name: "关闭设置", exact: true }).click();
  await page.locator('[data-testid="chat-detail-pane"]').getByText("待授权的群消息", { exact: true }).waitFor();
  await page.locator('[data-testid="chat-detail-pane"]').getByText("1 条本地群消息", { exact: true }).waitFor({ timeout: 10_000 });
  assert.equal(remoteReads, readsBeforeChange, "Authorizing fetched messages must not refetch them");
  assert.equal(initializations, initializationsBeforeChange, "Changing the allowlist must not restart reception");
  const stored = JSON.parse(await readFile(path.join(directory, "records.json"), "utf8"));
  assert.ok(stored.chatMessages.some(message => message.id === "cached-preview"), "The cached preview must become local data immediately");
  assert.equal(await page.getByRole("button", { name: "开始接收", exact: true }).count(), 0, "No manual reception restart should be needed");
  console.log("PASS: enabling the allowlist preserves displayed messages, saves the cache, and keeps reception running");
  // Pause before changing the setting: the UI must refresh without reception polling.
  await page.getByRole("button", { name: "暂停接收", exact: true }).click();
  await page.getByRole("button", { name: "开始接收", exact: true }).waitFor();
  await page.getByRole("button", { name: "打开设置", exact: true }).click();
  await page.locator('[data-testid="settings-tab-privacy"]').click();
  const toggle = page.locator('[data-testid="settings-group-202"]');
  let settingsPosts = 0;
  const countSettingsPost = request => { if (new URL(request.url()).pathname === "/v1/settings/group-chat-storage" && request.method() === "POST") settingsPosts++; };
  page.on("request", countSettingsPost);
  page.once("dialog", async dialog => {
    assert.equal(dialog.type(), "confirm");
    assert.ok(dialog.message().includes("白名单切换测试群") && dialog.message().includes("1 条消息"));
    await dialog.dismiss();
  });
  await toggle.click();
  await page.waitForFunction(() => document.querySelector('[data-testid="settings-group-202"]')?.getAttribute("aria-disabled") !== "true");
  assert.equal(await toggle.getAttribute("aria-checked"), "true");
  assert.equal(settingsPosts, 0, "Cancelling must not send a settings mutation");
  assert.ok(JSON.parse(await readFile(path.join(directory, "records.json"), "utf8")).chatMessages.some(message => message.id === "cached-preview"));
  console.log("PASS: cancelling deletion preserves the switch and local history");
  const failDeletion = async route => {
    if (route.request().method() === "POST") await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "settings_save_failed", message: "合成删除失败" }) });
    else await route.continue();
  };
  await page.route("**/v1/settings/group-chat-storage?*", failDeletion);
  page.once("dialog", dialog => dialog.accept());
  await toggle.click();
  await page.getByText("合成删除失败", { exact: true }).waitFor();
  assert.equal(await toggle.getAttribute("aria-checked"), "true");
  assert.ok(JSON.parse(await readFile(path.join(directory, "records.json"), "utf8")).chatMessages.some(message => message.id === "cached-preview"));
  await page.unroute("**/v1/settings/group-chat-storage?*", failDeletion);
  const deleted = page.waitForResponse(result => new URL(result.url()).pathname === "/v1/settings/group-chat-storage" && result.request().method() === "POST");
  page.once("dialog", dialog => dialog.accept());
  await toggle.click();
  assert.equal((await deleted).status(), 200);
  await page.waitForFunction(() => document.querySelector('[data-testid="settings-group-202"]')?.getAttribute("aria-checked") === "false");
  const cleared = JSON.parse(await readFile(path.join(directory, "records.json"), "utf8"));
  assert.equal(cleared.chatMessages.some(message => message.conversationId === "202"), false);
  assert.equal(cleared.chatMessages.filter(message => message.conversationId === "101").length, 400);
  await page.getByRole("button", { name: "关闭设置", exact: true }).click();
  await page.locator('[data-testid="chat-detail-pane"]').getByText("群聊统计摘要", { exact: true }).waitFor();
  assert.equal(await page.locator('[data-testid="chat-detail-pane"]').getByText("待授权的群消息", { exact: true }).count(), 0);
  await page.locator('[data-testid="chat-detail-pane"]').getByText("不存本机", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "开始接收", exact: true }).count(), 1);
  page.off("request", countSettingsPost);
  console.log("PASS: failure keeps history; confirmed deletion clears disk and the paused chat UI, preserving other groups");
} finally {
  await browser?.close();
  await web?.close();
  await runtime?.close();
  await rm(directory, { recursive: true, force: true });
}
