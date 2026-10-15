# 内容年志 · 用深层词条数据填补现有页面（v2）

写于 2026-09-05，交给新会话（Opus 5）实施。仓库 `/Users/a0000/Desktop/dy 2`，分支 `codex/content-story-video-download`，页面 `prototype/story-draft_副本.html`。动手前先读 `MEMORY.md` 里的 `dy2-story-lexicon-plan`、`dy2-mix-chapter-bento`、`dy2-kept-chapter-stagger`、`dy2-story-scroll-snap`、`dy2-story-roll-page`（"别自创节奏"的教训）、`dy2-no-raw-field-names`；方案与真实代码冲突时以代码为准。

## 0. 结论

- 用户诉求（两轮）：① 现在的内容类型停留在表面，要更深一层——聊天高频词、分享视频高频词条、点赞视频高频词条、覆盖率；② **不是新增页面，而是填补已有页面，现在页面的空间利用率不高。**
- 实测（真实快照渲染，见 §1）：01 样本、02 时间、05 回声、06 证据、07 签名五章内容只占屏幕 11–27%，03/04 章约 40%。所以新数据全部填进 **01、05、06** 三章，03/04 不动（已经满，1440×760 下 fit 只有 0.78），02/07 与本次数据无关、只在 §5 列可选项。
- 分配：**01「一份样本，四种笔迹」** 放四条数据流各自的高频词条与集中度（点赞视频词条在这里，和观看/收藏/聊天并排可比）；**05「回声」** 放聊天高频词、分享视频词条、"分享的 vs 点赞的"对照；**06「台账与边界」** 放字段覆盖率台账。全部复用页面现成组件（`.stream-row`、`.mini-lines .ml`、`.board`、`.cell-foot`、`.note`），不新建章节、不新造视觉语言。
- 「词条」= 显式话题标签（`#xxx`），不是分词；只有聊天没有标签才分词（`Intl.Segmenter`，零依赖）。真实数据校准过：分词把四字游戏名切成两个词、把平台词切成单字，标签才可读。
- 覆盖率三层：① 词表覆盖率 = 前 12 个词条覆盖该来源多少条；② `halfAt` = 覆盖一半条目需要多少个词条（集中度）；③ 字段覆盖率 = 各字段有值的条数占比（06 章台账）。
- 数据全部在 `src/services/storyData.ts` 算好写进快照，页面只注水。不改档案馆、不加分词依赖、不拆分享方向（见 §5）。

## 1. 实测基线（2026-09-05，真实快照，无头 Chrome）

| 章 | 1440×900 内容盒 | 内容占屏 1440×900 / 2000×1040 | 说明 |
|---|---|---|---|
| 01 sample | 1200×509 | 20% / 14% | 左栏下方 1/3 空，板子下方整条空 |
| 02 time | 1200×470 | 17% / 11% | 本次不动（可选见 §5） |
| 03 kept | 1075×763 | 40% / 34% | 已满，不动 |
| 04 mix | 1130×763 | 40% / 29% | 已满，不动 |
| 05 echo | 1200×624 | 27% / 17% | 左栏分享卡下方空，右板行距松 |
| 06 evidence | 1200×510 | 14–27% | 右栏只有一段话和一个按钮 |
| 07 signature | 1200×571 | 15–30% | 结尾页，不动 |

