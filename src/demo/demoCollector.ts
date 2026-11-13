// 在线体验版（GitHub Pages）没有本机采集器：只有 EXPO_PUBLIC_DEMO=1 打包时才装上，
// 把发往采集器地址的 fetch 接过来，用固定种子合成的记录回答。桌面版和本地网页版不会走到这里
import { getDefaultCollectorBaseUrl } from "../services/localCollector";

const DAY = 86_400_000;

// 固定种子：每次打开看到的都是同一份「别人」的一年，只是日期跟着今天走，近七天的卡片才有东西
function makeRandom(seed: number) {
  return () => (seed = (seed * 48271) % 2147483647) / 2147483647;
}

const CREATORS: ReadonlyArray<{ name: string; topic: string; titles: string[] }> = [
  { name: "阿树的厨房", topic: "美食", titles: ["一人食番茄牛腩，炖到软烂只要四十分钟", "十块钱搞定一周早餐", "外婆的葱油拌面，酱汁比例写在最后", "空气炸锅烤鸡翅，不用腌一晚上", "冬天第一锅羊肉汤"] },
  { name: "小林在路上", topic: "旅行", titles: ["凌晨四点爬山看云海，值不值", "大理住了一个月，花了多少钱", "绿皮火车 30 小时纪实", "一个人去新疆的第七天", "海边小镇的清晨菜市场"] },
  { name: "物理老周", topic: "知识", titles: ["为什么天是蓝的，傍晚又是红的", "三分钟讲懂相对论里的同时性", "冰箱是怎么把热量搬出去的", "飞机为什么能飞，课本可能讲错了", "用一根吸管演示大气压"] },
  { name: "猫咪豆包", topic: "萌宠", titles: ["豆包第一次见到雪", "主人出门十分钟后的监控", "猫咪被吹风机吓到的表情", "给豆包买的新窝它不睡", "豆包和快递箱的爱恨情仇"] },
  { name: "代码夜读", topic: "科技", titles: ["一个 bug 查了三天，最后是时区", "用两百行写一个能用的待办应用", "程序员的桌面整理", "AI 写代码到底靠不靠谱，实测一周", "新手最容易踩的五个 Git 坑"] },
  { name: "晚风读书", topic: "读书", titles: ["这本书我读了三遍", "一年读完 50 本书的方法", "适合睡前读的五本短篇", "把读书笔记做成卡片", "我为什么重读《活着》"] },
  { name: "跑者阿杰", topic: "运动", titles: ["从跑不动一公里到半马", "跑步膝盖疼，先检查这三处", "下雨天在家也能练的核心训练", "第一次跑全马的真实感受", "跑鞋怎么选，不用看广告"] },
  { name: "画画的小满", topic: "绘画", titles: ["十分钟画一张窗边的光", "水彩新手第一张晚霞", "用一支笔画完整条老街", "板绘线稿怎么画得干净", "给朋友的猫画了一张肖像"] },
  { name: "老城记忆", topic: "人文", titles: ["这条巷子要拆了，去拍最后一次", "老师傅修了四十年自行车", "八十年代的照相馆", "胡同里的早点铺开了三十年", "老电影院的放映员"] },
  { name: "收纳研究所", topic: "生活", titles: ["十平米出租屋改造", "衣柜这样收能多放一倍", "厨房台面清空之后", "搬家打包的顺序很重要", "断舍离一个月的变化"] },
  { name: "吉他手阿远", topic: "音乐", titles: ["零基础三个和弦弹一首歌", "地铁站里弹了半小时", "这段前奏练了一个月", "给老歌编了个新和声", "指弹入门先练这个节奏"] },
  { name: "种菜的阿婆", topic: "三农", titles: ["阳台种番茄，三个月的变化", "今年的第一茬韭菜", "院子里的柿子熟了", "腌一坛酸豆角", "下雨前抢收花生"] },
];

const TAIL_NAMES = ["山野", "南风", "橘子", "日常", "一只", "北方", "慢慢", "阿北", "半夏", "小鹿", "青柠", "月亮"];
const TAIL_SUFFIX = ["的日记", "研究所", "vlog", "说", "在吗", "笔记", "小屋", "频道"];
const TAIL_TITLES = ["今天也是普通的一天", "随手拍的晚霞", "这个方法真的有用", "第一次尝试，翻车了", "周末去了一趟郊外", "给自己做顿好的", "看完这个我沉默了", "终于等到这一天"];

