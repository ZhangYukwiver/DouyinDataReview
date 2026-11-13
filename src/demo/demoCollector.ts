// 在线体验版（GitHub Pages）没有本机采集器：只有 EXPO_PUBLIC_DEMO=1 打包时才装上，
// 把发往采集器地址的 fetch 接过来，用固定种子合成的记录回答。桌面版和本地网页版不会走到这里
import { getDefaultCollectorBaseUrl } from "../services/localCollector";
import { ACCOUNT_AVATAR, avatar, cover, TOPIC_COLORS } from "./demoArt";
import { answerCreatorRead } from "./demoCreator";

const DAY = 86_400_000;

// 固定种子：每次打开看到的都是同一份「别人」的一年，只是日期跟着今天走，近七天的卡片才有东西
function makeRandom(seed: number) {
  return () => (seed = (seed * 48271) % 2147483647) / 2147483647;
}

// 常看的十几位博主：几条手写标题，再加一组按模板拼的系列作品（series：模板 + 空格分开的题目），每人十几条不同作品
const CREATOR_SOURCE: ReadonlyArray<{ name: string; topic: string; titles: string[]; series: [string, string] }> = [
  { name: "阿树的厨房", topic: "美食", titles: ["一人食番茄牛腩，炖到软烂只要四十分钟", "十块钱搞定一周早餐", "外婆的葱油拌面，酱汁比例写在最后", "空气炸锅烤鸡翅，不用腌一晚上", "冬天第一锅羊肉汤", "电饭煲做腊肠饭", "三分钟学会溏心蛋"], series: ["{x}的家常做法", "红烧肉 糖醋排骨 酸菜鱼 可乐鸡翅 麻婆豆腐 西红柿炒蛋 土豆炖牛肉 葱爆羊肉 蒜蓉粉丝虾 番茄蛋花汤"] },
  { name: "小林在路上", topic: "旅行", titles: ["凌晨四点爬山看云海，值不值", "大理住了一个月，花了多少钱", "绿皮火车 30 小时纪实", "一个人去新疆的第七天", "海边小镇的清晨菜市场", "雨崩徒步全记录"], series: ["{x}三天怎么玩", "成都 西安 厦门 青岛 桂林 拉萨 洱海 喀什 婺源 长沙"] },
  { name: "物理老周", topic: "知识", titles: ["为什么天是蓝的，傍晚又是红的", "三分钟讲懂相对论里的同时性", "冰箱是怎么把热量搬出去的", "飞机为什么能飞，课本可能讲错了", "用一根吸管演示大气压", "彩虹为什么是弯的"], series: ["{x}是怎么回事", "静电 回声 海市蜃楼 极光 潮汐 雷声 冰浮在水上 肥皂泡的颜色 微波炉加热 磁悬浮"] },
  { name: "猫咪豆包", topic: "萌宠", titles: ["豆包第一次见到雪", "主人出门十分钟后的监控", "猫咪被吹风机吓到的表情", "给豆包买的新窝它不睡", "豆包和快递箱的爱恨情仇"], series: ["豆包{x}", "第一次洗澡 偷吃猫条 半夜跑酷 打翻水杯 晒太阳 等主人下班 看到黄瓜 去宠物医院 学会开门 霸占键盘"] },
  { name: "代码夜读", topic: "科技", titles: ["一个 bug 查了三天，最后是时区", "两百行写一个待办应用", "程序员的桌面整理", "AI 写代码靠不靠谱，实测一周", "新手最容易踩的五个 Git 坑"], series: ["{x}，一期讲明白", "正则表达式 浮点数误差 HTTP缓存 数据库索引 闭包 递归 时间复杂度 内存泄漏 跨域 容器"] },
  { name: "晚风读书", topic: "读书", titles: ["这本书我读了三遍", "一年读完 50 本书的方法", "适合睡前读的五本短篇", "把读书笔记做成卡片", "我为什么重读《活着》"], series: ["读《{x}》", "平凡的世界 百年孤独 围城 边城 人间词话 小王子 月亮与六便士 瓦尔登湖 呼兰河传 城南旧事"] },
  { name: "跑者阿杰", topic: "运动", titles: ["从跑不动一公里到半马", "跑步膝盖疼，先检查这三处", "下雨天在家练核心", "第一次跑全马的真实感受", "跑鞋怎么选，不用看广告"], series: ["跑步{x}", "配速怎么定 怎么呼吸 后拉伸十分钟 冬天穿什么 间歇跑入门 长距离补给 后怎么放松 姿势纠正 选早上还是晚上 能不能减脂"] },
  { name: "画画的小满", topic: "绘画", titles: ["十分钟画一张窗边的光", "水彩新手第一张晚霞", "用一支笔画完整条老街", "板绘线稿怎么画得干净", "给朋友的猫画了张肖像"], series: ["画{x}", "一杯咖啡 雨后街道 窗台绿植 夕阳海面 老房子 樱花 夜晚的灯 朋友的狗 一碗面 山间小路"] },
  { name: "老城记忆", topic: "人文", titles: ["这条巷子要拆了，去拍最后一次", "老师傅修了四十年自行车", "八十年代的照相馆", "胡同早点铺开了三十年", "老电影院的放映员"], series: ["老城里的{x}", "修鞋匠 裁缝铺 剃头师傅 糖画摊 爆米花 茶馆 铁匠铺 邮筒 公共澡堂 露天电影"] },
  { name: "收纳研究所", topic: "生活", titles: ["十平米出租屋改造", "衣柜这样收能多放一倍", "厨房台面清空之后", "搬家打包的顺序很重要", "断舍离一个月的变化"], series: ["{x}收纳", "玄关 冰箱 书桌 卫生间 床底 鞋柜 衣帽间 阳台 抽屉 行李箱"] },
  { name: "吉他手阿远", topic: "音乐", titles: ["零基础三个和弦弹一首歌", "地铁站里弹了半小时", "这段前奏练了一个月", "给老歌编了个新和声", "指弹入门先练这个节奏"], series: ["吉他{x}", "扫弦节奏 横按和弦 换和弦不卡顿 指弹入门曲 调音 拨片怎么握 变调夹 即兴伴奏 练耳 节拍器"] },
  { name: "种菜的阿婆", topic: "三农", titles: ["阳台种番茄，三个月的变化", "今年的第一茬韭菜", "院子里的柿子熟了", "腌一坛酸豆角", "下雨前抢收花生"], series: ["种{x}", "小葱 生菜 辣椒 黄瓜 草莓 豆角 茄子 南瓜 香菜 土豆"] },
];
const CREATORS = CREATOR_SOURCE.map(({ series: [pattern, subjects], ...creator }) => ({
  ...creator, titles: [...creator.titles, ...subjects.split(" ").map((subject) => pattern.replace("{x}", subject))],
}));