- `.chapter-inner` 的 `max-width: 1200px`，2000 宽视口两侧各空 400px；03 章已用 `#kept .chapter-inner { max-width: 1400px }`，01/05/06 同样放宽到 1400。
- 纵向预算（`.chapter` 上下 padding 之外、`--fit` 开始缩小前）：1440×900 ≈ 765px，1440×760 ≈ 636px，2000×1040 ≈ 884px。改完三章内容盒高度控制在 ≤ 640px，1440×760 下 fit ≥ 0.95。
- 真实数据量级（只记数量）：好友消息 733 = 文字 333 / 分享卡 317 / 表情 80；文字里 28 条是平台模板（"我们已互相关注，可以开始聊天了"一类，同文案出现在 ≥3 个会话且 senderId 正常）；分享卡 278 张带标签、752 个不同标签；点赞 1300 条 1121 带标签、2389 个标签、前 12 覆盖 18%、halfAt 90；观看 1593 条前 12 覆盖 31%、halfAt 34；收藏 110 条前 12 覆盖 33%；点赞与分享 top30 只重合 5 个标签。
- 量法（可重写）：playwright-core + `~/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing` + `--use-angle=swiftshader`，`addInitScript` 把快照写进 `localStorage["content-insights.story"]`，`file://` 打开原型 `?sky=1`，逐章 `scrollIntoView`、等 `[data-reveal]` 全部 `.in` 且 `[data-count]` 计数到位，再把每个"叶子盒"（有直接文本节点的元素 + `.track/.fill/.card-cover/.ava/.sc/svg/img`）栅格化到 24px 网格算占比。真实快照的拿法：临时写一个 vitest 文件（mock 列表照抄 `storyData.test.ts` 开头，**不能用 Proxy 工厂**），读 `.local-data/records.json` → `buildReportModel` → `buildStoryData` → 写到 scratchpad，跑完删掉，不能提交。

## 2. 数据层 `src/services/storyData.ts`

### 2.1 类型（`version` 仍为 1；页面对缺字段的旧快照走无数据分支）

```ts
export interface StoryTerm { name: string; count: number; share: number }   // count = 含该词的条数（每条只计一次）；share = count / sampled
export interface StoryTermField {
  total: number;          // 该来源的条数
  sampled: number;        // 至少有一个可用词条的条数
  distinct: number;       // 不同词条数
  top: StoryTerm[];       // 前 12（页面按需 slice）
  coverage: number;       // sampled 里含 top 任一词条的占比
  halfAt: number | null;  // 按频次顺序累加，覆盖 sampled 一半需要的词条数；sampled 为 0 时 null
  excluded: number;       // 被剔除的条数（聊天 = 平台模板条数；标签来源恒为 0）
}
export interface StoryLexicon {
  watch: StoryTermField;                   // 观看历史的话题标签
  liked: StoryTermField;                   // 点赞的话题标签
  favorite: StoryTermField;                // 收藏的话题标签
  chat: StoryTermField | null;             // 好友文字消息分词；archive 来源或环境没有 Intl.Segmenter 时为 null
  shared: StoryTermField | null;           // 好友分享卡标题里的话题标签；archive 来源为 null
  contrast: { both: string[]; sharedOnly: string[]; likedOnly: string[] } | null;  // shared 为 null 或任一方 sampled < 10 时为 null
}
export interface StoryFieldCoverage { label: string; count: number; base: number; share: number }
// StoryData 新增：lexicon: StoryLexicon; fields: StoryFieldCoverage[];
```

### 2.2 算法