const FRIENDS = [
  { id: "demo-c1", name: "小雨" },
  { id: "demo-c2", name: "老王" },
  { id: "demo-c3", name: "阿明" },
  { id: "demo-c4", name: "妈妈" },
];
const LINES = ["在吗", "刚看到你发的，笑死[捂脸]", "周末有空吗", "[呲牙][呲牙]", "好[赞]", "辛苦了[抱抱你]", "太可爱了吧[星星眼]", "这个视频你看过没", "晚上吃什么", "我到了", "好的好的", "哈哈哈哈哈", "明天几点", "下班了没", "这家店不错，下次一起去", "收到", "你发的那个我存了", "早点睡", "路上注意安全", "刚开完会", "这也太巧了吧", "等我五分钟"];

const SAMPLE_AT = new Date();

// 观看/喜欢/收藏/聊天的合成数据；时间分布有昼夜和周末起伏，持续报告和年度报告才看得出东西
function makeSnapshot() {
  const rnd = makeRandom(20261113);
  const pick = <T,>(items: readonly T[]) => items[Math.floor(rnd() * items.length)] as T;
  const now = SAMPLE_AT.getTime();
  const at = (daysAgo: number) => {
    const hour = rnd() < 0.55 ? 19 + Math.floor(rnd() * 5) : rnd() < 0.6 ? 12 + Math.floor(rnd() * 2) : 7 + Math.floor(rnd() * 12);
    const time = new Date(now - daysAgo * DAY);
    time.setHours(hour, Math.floor(rnd() * 60), Math.floor(rnd() * 60), 0);
    // 今天还没到的钟点挪到昨天
    return time.getTime() > now ? time.getTime() - DAY : time.getTime();
  };
  const tail = TAIL_NAMES.flatMap((head) => TAIL_SUFFIX.map((suffix) => `${head}${suffix}`));
  const watch = [];
  for (let i = 0; i < 1800; i++) {
    // 越近看得越多；头部几位常看的博主占四成
    const daysAgo = Math.floor(Math.pow(rnd(), 1.4) * 320);
    const head = rnd() < 0.42;
    const creator = head ? CREATORS[Math.floor(Math.pow(rnd(), 1.3) * CREATORS.length)]! : null;
    const author = creator?.name ?? pick(tail);
    const duration = rnd() < 0.5 ? 15 + Math.floor(rnd() * 50) : rnd() < 0.8 ? 90 + Math.floor(rnd() * 400) : 600 + Math.floor(rnd() * 1200);
    const percent = rnd() < 0.35 ? 100 : Math.round(20 + rnd() * 75);
    watch.push({
      id: `demo-w${i}`,
      videoId: `demo${100000 + (i % 1500)}`,
      title: creator ? pick(creator.titles) : pick(TAIL_TITLES),
      author,
      authorId: `demo-${author}`,
      occurredAt: new Date(at(daysAgo)).toISOString(),
      occurredAtSource: "platform_action",
      url: null,
      mediaType: rnd() < 0.85 ? "video" : "image",
      durationSeconds: duration,
      topics: [creator?.topic ?? pick(["生活", "日常", "搞笑", "情感"])],
      stats: { diggCount: Math.floor(rnd() * 200000), commentCount: Math.floor(rnd() * 8000), collectCount: Math.floor(rnd() * 30000), shareCount: Math.floor(rnd() * 9000) },
      watchProgress: { watchedSeconds: Math.round(duration * percent / 100), percent },
    });
  }
  // 采集器给的记录新的在前
  watch.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  const liked = watch.filter((_, i) => i % 4 === 1).slice(0, 360).map((record, i) => ({ ...record, id: `demo-l${i}` }));
  const favorite = watch.filter((_, i) => i % 11 === 3).slice(0, 120).map((record, i) => ({ ...record, id: `demo-f${i}` }));

  const conversations = FRIENDS.map((friend) => ({ id: friend.id, kind: "friend", name: friend.name, messageCount: 0, ownMessageCount: 0 }));
  const messages = [];
  for (let i = 0; i < 1400; i++) {
    const conversation = conversations[Math.floor(Math.pow(rnd(), 1.6) * conversations.length)]!;
    const own = rnd() < 0.5;
    const roll = rnd();
    const type = roll < 0.8 ? "text" : roll < 0.95 ? "share" : "call";
    const shared = type === "share" ? pick(watch) : null;
    conversation.messageCount++;
    if (own) conversation.ownMessageCount++;
    messages.push({
      id: `demo-m${i}`,
      conversationId: conversation.id,
      conversationType: "friend",
      conversationName: conversation.name,
      senderId: own ? "demo-me" : `${conversation.id}-peer`,
      senderName: own ? "我" : conversation.name,
      sentAt: new Date(at(Math.floor(Math.pow(rnd(), 1.2) * 300))).toISOString(),
      type,
      text: type === "text" ? pick(LINES) : null,
      mediaUrl: null,
      share: shared ? { title: shared.title, author: shared.author, coverUrl: null, url: null } : null,
      callDurationSeconds: type === "call" ? 60 + Math.floor(rnd() * 900) : null,
    });
  }
  messages.sort((a, b) => a.sentAt.localeCompare(b.sentAt));
  return {
    schemaVersion: 2,
    updatedAt: SAMPLE_AT.toISOString(),
    records: { watch_history: watch, liked_videos: liked, favorite_videos: favorite },
    chatMessages: messages,
    chatConversations: conversations,
    warnings: [],
  };
}