// 长尾：几百个只刷到过一两次的作者，标题由固定句子加「什么时候 + 做了什么」拼出来，列表里少撞名
const TAIL_NAMES = ["山野", "南风", "橘子", "日常", "一只", "北方", "慢慢", "阿北", "半夏", "小鹿", "青柠", "月亮", "白桃", "阿七", "星河", "小周", "木子", "西瓜", "大海", "晴天", "阿花", "栗子", "豆豆", "夏天"];
const TAIL_SUFFIX = ["的日记", "研究所", "vlog", "说", "在吗", "笔记", "小屋", "频道", "的生活", "爱吃饭", "不加班", "去旅行", "的一天", "同学", "酱", "本人"];
const TAIL_WHEN = ["周末", "下班后", "第一次", "一个人", "和朋友", "凌晨", "雨天", "冬天", "回老家时", "出差时"];
const TAIL_WHAT = ["去了趟菜市场", "做了顿家常饭", "在河边散步", "拍到了晚霞", "整理了房间", "逛了旧书店", "学做蛋糕", "骑车去郊外", "看了场老电影", "收拾阳台", "去爬了山", "给家里修水管", "逛宜家", "包了顿饺子", "去海边", "学滑板", "种了盆薄荷", "跑了五公里", "去看演唱会", "做了手账"];
const TAIL_TOPICS = ["生活", "日常", "搞笑", "情感", "生活", "日常", "美食", "旅行", "萌宠", "运动", "音乐", "知识"];
const TAIL_TITLES = ["今天也是普通的一天", "随手拍的晚霞", "这个方法真的有用", "第一次尝试，翻车了", "周末去了一趟郊外", "给自己做顿好的", "看完这个我沉默了", "终于等到这一天", "下班路上的风", "和室友的日常",
  "公司楼下的流浪猫", "二十块钱逛一天夜市", "我妈第一次用智能手机", "租房三年攒下的小物", "地铁上看到的一幕", "考研失败之后的一年", "用旧窗帘改了个包", "南方人第一次见暖气", "爷爷的老收音机修好了", "周一早上的通勤",
  "把阳台改成小书房", "一个人吃火锅也很好", "毕业五年的同学聚会", "楼下早餐摊的阿姨", "学会游泳的第三十天", "这首歌循环了一整天", "雨天窝在家拼乐高", "给狗子洗澡的全过程", "第一次自己换灯泡", "凌晨三点的便利店"];