- **标签提取** `termsOf(topics, title)`：`record.topics ?? []` ∪ 标题里的 `#标签`，正则与 `src/domain/annualReport.ts` 的 `normalizeTopics` 相同：`/#([^#\s,，。.!！?？:：;；]{1,50})/gu`；去首部 `#`、trim；key 用 `toLowerCase()` 合并（真实数据里 `#ai` 与 `#AI` 分开计过），显示首次出现的写法；每条去重。
- **词表** `termField(items: string[][]): StoryTermField`：按条计频（doc frequency），`count desc, name localeCompare zh-CN`，取前 12；`coverage` = sampled 中含前 12 任一词的条数 / sampled；`halfAt` = 沿排序逐个加入词条、第一次让"含已选词条的条数 ≥ sampled/2"时的个数（O(K·n) 直接算）。
- **watch / liked / favorite**：三份清单各自 `termsOf`。
- **shared**：好友消息（群聊剔除逻辑照抄 `chatSummary` 的 `groupIds` 判断）里 `hasChatShareEvidence(message.share)` 为真的分享卡（`src/domain/chatRecords.ts` 已导出），对 `share.title` 跑同一正则；`total` = 分享卡数。
- **chat**：好友消息里 `type === "text"` 且有 `text`：
  1. 平台模板剔除：`norm = text.replace(/\d+/gu, "#").replace(/\s+/gu, "").slice(0, 40)`，同一 `norm` 出现在 ≥3 个不同 `conversationId` 就整组剔除，计入 `excluded`。
  2. 清洗：去 URL、`[捂脸]` 这类 `[…]`（≤8 字）表情标记、`@昵称`、`#标签`。
  3. `new Intl.Segmenter("zh", { granularity: "word" })`，只留 `isWordLike`；连续的单字 CJK 片段粘成一个词；保留 CJK ≥2 字且不是同一字重复（哈哈哈）、拉丁 ≥2 字（key 小写）；剔停用词；每条去重。
  4. 停用词内联一个常量（约 150 个）：`的 了 是 我 你 他 她 它 我们 你们 他们 这 那 这个 那个 这些 那些 在 有 和 与 及 或 就 都 也 还 又 很 太 更 最 不 没 没有 要 会 能 可以 可能 应该 把 被 让 给 对 从 到 向 于 为 以 用 跟 比 吧 吗 呢 啊 哦 呀 嗯 哈 哈哈 哈哈哈 嘿 哎 唉 呃 哇 噢 嗯嗯 好 好的 好了 行 可 而 但 但是 因为 所以 如果 然后 还是 或者 什么 怎么 怎样 为什么 哪 哪里 谁 多少 几 一个 一下 一些 一点 一起 一样 已经 现在 今天 明天 昨天 时候 一直 只是 就是 不是 而且 这样 那样 这么 那么 自己 大家 我的 你的 他的 视频 抖音 分享 看看 来看 一定 真的 感觉 觉得 知道 看到 看了 有点 不要 不能 不会 直接 出来 起来 过来 回来 下来 上来 出去 进去 才 再 只 每 各 另 某 其 之 者 所 着 过 得 地 啦 嘛 咯 哟 呗 喔 嘞 还有 非常 我要 你要 我看 我有 都没 不了 不知道 也是 都是 我是 给我 其实 结果 本来 时间`——可按测试结果增删，别引入词库依赖。
  5. 守卫：`typeof Intl === "undefined" || typeof (Intl as any).Segmenter !== "function"` → `chat = null`（一行）。
- **contrast**：liked 与 shared 各取 top30（按 key）；`both` = 交集（按 liked 名次排）；`likedOnly` = liked top30 减去 shared top100；`sharedOnly` = shared top30 减去 liked top100；每组最多 4 个（05 章只有两行的位置）。任一方 `sampled < 10` → null。
- **fields**（字段覆盖率，06 章台账；base = 观看+点赞+收藏全部条数，已看进度只用观看条数）：`行为时间`（`validTime(occurredAt)` 且来源不是 unknown，等于 reliableRatio）、`作品 ID`（videoId）、`话题标签`（termsOf 非空）、`时长`（durationSeconds 有限且 ≥0）、`发布时间`（publishedAt 有效）、`点赞数`（stats.diggCount 有限）、`已看进度`（watchProgress 的 percent 或 watchedSeconds 有值 / 观看条数）。七行，按这个顺序。
- `noUncheckedIndexedAccess` 开着：数组下标要 `?? 0` 或先取变量再判空。

### 2.3 测试 `src/services/storyData.test.ts`

在现有 fixture 上扩：点赞记录加 `topics`（含重复与大小写不同的拉丁标签）；聊天加 3 个会话各一条同文案模板（数字不同）、一条带 URL + `[捂脸]` + 正常句子的文字、一条群聊文字（必须不计入）、两张标题带 `#标签` 的分享卡、一条无证据的伪分享（不计入）。断言：`lexicon.liked.top` 顺序与 count、`coverage`/`halfAt` 手算值、`chat.excluded === 3`、群聊不泄漏、`shared.total === 2`、`contrast` 三组、`fields` 七行的 count/base、`source: "archive"` 时 `shared`/`chat` 为 null、`vi.stubGlobal` 去掉 `Intl.Segmenter` 时 `chat` 为 null。一个 `describe`，不加新框架。

## 3. 页面层 `prototype/story-draft_副本.html`（只动 01、05、06 三章）

统一约束：复用现成组件；每章只有一个错位节拍（03/04 的 `--beat: 36px`），别做镜像/翻转；用户可见文案不出现字段名（`halfAt`、`sampled`），mono 小标只放英文设计词；无快照时所有新槽位都有中性示例数字（`#示例话题一` 这类）；旧快照缺 `lexicon`/`fields` 时新块整体隐藏且无报错。