let snapshot: ReturnType<typeof makeSnapshot> | null = null;
const demoSnapshot = () => (snapshot ??= makeSnapshot());

function status() {
  const { records, chatMessages } = demoSnapshot();
  return {
    state: "complete",
    phase: null,
    message: "这是在线体验版，记录是合成的示例数据。",
    counts: {
      watch_history: records.watch_history.length,
      liked_videos: records.liked_videos.length,
      favorite_videos: records.favorite_videos.length,
      chat_messages: chatMessages.length,
    },
    progress: null,
    updatedAt: SAMPLE_AT.toISOString(),
    browserOpen: false,
    revision: 1,
    recordsRevision: 1,
    syncMode: null,
    readPermissions: { videos: true, chat: true },
    chat: { state: "complete", connection: null, message: null, progress: null },
    account: { id: "default", uid: null, nickname: "示例账号", avatar: null },
    browserSource: { mode: "independent", browser: null, connected: true, credentials: "ready" },
  };
}

const ACCOUNTS = { activeId: "default", accounts: [{ id: "default", nickname: "示例账号", avatar: null, uid: null, createdAt: SAMPLE_AT.toISOString() }] };

// 读取、下载、登录这些要真连抖音的操作一律回这句。借用 collector_busy：requestJson 对它会原样显示 message
// ponytail: 只按路径分流；以后哪个页面要更像样的演示数据，在 answer 里加一条路径
const UNAVAILABLE = { error: "collector_busy", message: "在线体验版不连抖音，这个操作要下载桌面版才能用。" };

const ASSISTANT = { revision: 1, busy: false, messages: [], streaming: null, error: null, confirms: [], ui: null };
// 读取、收聊天：记录已经「读完」，直接回读完的状态
const SYNC_PATHS = ["/v1/sync", "/v1/sync/stop", "/v1/experimental/records-direct", "/v1/chat/observe", "/v1/chat/observe/stop"];

function answer(method: string, path: string, query: URLSearchParams): unknown {
  if (path === "/v1/health") return { ok: true, version: 1 };
  if (path === "/v1/pairing-code") return { code: "20261113" };
  if (path === "/v1/pair") return { token: "demo".repeat(10) };
  if (path === "/v1/status") return status();
  if (method === "POST" && SYNC_PATHS.includes(path)) return { status: status() };
  if (method !== "GET") return null;
  if (path === "/v1/accounts") return ACCOUNTS;
  if (path === "/v1/assistant") return ASSISTANT;
  if (path === "/v1/my-comments") return { comments: [] };
  if (path === "/v1/feed-filter/videos") return { videos: [] };
  if (path === "/v1/feed-filter/events") return { events: [] };
  if (path === "/v1/settings/writes") return { enabled: false };
  if (path === "/v1/records") {
    const part = query.get("part");
    if (part === "new") return { run: Number(query.get("run")) || 0, after: Number(query.get("after")) || 0, records: [] };
    const full = demoSnapshot();
    return part === "chat" ? { ...full, records: undefined } : full;
  }
  return null;
}

export function installDemoCollector(): void {
  const base = getDefaultCollectorBaseUrl();
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== new URL(base).origin) return realFetch(input, init);
    const method = (init?.method ?? "GET").toUpperCase();
    // 文件夹回 404：界面当成采集器太旧，不显示文件夹
    if (url.pathname === "/v1/folders") return new Response(null, { status: 404 });
    // 状态、AI 助手的长轮询：和真采集器一样没有新进展就挂 8 秒再回当前状态
    if (url.searchParams.has("afterRevision")) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 8_000);
        init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); });
      });
    }
    const body = answer(method, url.pathname, url.searchParams);
    if (body === null) console.info("[demo] 没有演示数据：", method, url.pathname);
    return new Response(JSON.stringify(body ?? UNAVAILABLE), {
      status: body === null ? 503 : 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  // 第一次打开先落在持续报告（刷视频要真连抖音），也不弹先驱者徽章
  try {
    if (!localStorage.getItem("content-insights.feed")) localStorage.setItem("content-insights.feed", "off");
    localStorage.setItem("dy2.pioneerBadge", "1");
  } catch {
    // 无痕模式读不了 localStorage，照常打开
  }
}