const LIVE_TITLES = ["深夜食堂开播，边做边聊", "周末徒步直播，带你上山", "陪你画一小时", "弹唱点歌，聊聊天", "阳台种菜答疑"];

const FRIENDS = [
  { id: "demo-c1", name: "小雨", color: "#e11d48", activeMinutes: 4 },
  { id: "demo-c2", name: "老王", color: "#0369a1", activeMinutes: null },
  { id: "demo-c3", name: "阿明", color: "#15803d", activeMinutes: 320 },
  { id: "demo-c4", name: "妈妈", color: "#b45309", activeMinutes: 95 },
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
  const tailTitle = () => (rnd() < 0.3 ? pick(TAIL_TITLES) : `${pick(TAIL_WHEN)}${pick(TAIL_WHAT)}`);
  const covers = new Map<string, string>();
  const coverOf = (title: string, topic: string, author: string) => {
    const key = `${author}/${title}`;
    if (!covers.has(key)) covers.set(key, cover(title, topic, covers.size));
    return covers.get(key)!;
  };
  // 同一作者同一标题就是同一条视频：再刷到算重看，编号、封面、时长都不变
  const made = new Map<string, ReturnType<typeof makeVideo>>();
  const video = (author: string, topic: string, title: string, live = false) => {
    const key = `${author}/${title}`;
    if (!made.has(key)) made.set(key, makeVideo(made.size, author, topic, title, live));
    return made.get(key)!;
  };
  function makeVideo(index: number, author: string, topic: string, title: string, live: boolean) {
    const duration = live ? 600 + Math.floor(rnd() * 3000) : rnd() < 0.5 ? 15 + Math.floor(rnd() * 50) : rnd() < 0.8 ? 90 + Math.floor(rnd() * 400) : 600 + Math.floor(rnd() * 1200);
    return {
      videoId: `demo${100000 + index}`,
      title,
      author,
      authorId: `demo-${author}`,
      authorAvatarUrl: avatar(author, TOPIC_COLORS[topic]?.[1] ?? "#334155"),
      url: null,
      coverUrl: coverOf(title, live ? "直播" : topic, author),
      mediaType: live ? "live" : rnd() < 0.85 ? "video" : "image",
      durationSeconds: duration,
      topics: [live ? "直播" : topic],
      ...(live ? {} : {
        music: { id: `demo-music-${author}`, title: `@${author}创作的原声`, author },
        stats: { diggCount: Math.floor(rnd() * 200000), commentCount: Math.floor(rnd() * 8000), collectCount: Math.floor(rnd() * 30000), shareCount: Math.floor(rnd() * 9000) },
      }),
    };
  }

  type Watched = ReturnType<typeof makeVideo> & { id: string; occurredAt: string; occurredAtSource: string; publishedAt?: string; watchProgress: { watchedSeconds: number; percent: number } | null };
  const watch: Watched[] = [];
  for (let i = 0; i < 1800; i++) {
    // 越近看得越多；三成多是常看的那十几位博主
    const daysAgo = Math.floor(Math.pow(rnd(), 1.4) * 320);
    const creator = rnd() < 0.35 ? CREATORS[Math.floor(Math.pow(rnd(), 1.3) * CREATORS.length)]! : null;
    const base = creator ? video(creator.name, creator.topic, pick(creator.titles)) : video(pick(tail), pick(TAIL_TOPICS), tailTitle());
    const occurredAt = at(daysAgo);
    const percent = rnd() < 0.35 ? 100 : Math.round(20 + rnd() * 75);
    watch.push({
      ...base,
      id: `demo-w${i}`,
      occurredAt: new Date(occurredAt).toISOString(),
      occurredAtSource: "platform_action",
      publishedAt: new Date(occurredAt - Math.floor(rnd() * 20) * DAY - 3_600_000).toISOString(),
      watchProgress: { watchedSeconds: Math.round(base.durationSeconds * percent / 100), percent },
    });
  }
  // 看过的直播：在观看历史里，内容库单独一栏
  for (let i = 0; i < 36; i++) {
    const creator = CREATORS[i % 5 === 0 ? 0 : (i % 4) * 3 + 1]!;
    const base = video(creator.name, creator.topic, pick(LIVE_TITLES), true);
    watch.push({ ...base, id: `demo-live${i}`, occurredAt: new Date(at(Math.floor(rnd() * 120))).toISOString(), occurredAtSource: "platform_action", watchProgress: null });
  }
  // 采集器给的记录新的在前
  watch.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  const videos = watch.filter((record) => record.mediaType !== "live");
  // 喜欢、收藏同一条视频只算一次
  const once = (step: number, offset: number) => {
    const seen = new Set<string>();
    return videos.filter((record, i) => i % step === offset && !seen.has(record.videoId) && seen.add(record.videoId));
  };
  const liked = once(4, 1).slice(0, 360).map((record, i) => ({ ...record, id: `demo-l${i}` }));
  const favorite = once(11, 3).slice(0, 120).map((record, i) => ({ ...record, id: `demo-f${i}` }));

  const conversations = FRIENDS.map((friend) => ({
    id: friend.id, kind: "friend", name: friend.name, avatarUrl: avatar(friend.name, friend.color),
    lastActiveAt: friend.activeMinutes === null ? null : new Date(now - friend.activeMinutes * 60_000).toISOString(),
    messageCount: 0, ownMessageCount: 0,
  }));
  type Conversation = (typeof conversations)[number];
  const messages: Array<Record<string, unknown> & { sentAt: string }> = [];
  const say = (conversation: Conversation, own: boolean, sentAt: number) => {
    const roll = rnd();
    const type = roll < 0.8 ? "text" : roll < 0.95 ? "share" : "call";
    const shared = type === "share" ? pick(videos) : null;
    conversation.messageCount++;
    if (own) conversation.ownMessageCount++;
    messages.push({
      id: `demo-m${messages.length}`,
      conversationId: conversation.id,
      conversationType: "friend",
      conversationName: conversation.name,
      senderId: own ? "demo-me" : `${conversation.id}-peer`,
      senderName: own ? "我" : conversation.name,
      senderAvatarUrl: own ? ACCOUNT_AVATAR : conversation.avatarUrl,
      sentAt: new Date(sentAt).toISOString(),
      type,
      text: type === "text" ? pick(LINES) : null,
      mediaUrl: null,
      share: shared ? { title: shared.title, author: shared.author, coverUrl: shared.coverUrl, url: null } : null,
      callDurationSeconds: type === "call" ? 60 + Math.floor(rnd() * 900) : null,
    });
  };
  for (let i = 0; i < 1300; i++) say(conversations[Math.floor(Math.pow(rnd(), 1.6) * conversations.length)]!, rnd() < 0.5, at(Math.floor(Math.pow(rnd(), 1.2) * 300)));
  // 火花：小雨、妈妈最近天天互发，老王今天还没聊；火花看板按本机记录算出连续天数
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  for (const [id, days, today] of [["demo-c1", 46, true], ["demo-c4", 23, true], ["demo-c2", 9, false]] as const) {
    const conversation = conversations.find((item) => item.id === id)!;
    for (let day = today ? 0 : 1; day < days; day++) {
      for (const own of [true, false]) say(conversation, own, day ? at(day) : Math.max(midnight + 60_000, now - (own ? 50 : 20) * 60_000));
    }
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
    account: { id: "default", uid: null, nickname: "示例账号", avatar: ACCOUNT_AVATAR },
    browserSource: { mode: "independent", browser: null, connected: true, credentials: "ready" },
  };
}