### 3.1 01 THE SAMPLE「一份样本，四种笔迹」→ 四种笔迹各自的词条与集中度

- **板子（FOUR STREAMS）每行加一条词条线**：`.stream-row` 改成两行网格（`grid-template-columns: 120px 1fr 52px; grid-template-rows: auto auto`），在 `.track` 下面加 `<div class="stream-terms" data-slot="terms-watch">`（`grid-column: 2 / -1`），内容 = 前 3 个词条芯片（`<i>#高达模型</i>` 样式：`font: 10px var(--mono); color: var(--charcoal); background: var(--linen); border-radius: 4px; padding: 2px 6px`）+ `<small>` "前 12 个覆盖 31% · 覆盖一半要 34 个"。四行槽位 `terms-watch / terms-liked / terms-favorite / terms-chat`；聊天行放分词结果（不带 `#`），`chat` 为 null 时写 "备用文件不含聊天 / 当前环境不支持分词"；某来源 `sampled === 0` 时写 "记录里没有话题标签"。行内 padding 由 13px 降到 11px 控制板高。
- **左栏 `.metrics` 下面加集中度块**：`<div class="mini-lines" data-slot="concentration">` 四行 `.ml`（看过 / 喜欢 / 收藏 / 聊天 | 条 | `34 个`），条宽 = 该来源 halfAt / 四者最大 halfAt（越短越集中），`.ml` 标签列在这里要放宽到 `72px`；下面一句 `p.note[data-slot="concentration-note"]`，按 liked 与 watch 的 halfAt 比值三选一："覆盖一半的点赞要 90 个词条，观看只要 34 个——留下的比看过的更分散" / "……更集中" / "……差不多"。这就是用户要的"覆盖率"可视化。
- `#sample .chapter-inner { max-width: 1400px }`；`.cols` 仍 `align-items: center`。预期内容盒 509 → ≈ 640px。

### 3.2 05 THE ECHO「回声」→ 三栏：文案 · 消息形态 · 词表

- `#echo .chapter-inner { max-width: 1400px }`；`#echo .cols { grid-template-columns: .95fr 1.05fr 1fr; gap: 40px; align-items: start }`，第三栏新加 `<div class="board words" data-reveal style="--i:3">`；≤1000 两栏、≤880 单栏由现有 `.cols` 断点覆盖（确认一下 1000 断点处新栏落到第二行不重叠）。
- 第三栏内容（自上而下）：`.board-head`「WORDS · 说出口的，转发出去的」→ 小标 `CHAT · 聊天高频词` → `.mini-lines[data-slot="chat-words"]` 前 6 行（词 | 条 | 次数；`.words .ml { grid-template-columns: 96px 1fr 38px }`，标签 `text-overflow: ellipsis`）→ `.cell-foot[data-slot="chat-words-foot"]` "333 条文字消息 · 去掉 28 条平台模板 · 前 12 个词覆盖 x%"（`excluded` 为 0 时省略中段）→ 小标 `SHARED · 分享视频词条` → `.mini-lines[data-slot="share-terms"]` 前 6 行 → `.cell-foot[data-slot="share-terms-foot"]` "317 张分享卡 · 278 张带话题 · 前 12 个覆盖 x%" → `.board-foot[data-slot="contrast"]` 两行芯片："只在分享里 #a #b #c #d" / "只在点赞里 #x #y #z #w"（`contrast` 为 null 时隐藏这块）。
- 第一栏（文案 + 三个指标 + 分享卡样例）和第二栏（MESSAGE FORMS + 三个会话）保留；第二栏与第三栏都 `margin-top: var(--beat)` 之外只让**第三栏**下沉一拍（V 形，和 03 一致），不要两栏都沉。
- 预期内容盒 624 → ≈ 640px（第三栏 ≈ 480px 是最高的一栏）。

### 3.3 06 HOW WE KNOW「台账与边界」→ 字段覆盖率台账

- 右栏 `.note` 之后加：小标 `FIELD COVERAGE · 每个字段有多少条记录填了` + `<div class="mini-lines fields" data-slot="fields">` 七行 `.ml`（`.fields .ml { grid-template-columns: 110px 1fr 44px }`：标签 | 条 | `86%`），行末 `<small>` 写 "1,121 / 1,300"（放在 b 里换行或第四列，二选一，别挤）。行顺序照 §2.2 fields。
- `#caveat` 文案末尾追加："聊天高频词剔除了 N 条平台模板（同一文案出现在三个以上会话）；群聊正文不参与。"（N = `lexicon.chat.excluded`，chat 为 null 时省略整句）。
- `#evidence .chapter-inner { max-width: 1400px }`。预期内容盒 510 → ≈ 600px。

### 3.4 注水与隐私

- 在脚本 `/* 01 sample */`、`/* 05 echo */`、`/* 06 evidence */` 三段里各自追加；`rankLines(slot, items, label)` 已有（04 段定义，可提到前面复用），芯片用 `el()` 生成；数字沿用 `num()`/`pct()`。
- 隐私：`body.privacy-on [data-slot="terms-chat"], body.privacy-on [data-slot="chat-words"] { filter: blur(6px) }`；标签不模糊（04 章已明文）。
- 改完 `npm run sync:story`；用户日常入口 `DouyinDataReview.app` 伺服的是 `dist/`，最后要 `npm run build:web`（会自动 sync）。

## 4. 验证

1. `npx vitest run src/services/storyData.test.ts` → `npm run typecheck` → `npm test`。
2. 无头验证（脚本写在 scratchpad，照 §1 的量法）：视口 1440×900、1440×760、2000×1040 各跑一遍；对 `#sample / #echo / #evidence` 检查：无 pageerror；`--fit` ≥ 0.95（1440×760 允许 ≥ 0.9）；`section.offsetHeight === innerHeight`；内容占屏比对基线明显提升（目标 01 ≥ 32%、05 ≥ 38%、06 ≥ 28%，1440×900）；栏与栏、行与行两两不相交；所有新槽位文本含预期数字；隐私按钮后聊天槽位 `getComputedStyle().filter` 含 blur。再跑两遍退化：不注快照（示例数字无报错）、注一份没有 `lexicon`/`fields` 的旧快照（新块隐藏无报错）。三章每个视口截整屏图交给用户，并附改前/改后占屏比表。
3. `npm run build:web` 后 `grep -c "FIELD COVERAGE" dist/story/story-draft_副本.html` 确认进产物。
4. README 第 5 条快照清单加「四条数据流各自的高频词条与集中度、聊天高频词、分享视频词条、字段覆盖率」，同段补口径：词条即显式话题标签；聊天用浏览器内置分词，同一文案出现在三个以上会话的平台模板不计入；群聊正文不参与。
5. 完成报告：改了哪些文件、各改了什么、跑了什么检查、没做什么、剩余风险。

## 5. 非范围与可选后续

- 03/04 章不动；档案馆（应用内分页报告）不动；roll 页不动。
- 02 时间章、07 签名章本次不动。若用户也要填 02，可选的时间深度指标（都能从可靠行为时间直接算）：星期分布七条、最长连续活跃天数、单日最多条数、首次/末次抵达时刻中位；07 可加"签名依据"三个词条。先问再做。
- 分享方向（我分享出去的 vs 朋友分享给我的）：采集器 `collector/chatNormalizer.mjs` 有 `currentUserId` 但没写进快照；要拆需在 store/localCollector 链路给每条消息加 `own: boolean`，另开任务。
- 不引入 jieba 等词库，不做词云/新动效。

## 6. 验收清单

- [ ] `StoryData.lexicon`、`StoryData.fields` 及测试通过；typecheck 通过。
- [ ] 01/05/06 三章在 1440×900 / 1440×760 / 2000×1040 一屏放下，占屏比对基线提升，无 pageerror；富快照、无快照、旧快照三态正常。
- [ ] 隐私开关模糊聊天词。
- [ ] 文案无字段名；示例数字为中性词；只有一个错位节拍。
- [ ] `sync:story` + `build:web` 完成，dist 含新块；截图与占屏比表已交付。
- [ ] README 已更新。