const ACCOUNTS = { activeId: "default", accounts: [{ id: "default", nickname: "示例账号", avatar: ACCOUNT_AVATAR, uid: null, createdAt: SAMPLE_AT.toISOString() }] };
const ASSISTANT = { revision: 1, busy: false, messages: [], streaming: null, error: null, confirms: [], ui: null };

// 内容库收藏栏、喜欢栏的文件夹，按主题分；在页面里整理后存在内存里，刷新回到这份
const FOLDER_TOPICS: Record<string, Record<string, string>> = {
  favorite_videos: { 美食: "想做的菜", 三农: "想做的菜", 旅行: "旅行清单", 知识: "涨知识", 科技: "涨知识", 读书: "涨知识", 生活: "生活小技巧" },
  liked_videos: { 萌宠: "治愈", 音乐: "治愈", 绘画: "治愈" },
};
let folderState: { lists: unknown; revision: string } | null = null;
function folders() {
  if (folderState) return folderState;
  const { records } = demoSnapshot();
  const lists: Record<string, { folders: Array<{ id: string; name: string }>; items: Record<string, string> }> = { watch_history: { folders: [], items: {} } };
  for (const [type, topics] of Object.entries(FOLDER_TOPICS)) {
    const names = [...new Set(Object.values(topics))];
    const list = { folders: names.map((name, index) => ({ id: `demo${type[0]}${index}`, name })), items: {} as Record<string, string> };
    for (const record of records[type as "liked_videos" | "favorite_videos"]) {
      const name = topics[record.topics[0]!];
      if (name) list.items[record.videoId] = list.folders.find((folder) => folder.name === name)!.id;
    }
    lists[type] = list;
  }
  return (folderState = { lists, revision: "demo-1" });
}

const COMMENT_LINES = ["收藏了，周末就试试", "讲得太清楚了，终于懂了", "这个角度拍得真好", "已经跟着做了三次", "求出续集！", "看哭了，想起我外婆", "第一次刷到，已关注"];
const REPLY_LINES = ["谢谢支持，下期安排", "做出来记得来反馈哈", "哈哈哈同感", "我也是这么想的", "感谢喜欢～"];
function myComments() {
  const rnd = makeRandom(3);
  const seen = new Set<string>();
  const heads = new Set(CREATORS.map((creator) => creator.name));
  const picks = demoSnapshot().records.watch_history.filter((record) => record.mediaType === "video" && heads.has(record.author) && !seen.has(record.videoId) && seen.add(record.videoId)).slice(0, 10);
  return picks.map((record, index) => {
    const time = new Date(record.occurredAt).getTime() + 120_000;
    const replies = Array.from({ length: index % 3 }, (_, n) => ({
      id: `demo-r${index}-${n}`,
      at: new Date(time + (n + 1) * 3_600_000).toISOString(),
      text: REPLY_LINES[(index + n) % REPLY_LINES.length]!,
      user: n === 0 ? { id: record.authorId, name: record.author, avatarUrl: record.authorAvatarUrl } : { id: `demo-u${index}`, name: FRIENDS[index % 4]!.name, avatarUrl: null },
      label: n === 0 ? "作者" : "朋友",
    }));
    return {
      id: `demo-cm${index}`, videoId: record.videoId, text: COMMENT_LINES[index % COMMENT_LINES.length]!, at: new Date(time).toISOString(),
      likes: Math.floor(rnd() * 300), video: { title: record.title, author: record.author, coverUrl: record.coverUrl }, source: "notice", replies,
    };
  });
}

// 推荐流控制：挡掉的视频、处置记录和设置（设置页改了存在内存里）
const BLOCKED = [
  { title: "震惊！99% 的人都不知道的秘密", matched: ["震惊"], action: "hidden" },
  { title: "限时秒杀，最后三小时", matched: ["秒杀"], action: "disliked" },
  { title: "看完这个视频你会感谢我", matched: ["标题党"], action: "hidden" },
  { title: "月入十万的副业，人人都能做", matched: ["副业"], action: "disliked" },
  { title: "震惊！这个东西居然能吃", matched: ["震惊"], action: "observed" },
  { title: "直播间秒杀福利，错过等一年", matched: ["秒杀"], action: "hidden" },
];
let feedSettings = { rules: "震惊\n秒杀\n标题党\n副业", mode: "hide", words: "家常菜\n徒步\n手冲咖啡", webPicks: true, pickEvery: 3, extension: { lastSeenAt: SAMPLE_AT.getTime() - 3_600_000, removing: false } };
function blockedVideos() {
  return Array.from({ length: 18 }, (_, i) => {
    const item = BLOCKED[i % BLOCKED.length]!;
    const author = `${TAIL_NAMES[(i * 5) % TAIL_NAMES.length]}好物`;
    const occurredAt = SAMPLE_AT.getTime() - (i * 9 + 1) * 3_600_000;
    return {
      id: `demo-ff${i}`, videoId: `demo${900000 + i}`, title: item.title, author, url: null, occurredAt: new Date(occurredAt).toISOString(),
      coverUrl: cover(item.title, "推荐", i), mediaType: "video", durationSeconds: 30 + i * 7, feedFilter: { action: item.action, matched: item.matched },
    };
  });
}
function feedEvents() {
  const blocked = blockedVideos().map((video) => ({ t: new Date(video.occurredAt).getTime(), id: video.videoId, desc: video.title, author: video.author, matched: video.feedFilter.matched, action: video.feedFilter.action }));
  const inserted = ["家常菜", "徒步", "手冲咖啡"].map((word, i) => ({ t: SAMPLE_AT.getTime() - (i * 13 + 2) * 3_600_000, id: `demo${910000 + i}`, desc: `${word}｜周末在家试了试`, author: "慢慢的日记", matched: [word], action: "inserted" }));
  return [...blocked, ...inserted].sort((a, b) => a.t - b.t);
}

// 使用记录：最近一周在软件里和浏览器里刷抖音的时段
function usage() {
  const rnd = makeRandom(7);
  const now = SAMPLE_AT.getTime();
  const sessions = [];
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  for (let day = 0; day < 7; day++) {
    // 早上通勤、午休、晚上睡前各刷一会儿
    for (const [n, hour] of [8, 12, 20, 22].entries()) {
      if (rnd() < 0.3) continue;
      const startedAt = midnight - day * DAY + (hour + rnd()) * 3_600_000;
      if (startedAt > now - 600_000) continue;
      const durationMs = Math.min(Math.floor((4 + rnd() * 50) * 60_000), now - startedAt - 60_000);
      sessions.push({ id: `demo-s${day}-${n}`, source: rnd() < 0.6 ? "app" : "chrome", startedAt, lastSeenAt: startedAt + durationMs, endedAt: startedAt + durationMs, durationMs, startKind: "opened", endReason: "closed" });
    }
  }
  sessions.sort((a, b) => b.startedAt - a.startedAt);
  const today = sessions.filter((session) => session.startedAt >= midnight);
  const bySource = { app: 0, chrome: 0, edge: 0, comet: 0 };
  for (const session of today) bySource[session.source as "app" | "chrome"] += session.durationMs;
  return {
    sessions, total: sessions.length, offset: 0, hasMore: false, updatedAt: now, error: null, activeSources: [],
    browser: { state: "idle", browser: null, label: null, tabs: 0, error: null },
    today: { durationMs: today.reduce((sum, session) => sum + session.durationMs, 0), count: today.length, bySource },
  };
}

// 读取、收聊天：记录已经「读完」，直接回读完的状态
const SYNC_PATHS = ["/v1/sync", "/v1/sync/stop", "/v1/experimental/records-direct", "/v1/chat/observe", "/v1/chat/observe/stop"];

// 读取、下载、登录这些要真连抖音的操作一律回这句。借用 collector_busy：requestJson 对它会原样显示 message
// ponytail: 只按路径分流；以后哪个页面要更像样的演示数据，在 answer 里加一条路径
const UNAVAILABLE = { error: "collector_busy", message: "在线体验版不连抖音，这个操作要下载桌面版才能用。" };

function answer(method: string, path: string, query: URLSearchParams, body: unknown): unknown {
  if (path === "/v1/creator/read" && method === "POST") return answerCreatorRead(body);
  if (path === "/v1/health") return { ok: true, version: 1 };
  if (path === "/v1/pairing-code") return { code: "20261113" };
  if (path === "/v1/pair") return { token: "demo".repeat(10) };
  if (path === "/v1/status") return status();
  if (method === "POST" && SYNC_PATHS.includes(path)) return { status: status() };
  if (path === "/v1/folders") {
    if (method === "POST") folderState = { lists: (body as { lists?: unknown } | null)?.lists ?? folders().lists, revision: `demo-${Date.now()}` };
    return method === "POST" ? { revision: folders().revision } : folders();
  }
  if (path === "/v1/feed-filter") {
    if (method === "POST" && body && typeof body === "object") feedSettings = { ...feedSettings, ...body };
    return feedSettings;
  }
  if (method !== "GET") return null;
  if (path === "/v1/accounts") return ACCOUNTS;
  if (path === "/v1/assistant") return ASSISTANT;
  if (path === "/v1/my-comments") return { comments: myComments() };
  if (path === "/v1/feed-filter/videos") return { videos: blockedVideos() };
  if (path === "/v1/feed-filter/events") return { events: feedEvents() };
  if (path === "/v1/usage/sessions") return usage();
  if (path === "/v1/usage/settings") return { settings: { enabled: false, browser: "chrome" } };
  if (path === "/v1/settings/writes") return { enabled: false };
  if (path === "/v1/live/following") return { rooms: [] };
  if (path === "/v1/video-analysis/batch") return { batch: null };
  if (path === "/v1/video-analysis/notes") return { notes: [] };
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
    // 状态、AI 助手的长轮询：和真采集器一样没有新进展就挂 8 秒再回当前状态
    if (url.searchParams.has("afterRevision")) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 8_000);
        init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); });
      });
    }
    let sent: unknown = null;
    try { sent = typeof init?.body === "string" ? JSON.parse(init.body) : null; } catch { /* 不是 JSON 就当没带 */ }
    const reply = answer(method, url.pathname, url.searchParams, sent);
    if (reply === null) console.info("[demo] 没有演示数据：", method, url.pathname);
    return new Response(JSON.stringify(reply ?? UNAVAILABLE), {
      status: reply === null ? 503 : 200,
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
