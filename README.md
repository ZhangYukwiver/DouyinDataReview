<div align="center">
  <a href="https://github.com/ZhangYukwiver/DouyinDataReview/releases/latest"><img src="build/icon.png" alt="DouyinDataReview" width="160" /></a>
  <h1>DouyinDataReview | 抖音数据导出与年度报告工作台</h1>
  <p><strong>把你的抖音数据，留在自己的电脑上</strong></p>
  <p>导出观看历史与聊天记录，管理喜欢和收藏，批量下载视频，生成自己的抖音年度回顾。<br>
  免费开源 · Windows / macOS · 本地保存 · MIT 许可</p>
  <p>问题反馈与交流请联系 QQ 940537208，或加入 QQ 群 DDDouyin（群号 1124211302），见<a href="#交流与反馈">交流与反馈</a>。</p>
  <p>
    <a href="https://github.com/ZhangYukwiver/DouyinDataReview/releases/latest"><img src="https://img.shields.io/github/v/release/ZhangYukwiver/DouyinDataReview?style=flat-square&label=Release" alt="Release" /></a>
    <a href="https://github.com/ZhangYukwiver/DouyinDataReview/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-111111?style=flat-square" alt="MIT License" /></a>
    <a href="https://github.com/ZhangYukwiver/DouyinDataReview/actions/workflows/desktop-release.yml"><img src="https://img.shields.io/github/actions/workflow/status/ZhangYukwiver/DouyinDataReview/desktop-release.yml?branch=main&style=flat-square&label=build" alt="Build status" /></a>
    <a href="https://github.com/ZhangYukwiver/DouyinDataReview/stargazers"><img src="https://img.shields.io/github/stars/ZhangYukwiver/DouyinDataReview?style=flat-square" alt="Stars" /></a>
    <a href="https://github.com/ZhangYukwiver/DouyinDataReview/releases"><img src="https://img.shields.io/github/downloads/ZhangYukwiver/DouyinDataReview/total?style=flat-square" alt="Downloads" /></a>
    <a href="https://github.com/ZhangYukwiver/DouyinDataReview/network/members"><img src="https://img.shields.io/github/forks/ZhangYukwiver/DouyinDataReview?style=flat-square" alt="Forks" /></a>
    <a href="#交流与反馈"><img src="https://img.shields.io/badge/QQ_Group-1124211302-12B7F5?style=flat-square&logo=qq&logoColor=white" alt="QQ Group" /></a>
  </p>
</div>

<table>
  <tr><td><img src="docs/screenshots/setup-trace.jpg" alt="连接与采集" width="400"/></td><td><img src="docs/screenshots/creator-overview-trace.jpg" alt="创作者中心 · 数据总览" width="400"/></td></tr>
</table>

<p align="center"><sub>连接与采集、创作者中心。截图都是合成示例数据。</sub></p>

<p align="center"><a href="https://github.com/ZhangYukwiver/DouyinDataReview/releases/latest">下载桌面版</a> · <a href="https://zhangyukwiver.github.io/DouyinDataReview/">国内下载（加速线路）</a> · <a href="https://zhangyukwiver.github.io/DouyinDataReview/#demo">在线看示例报告</a> · <a href="#面向开发者">从源码运行</a> · <a href="https://github.com/ZhangYukwiver/DouyinDataReview/stargazers">觉得有用就 Star</a></p>

**DouyinDataReview 是一款免费开源的抖音数据采集、导出与分析桌面应用。** 它通过本人登录账号的会话读取抖音观看历史、喜欢、收藏和好友聊天记录，在本机保存为 JSON，并生成持续报告与抖音年度报告（Douyin Wrapped）。工作台还提供视频下载、实时聊天、内容搜索、创作者中心、热点榜、直播观看和抖音推荐流过滤。AI 视频工作台已经拆成独立应用[拆片工坊（ReelLab）](https://github.com/ZhangYukwiver/ReelLab)，内容库和探索页里可以一键送过去。

适合备份个人抖音记录、管理收藏内容、查看创作者数据，以及制作自己的年度回顾。项目面向抖音（Douyin，中国版），不支持国际版 TikTok；提供 Windows x64 和 macOS Apple Silicon 安装包。它是独立开发的非官方工具，与抖音、字节跳动及其关联主体不存在隶属、授权、合作或认可关系。

| 先了解什么 | 简要说明 |
| --- | --- |
| 如何导出数据 | 首屏扫码并确认读取权限，在「设置 → 数据」勾选导出 JSON；聊天默认不勾选，备份不含群聊正文 |
| 是否能取回全部历史 | 只能读取本人账号当前可访问的接口记录；不保证完整历史，也不会补造报告中的缺失数据 |
| 是否必须用 AI | 不需要。本地统计与年度报告都在本机计算；AI 解析和剪辑已拆到独立应用[拆片工坊（ReelLab）](https://github.com/ZhangYukwiver/ReelLab) |
| 是否能离线导入 | 支持本应用备份与抖音官方 JSON / ZIP 档案；官方档案导入关闭后需重新选择文件 |

[数据导出与年度报告使用指南](https://zhangyukwiver.github.io/DouyinDataReview/guide.html)提供完整步骤和数据覆盖范围；供检索工具读取的[项目事实与文档索引](llms.txt)与下载页问答同步维护。

**阅读导航：** [主要功能](#主要功能) · [实现方式](#实现方式) · [快速开始](#快速开始) · [本地数据与接口](#本地数据与接口) · [常见问题](#常见问题) · [面向开发者](#面向开发者)

> [!NOTE]
> 桌面版打开后在首屏扫码登录抖音即可，不用装扩展、不用开调试端口；也可以从 Chrome / Edge / macOS Comet 导入登录凭据，或直接读本机抖音电脑客户端的登录态。工具只能读本人账号在接口当前返回的记录，不保证取回全部历史；采集用的是抖音未公开承诺的私有接口，可能失效或触发账号风控。

## 主要功能

| 功能 | 可以做什么 | 使用条件与边界 |
| --- | --- | --- |
| 抖音数据采集与导出 | 完整或增量读取观看历史、喜欢、收藏和好友聊天记录，导出 JSON；可导入本应用备份或抖音官方「个人信息下载」的 JSON / ZIP | 在线采集需导入本人登录凭据；群聊正文不写入备份 |
| 多账号与后台补读 | 各账号分开保存会话和记录；读取中新记录边读边出，报告读完再更新；关窗后留在托盘或菜单栏，每 3 小时补读一次 | 自动补读可在设置里关 |
| 内容库与视频下载 | 观看历史、直播、喜欢、收藏和推荐流挡掉的视频分页签浏览；按标题、作者、话题、音乐搜索；应用内播放、看评论、发评论、转发；单条或批量 ZIP 下载，图文下载全部图片 | 发评论要先在「设置 → 隐私」打开「允许在抖音上操作」 |
| 实时聊天与续火花 | 实时收消息，回复好友和群聊，看官方火花天数；给勾选的对象一键发续火花消息 | 一次最多 10 位，由用户手动触发；火花天数以抖音为准 |
| 创作者中心 | 本人账号的数据总览、作品数据、粉丝画像，以及作品流量、观众和评论分析 | 只读，按账号权限返回 |
| 内容探索与抖音指数 | 搜用户和作品，点赞、收藏、关注、评论，下载用户主页作品；看实时和飙升热点、达人指标、逐日趋势和粉丝画像 | 互动同样要先打开「允许在抖音上操作」 |
| 直播观看与弹幕 | 看关注的人正在播的直播，调弹幕透明度、字号、速度、区域和屏蔽词 | 只看不发：不发弹幕、不送礼物、不点赞 |
| 推荐流过滤 | 在 Chrome、Edge 刷抖音网页时，按文案、作者、话题、配乐或正则过滤推荐：只记录、隐藏，或隐藏后点「不感兴趣」；挡掉的视频进内容库 | 在「设置 → 推荐流」装一次扩展（需开发者模式）；打开页面的第一屏拦不到；「不感兴趣」每分钟最多 6 条 |
| 持续报告与抖音年度报告 | 最近 30 天对比上一时段，样本不足回退到 90 天；年度回顾有内容年志、档案馆、海报三种风格，可导出 HTML 和 1080 × 1440 PNG 分享图 | 只用本机已存记录，不补造缺失数据 |

AI 视频解析和剪辑已拆成独立应用[拆片工坊（ReelLab）](https://github.com/ZhangYukwiver/ReelLab)：桌面版里点视频上的「送去」，下好的视频直接进拆片工坊的素材库（图文作品不支持）。

## 实现方式

DouyinDataReview 由 **React / React Native / Expo 工作台、Node.js 本地采集器和 Electron 桌面壳**组成。桌面版在本机启动采集器和页面服务；从源码运行时也可以在浏览器里打开同一套工作台。

### 登录、采集与本地报告的数据流

1. **导入登录凭据**：桌面版在隐藏的应用内窗口打开抖音网页，把登录二维码搬到首屏让本人扫（`desktop/inAppBrowser.mjs`，独立会话、不开调试端口）；也可以从 Chrome / Edge / Comet（Playwright CDP）或本机抖音电脑客户端导入。本人确认账号后导出 Cookie、请求参数和签名凭据，按账号保存。
2. **请求平台接口**：采集器用导入的会话发签名 HTTP 请求，按游标分页读取观看历史、喜欢和收藏，不靠网页滚动；聊天和直播弹幕走 WebSocket。
3. **保存个人记录**：数据归一化、合并后写入当前账号的 `records.json`，和登录凭据分开存。
4. **生成统计与报告**：工作台在本机计算时间分布、作者与话题排行、观看与收藏交集、聊天统计等，再交给年度回顾页面，不需要外部 AI 服务。

导入时勾选「读取视频」「读取聊天」（至少一项），之后只读所选类型；选择按账号保存，重新导入可以改。

### 功能模块与源码入口

| 模块 | 实现方式 | 主要源码 |
| --- | --- | --- |
| 工作台与桌面运行 | React 组件展示数据；Expo 提供 Web 构建；Electron 管理窗口、托盘、后台补读和应用更新 | [工作台组件](src/components/workspace/)、[桌面入口](desktop/main.mjs) |
| 浏览器凭据与请求会话 | Playwright 连接已授权的浏览器 CDP；导入后使用独立 HTTP 请求会话，不要求浏览器持续运行 | [浏览器连接](collector/browserConnection.mjs)、[采集流程](collector/douyinCollector.mjs)、[HTTP 客户端](collector/directApi.mjs) |
| 记录采集与存储 | 签名请求与游标分页，归一化字段、合并记录，按账号写入 JSON | [分页与签名](collector/directHistory.mjs)、[归一化](collector/normalizer.mjs)、[记录存储](collector/store.mjs)、[账号管理](collector/accounts.mjs) |
| 搜索与互动 | HTTP 查询用户、作品和评论；用户触发点赞、收藏、关注、评论等写入，消息和分享通过 IM 接口发送 | [内容探索](collector/directExplorer.mjs)、[互动请求](collector/directWrites.mjs) |
| 聊天与直播 | HTTP 获取历史与房间信息；`ws` 接收 WebSocket 推送，解析二进制协议；直播弹幕仅在内存保留最近 300 条 | [聊天客户端](collector/directChat.mjs)、[直播客户端](collector/directLive.mjs)、[协议解析](collector/directProto.mjs) |
| 创作者与达人数据 | 通过当前账号会话读取创作者中心和抖音指数接口，整理指标与图表 | [创作者中心](collector/creatorCenter.mjs)、[抖音指数服务](src/services/douyinIndex.ts) |
| 推荐流过滤 | 浏览器扩展在推荐数据进页面前按词条拿掉命中的视频，必要时调用「不感兴趣」接口；词条、过滤方式和记录都存在采集器，扩展的令牌只能读设置、回传记录；应用带了新版扩展时扩展自己升级 | [浏览器扩展](extension/)、[过滤设置与记录](collector/feedFilter.mjs) |
| 视频播放与下载 | HTTP 获取作品详情和媒体地址，由本地接口提供播放与下载；批量视频通过 `fflate` 打包 ZIP | [媒体下载](collector/videoDownloader.mjs)、[批量打包](src/services/batchVideoDownload.ts) |
| 报告与档案导入 | TypeScript 计算年度与持续报告，标注日期来源和覆盖率；解析本应用备份及官方 JSON / ZIP；年度页面导出 HTML 与 PNG | [年度统计](src/domain/annualReport.ts)、[持续报告](src/domain/livingReport.ts)、[档案解析](src/domain/personalArchiveParser.ts)、[汇总快照](src/services/storyData.ts)、[报告导出](prototype/story-export.js) |

### 数据来源与功能边界

个人记录来自本人账号可访问的抖音接口，或本人导入的官方档案；创作者指标、达人指标和火花状态来自对应平台接口。报告只能反映已采集的数据：缺失日期、缺失字段和样本不足会影响统计，应用不会把采集时间当成真实观看时间。

## 年度回顾

在「设置 → 界面风格」里挑一种，点「打开报告」。默认的极简风格只管采集器页和工作台，打开报告时用设置里选的那一套。

- **内容年志**（默认）：先看到一张入口卡，写着观看、喜欢、收藏、聊天各有多少条；点卡片穿过去，是一卷十章的夜色长卷，天色随章节在五个时辰的油画之间变换。
- **档案馆**：暗色星图卷宗，按页展示记录与图表，支持点击和键盘翻页。
- **海报**：墨黑、新闻纸配信号橙的展览海报，十章硬切长卷，就是下面演示视频中的一种视觉风格。

https://github.com/user-attachments/assets/f4dd2420-121d-49b7-ba37-c632c03f10ec

<p align="center"><sub>海报风格的年度回顾，从封面一路滚到落款。视频和截图都是合成示例数据；这是可切换的其中一种视觉风格。</sub></p>

<table>
  <tr><td><img src="docs/screenshots/story-entry.jpg" alt="内容年志 · 入口卡" width="400"/></td><td><img src="docs/screenshots/trace-arrive.jpg" alt="内容年志 · 抵达" width="400"/></td></tr>
  <tr><td><img src="docs/screenshots/trace-time.jpg" alt="内容年志 · 二十四小时的天色" width="400"/></td><td><img src="docs/screenshots/trace-kept.jpg" alt="内容年志 · 三张叠在一起的卡" width="400"/></td></tr>
  <tr><td><img src="docs/screenshots/trace-taste.jpg" alt="内容年志 · 被光照到的名字" width="400"/></td><td><img src="docs/screenshots/trace-sign.jpg" alt="内容年志 · 落款" width="400"/></td></tr>
</table>

> 报告只用记录里明确带着的作者、话题、音乐、时长和互动数，不接外部 AI 推测兴趣，也不做心理诊断。视频的「词条」只取显式话题标签；聊天高频词用浏览器内置的 `Intl.Segmenter` 分词，先剔除平台模板消息，群聊正文不参与。

<details>
<summary>工作台截图：连接与采集、持续报告、内容库、聊天、创作者中心（点击展开）</summary>

<table>
  <tr><td><img src="docs/screenshots/setup-trace.jpg" alt="连接与采集" width="400"/></td><td><img src="docs/screenshots/dashboard-trace.jpg" alt="持续报告" width="400"/></td></tr>
  <tr><td><img src="docs/screenshots/records-trace.jpg" alt="内容库" width="400"/></td><td><img src="docs/screenshots/chat-trace.jpg" alt="聊天" width="400"/></td></tr>
  <tr><td><img src="docs/screenshots/creator-works-trace.jpg" alt="创作者中心 · 作品数据与粉丝数据" width="400"/></td><td><img src="docs/screenshots/creator-fans-trace.jpg" alt="创作者中心 · 粉丝画像" width="400"/></td></tr>
</table>

</details>

## 支持平台与设备

| 平台 | 设备 / 架构 | 安装包 |
| --- | --- | --- |
| Windows | x64 | `DouyinDataReview-Setup-<version>.exe`（NSIS 安装器） |
| macOS | Apple Silicon（arm64） | `DouyinDataReview-<version>-arm64.dmg` |

两个安装包都没有开发者签名，首次打开的处理见「快速开始」。手机可以在同一局域网连电脑上的采集器，见[手机连接](#手机连接)。

## 快速开始

1. 从[最新 Release](https://github.com/ZhangYukwiver/DouyinDataReview/releases/latest) 下载对应安装包。

   **macOS 首次打开前需在终端执行一次 `xattr -cr "/Applications/DouyinDataReview.app"`，否则会提示应用已损坏；Windows 出现 SmartScreen 时点「更多信息」，再点「仍要运行」。**

2. 打开应用，在首屏「数据来源」点二维码位置的遮罩，用抖音 App 扫码并在手机上确认；核对昵称，勾选读取视频、读取聊天，点「确认导入」，读取自动开始。
3. 读完后在内容库用页签切换观看历史、直播、喜欢、收藏和「推荐流挡掉的」，聊天和持续报告在侧栏。
4. 在「设置」里换界面风格、导出数据，点「打开报告」看年度回顾。关掉窗口后应用留在托盘每 3 小时补读一次，完全退出要在托盘菜单里点「退出」。

### 登录方式

- **应用内扫码（桌面版默认）**：二维码约一分钟一换，5 分钟没扫会自动续。抖音要求二次验证或身份验证时，验证码和「用短信验证码验证」会直接出现在首屏，其他验证方式点「用其他方式验证」在窗口里完成；想用手机验证码登录就点「在窗口里登录」。加另一个号点「换个号扫码」，只清本机后台网页的登录状态，不在抖音退出。后台网页用独立会话（`persist:douyin-login`），只允许打开抖音及登录相关页面。
- **从浏览器导入**：在「设置 → 账号 → 导入登录凭据」选 Chrome 144+、带远程调试开关的 Edge 或 macOS Comet，点「连接浏览器」；按提示在 `chrome://inspect/#remote-debugging`（Edge、Comet 同理）允许远程调试后再连一次，没登录就在新开的抖音页登录（最多等 5 分钟）。导入后自动断开，可以关掉浏览器和调试开关。工作台只读抖音域 Cookie、只动自己打开的标签页；不支持 Firefox、自定义用户目录和其他浏览器渠道。
- **读取抖音电脑客户端（Windows / macOS）**：先在客户端里登录并打开一次页面，再在同一入口选「抖音桌面端」，点「读取登录态」（macOS 会弹钥匙串「douyin Safe Storage」授权，点「允许」）。Cookie 在本机解密（Windows 用 DPAPI + AES-256-GCM，macOS 用钥匙串密钥 + AES-128-CBC），只留 `douyin.com` 的条目，明文不落盘；收发私信要用的 ticket-guard 材料一起取出，之后不开客户端也能读取和发消息。

凭据失效、账号不一致或平台要求验证时，重新登录并导入即可；短期令牌过期本身不用重新导入。

> 安装包不含本地记录、登录状态或浏览器配置。记录保存在 macOS 的 `~/Library/Application Support/内容数据工作台/collector/` 或 Windows 当前用户的应用数据目录，升级不会覆盖。桌面版启动时检查 GitHub Release：Windows 可在设置里「重启并安装」（采集中不会自动重启），macOS 在设置里下载后手动替换。

出了问题先看[常见问题](#常见问题)；从源码跑、自己打包或用手机连，看[面向开发者](#面向开发者)。

## 本地数据与接口

<details>
<summary>数据放在哪、本地接口和不落盘的内容（点击展开）</summary>

### 数据放在哪

从源码运行时在项目的 `.local-data/`（已被 git 忽略），桌面版在上面说的应用数据目录。

- `records.json`：归一化记录；其他账号在 `accounts/<12 位编号>/`，账号列表在 `accounts.json`
- `direct-session.json`：导入的登录会话，按账号隔离，仅当前用户可读写
- `external-browser.json`：只记凭据来源（`app` 为应用内扫码，`desktop` 为抖音电脑客户端，其余为浏览器类型），不含凭据
- `direct-history-template.json`：浏览器标识和白名单查询参数，不含 Cookie
- `feed-filter.json`：推荐流过滤的词条、处置记录和挡掉的视频（最多 1000 条），各账号共用
- `diagnostics/verify-*.html`：应用内登录遇到身份验证时存下的页面结构（去掉脚本、数字打码），只在本机，用来调整识别
- 应用内登录的网页状态在应用数据目录的 `Partitions/douyin-login/`，各账号共用
- 内容年志只把汇总快照写进浏览器本地；「清除本地记录」只删当前账号的记录和快照，不动登录状态，也不改抖音账号里的数据

### 本地接口

采集器默认监听 `127.0.0.1:4765`。

| 路径 | 用途 |
| --- | --- |
| `/v1/health`、`/v1/pairing-code`、`/v1/pair`、`/v1/sync*`、`/v1/experimental/records-direct` | 配对与采集；配对码和增量读取只允许本机连接 |
| `/v1/status`、`/v1/records*`、`/v1/accounts*` | 记录与账号，切换冲突返回 `409` |
| `/v1/chat/*`、`/v1/explore/*` | 聊天与探索；发送由用户触发并校验回执，结果不明时不自动重发 |
| `/v1/creator/read`、`/v1/live/*` | 创作者中心与直播；关注在播列表缓存 30 秒 |
| `/v1/feed-filter*` | 推荐流过滤；扩展用单独范围的令牌，只能读设置、回传记录 |
| `/v1/downloads*` | 下载与播放，由用户触发，播放地址用独立密钥 |
| `/v1/browser/*` | 导入凭据：`sources`、`connect`（`{"browser":"app"}` 应用内扫码，加 `"fresh":true` 换号；`{"browser":"desktop"}` 读电脑客户端）、`login-qrcode`、`login-window`、`confirm`、`pending`、`disconnect`；仅本机可用 |

桌面版的「送去拆片工坊」不走接口，由主进程把下好的视频复制进拆片工坊的收件箱。

### 不落盘的内容

- 12 小时会话 Token 只在应用内存和请求头里，不进 URL 或本地存储。
- 原始响应、请求头、Cookie、签名和完整诊断 URL 不写入记录文件。
- 群聊消息和官方火花数据都是用时通过 IM 接口现读，不写入记录文件。
- 直播弹幕只在采集器内存里留最近 300 条，退出直播间就没了。

</details>

## 常见问题

### 有没有像 Spotify Wrapped 那样的抖音年度报告？

有。DouyinDataReview 用你本机保存的观看、喜欢、收藏和聊天记录生成抖音年度报告，不用等平台发，随时都能打开，还能存成 3:4 的分享图。报告有内容年志、海报等几种视觉风格，不装软件也可以先[在线看示例报告](https://zhangyukwiver.github.io/DouyinDataReview/#demo)（里面是编出来的演示数据）。

### 怎么导出抖音观看历史和聊天记录？

安装 DouyinDataReview，在首屏扫码登录抖音并导入凭据（网页版在「设置 → 账号」连接浏览器导入）。读取完成后，在「设置 → 数据」点「导出数据」，可分别选择观看历史、喜欢、收藏和聊天数据，保存为 JSON；聊天默认不勾选，未勾选的内容不会写入文件，导出不会触发平台读取。换电脑时在新电脑的采集器页「选择文件」导入，再点「并入本机记录」即可继续使用。聊天导出包含已保存的好友消息及会话信息（含群聊统计）；群聊正文不在备份里。

### 抖音数据怎么采集？需要一直开着浏览器吗？

采集器使用导入的登录凭据，通过抖音 HTTP 接口分页读取记录，聊天和直播弹幕通过 WebSocket 接收。应用内的后台网页或浏览器只在登录、验证和导入凭据时用到；导入成功且凭据有效时自动断开（用浏览器导入的可以关掉浏览器和远程调试），工作台仍可采集；Windows 和 macOS 上还可以直接读本机抖音电脑客户端的登录态，客户端开着关着都不影响读取。具体模块见[实现方式](#实现方式)。

### 能导出全部抖音历史记录吗？

不能保证。在线采集只能取得抖音接口当前返回且本人账号有权访问的记录，无法恢复接口已经不提供的数据。持续使用可以在本机积累个人记录；年度报告的范围取决于已保存记录的日期和字段，缺失数据会影响覆盖率。也可导入抖音官方个人信息下载的档案生成报告。

### 已经用抖音官方「个人信息下载」导出过数据，能直接用吗？

能。在采集器页「或者导入个人档案」那里点「选择文件」，选官方导出的 JSON 或 ZIP，就能用这份档案生成报告，不用登录。导入的文件只在这次打开时读取，关掉应用后要重新导入。

### 能批量下载抖音里喜欢和收藏的视频吗？

能。内容库里点「批量下载」进入多选，选好的视频会打包成 ZIP 存到本机；探索页进到某个用户的主页，也能单条或多选下载这个用户的作品。图文作品会下载全部图片。

每次下载都会按当前登录会话检查作品详情；对仍可访问的旧作品，不要求在发布后三小时内下载。报告样本中的约 3 小时或 24 小时是单条签名媒体地址的有效期估算，不是作品本身的期限。详情被拒绝、没有返回作品或作品 ID 不匹配时会停止；本实现不保存或复用旧签名地址，因此不支持作品变为不可访问后的应急取回。批量 ZIP 内的 `evidence.json` 记录脱敏后的响应状态、允许列表中的缓存响应头、字节数和 SHA-256；不会保存签名媒体 URL、Cookie 或完整查询参数。证据仅描述本次客户端观察，签名过期时间可能无法识别，CDN 缓存头也不能证明源站权限或内容授权。

### 能屏蔽抖音推荐里不想看的视频吗？

能。DouyinDataReview 在「设置 → 推荐流」提供一个浏览器扩展，拖进 Chrome 或 Edge 的扩展页装一次，写好词条（关键词、作者、话题、正则都行），以后在抖音网页刷推荐时，命中的视频可以只记录、直接隐藏，或隐藏后替你点「不感兴趣」。挡掉的视频会出现在内容库的「推荐流挡掉的」里，误杀了回头改词条就行。只对网页版生效，手机 App 里的推荐不受影响。

### 收费吗？数据会传到哪里？

应用免费，源码以 MIT 许可开源。个人记录保存和报告统计在本机完成，在线采集只请求抖音，应用本身不连任何 AI 服务。AI 解析和剪辑已拆到独立应用[拆片工坊（ReelLab）](https://github.com/ZhangYukwiver/ReelLab)：只有你点「送去」按钮送过去的那条视频（文件和标题、作者、链接、时长）会交给它，之后怎么用、发到哪里由拆片工坊自己说明。完整说明见[数据来源与功能边界](#数据来源与功能边界)。

### 会被封号吗？

没法保证不会。工具用的是你自己在抖音网页版登录的会话，读的是你本人能看到的记录；但记录读取走的是抖音没有公开承诺的接口，可能失效，也可能触发风控。建议只在自己的账号上用，别拿它批量操作别人的账号或群发消息。

### macOS 打开时提示应用已损坏？

安装包没有开发者签名。在终端执行一次 `xattr -cr "/Applications/DouyinDataReview.app"`，再打开就行。

### Windows 弹出 SmartScreen？

点「更多信息」，再点「仍要运行」。

### 首次使用如何登录？

桌面版打开后在首屏点二维码位置的遮罩，用抖音 App 扫码，核对账号后确认导入，读取自动开始，不需要另外装浏览器、开调试或手动连接采集器。从源码运行、在浏览器里打开工作台时没有这个入口，要在 Chrome、Edge 或 macOS Comet 中开启远程调试再连接浏览器，Windows 和 macOS 上也可以选「抖音桌面端」直接读本机电脑客户端的登录态；未登录时在新开的抖音页面完成登录，工作台会等待并自动继续。

### 提示「采集器端口 4765 已被占用」？

通常是旧实例仍在后台运行。先从旧版的托盘或菜单栏选择「退出」，再启动新版；从源码运行时，也要停止之前启动的采集器。只关闭窗口可能仍会留在后台，不需要删除本地记录或登录配置。

### 已连接却提示需要导入凭据或读取配置不完整？

桌面版在首屏点「重新扫码登录」（网页版在「设置 → 账号」重新连接已登录的浏览器），勾选所需读取类型并确认导入。勾选视频时建立 HTTP 分页所需的请求参数，并自动读取一次（已读完过的账号只补新增）；只勾选聊天时不初始化观看历史读取。升级保留本地记录，旧版已有完整且有效的凭据也可以继续使用。

### 报告是空的，或提示「报告有更新」？

采集进行中也能打开报告，这时数据可能还不全；采集结束后会提示「报告有更新」并换成新数据。持续报告在最近 30 天样本不足时会自动回退到 90 天。

### 火花天数和抖音里显示的对不上？

开着聊天接收时，看板里亮着的火花读的是抖音接口返回的官方天数，应该和抖音里一致。没在接收时才按本机保存的聊天记录估算：同一天双方都发过消息才算一天，连着聊满 3 天点亮，断一天清零。抖音没公开自己的算法，本地也只有采集到的那部分记录，所以估算只当参考；想改口径可以改源码 `src/domain/chatSparks.ts` 里的 `SPARK_LIT_DAYS` 等常量。

### 探索页提示需要登录或验证？

在日常浏览器中完成抖音登录或验证，再到「设置 → 账号」重新连接并导入凭据，然后重试。

### 手机连不上？

电脑端启动采集器时要加 `--lan`，并用 `--origin` 写上手机实际打开的页面地址；手机上把服务地址改成采集器显示的局域网地址。完整命令见[手机连接](#手机连接)。

### 还有别的问题？

到 [Issues](https://github.com/ZhangYukwiver/DouyinDataReview/issues) 或 QQ 群提问，见[交流与反馈](#交流与反馈)。

## 面向开发者

```bash
# 1. 克隆项目并安装依赖
git clone https://github.com/ZhangYukwiver/DouyinDataReview.git
cd DouyinDataReview
npm install

# 2. 下载并校验评论回复用的签名器（不装也能用，只是展开不了评论回复）
npm run direct:setup

# 3. 启动采集器（终端 A）
npm run collector

# 4. 启动 Web 页面（终端 B），然后打开 http://localhost:8081 点「连接采集器」
npm run web
```

页面与采集器在同一台电脑时会自动获取并填入 8 位一次性配对码。

其他开发方式：

- macOS 一键启动：`npm run app:mac` 生成 `DouyinDataReview.app`，打开后启动采集器和页面；启动时会重建页面，修改 `prototype/` 后需运行 `npm run sync:story`。
- Windows 桌面开发版：`npm run desktop` 构建页面并启动 Electron 和本机采集器。
- 进程看护：`npm run watch:process -- npm run web`；CPU 持续超过 500% 或 RSS 超过 2 GB 时会停止进程。
- 验证：`npm run typecheck`、`npm test`、`npm run build:web`。年志源码在 `prototype/`，可用 `npm run sync:story` 同步（构建时会自动同步）。

<details>
<summary>打包 exe / dmg 安装包，适合要自己出包的开发者查阅（点击展开）</summary>

**Windows（NSIS 安装器）**

```bash
npm run desktop:build
```

输出到 `release/DouyinDataReview-Setup-<version>.exe`，带桌面和开始菜单快捷方式。

**macOS（DMG）**

```bash
npm run desktop:build:mac
```

在 Apple Silicon Mac 上输出 `release/DouyinDataReview-<version>-arm64.dmg`。没有 Apple 开发者签名时会做 ad-hoc 签名，拿到 dmg 的人首次打开前仍要执行上面的 `xattr -cr`。

</details>

### 手机连接

电脑和手机需在同一可信局域网。启动采集器并填写手机打开的页面地址：

```bash
npm run collector -- --lan --origin http://192.168.1.20:8081
```

应用中将服务地址设为采集器显示的局域网地址，例如 `http://192.168.1.20:4765`。LAN 模式使用一次性配对码和内存会话，但流量为 HTTP，仅适合可信网络。

## 安全说明

1. **仅限个人使用**：此工具只读取你本人登录账号当前可见的记录，发消息、点赞、评论、转发等操作也只在你手动点击时进行（一键续火花也要你勾好对象、点开始才发这一轮，不做定时）；请勿用于他人账号，也别拿它群发营销或刷屏
2. **登录态安全**：账号目录保存着导出的 Cookie 和签名凭据，请妥善保管，不要拷贝或分享给他人
3. **数据隐私**：本地记录和聊天快照包含个人隐私信息，请谨慎处理；仓库和安装包本身不含任何数据
4. **合法使用**：请遵守相关法律法规和平台规则，不得用于非法目的

## 免责声明

> [!IMPORTANT]
> 请在充分理解以下内容，并自愿承担相应责任的前提下使用本项目：
>
> 1. **项目性质**
>
>    本项目为独立开发的非官方开源工具，与抖音、字节跳动及其关联主体不存在隶属、授权、合作或认可关系。相关产品名称和商标归其权利人所有。
>
> 2. **合法使用**
>
>    本项目仅可用于处理使用者本人合法持有、管理或已经取得明确授权访问的数据。使用者应遵守适用的法律法规、软件许可协议、平台规则和隐私保护义务。
>
> 3. **数据与备份**
>
>    使用过程涉及本地记录、浏览器登录态、聊天快照和下载的视频文件。开始前请备份重要数据，并自行负责登录态保管、数据安全和隐私保护。
>
> 4. **兼容性与运行风险**
>
>    抖音页面结构、接口格式或风控策略变化，可能导致读取失败、功能失效、账号提醒或其他不可预期结果。本项目不保证对未来抖音版本持续兼容。
>
> 5. **责任范围**
>
>    本项目按现状提供，不对功能的准确性、完整性、稳定性或持续可用性作出明示或默示保证。在适用法律允许的范围内，因使用、误用、版本不兼容、操作中断或第三方策略变化产生的损失和后果，由使用者自行承担。
>
> 使用或继续使用本项目，即表示使用者已经阅读、理解并同意以上内容，并愿意对自己的操作及其结果负责。

## English

**DouyinDataReview is a free, open-source desktop app for exporting and analyzing your own Douyin data on Windows x64 and macOS Apple Silicon.** It targets Douyin in China; international TikTok is not supported. It saves watch history, likes, favorites and friend chats locally as JSON and generates rolling reports and a year-in-review ("Douyin Wrapped"). Group chat bodies are excluded from backups. This is an independent, unofficial project. The interface is in Chinese, and the source is MIT-licensed. Download the installer from [Releases](https://github.com/ZhangYukwiver/DouyinDataReview/releases/latest); see the [export and privacy guide](https://zhangyukwiver.github.io/DouyinDataReview/guide.html).

### Features

- Export personal records as JSON, restore app backups, or import Douyin's official JSON / ZIP personal data archive.
- Keep separate account sessions and records, receive chats in real time, reply to friends and groups, and view official chat streak status. Sending a message does not guarantee a streak increase.
- Search saved content, play videos, download individual videos or image posts, and batch-download videos as ZIP files.
- Search Douyin users and posts, interact on request (likes, favorites, follows and comments stay off until you turn on "允许在抖音上操作" in Settings → Privacy), and view hot lists, Creator Center stats and Douyin Index metrics through the current account's access.
- Watch live streams with configurable live comments; live comments are received only.
- Filter the Douyin web recommendation feed in Chrome or Edge with a browser extension you install once from Settings: match keywords, authors, hashtags, music or regex, then log, hide, or hide and send "not interested". Filtered videos show up in the library.
- Generate local reports in three visual styles, with standalone HTML and 1080 × 1440 PNG exports.
- The AI video workbench now lives in a separate app, [ReelLab](https://github.com/ZhangYukwiver/ReelLab); on the desktop app, the "送去" (send) button on a video in the library or the explore page sends it over in one click.

### How it works

The app combines a React / React Native / Expo interface, a Node.js collector and an Electron desktop shell. To sign in, scan the Douyin login QR code on the first screen (the desktop app opens Douyin in a hidden, isolated in-app window, with no debugging port), import credentials from Chrome 144+, Edge or Comet on macOS through CDP, or read the signed-in Douyin desktop client on Windows / macOS. After you confirm the account and choose video and/or chat reading, the app saves cookies, request parameters and signing credentials per account and disconnects. The collector then uses signed, paginated HTTP requests for records and WebSocket for real-time chats and live comments. Records are stored in local per-account JSON files, and reports are computed on your computer without an external AI service. See [implementation and source modules](#实现方式).

Collection is limited to records currently returned by Douyin's private APIs and accessible to your account. It cannot guarantee a complete lifetime history or future API compatibility. Reports reflect the records you have saved and their available fields.

- **Is there a Douyin Wrapped?** DouyinDataReview builds a Wrapped-style year-in-review from your own records on your computer, any time you want; you can [preview a demo report](https://zhangyukwiver.github.io/DouyinDataReview/#demo) in the browser without installing anything.
- **How do I export my Douyin watch history?** Connect the collector and import credentials in Settings → Account with video reading selected. After the full read finishes, click 导出数据 (Export data) in Settings → Data. Select watch history, likes, favorites and/or chats. Only selected data is saved to JSON; chats are unchecked by default. Exported files can be imported again.
- **Can it read the official Douyin data download?** Yes. Import the JSON or ZIP from Douyin's 个人信息下载 (personal data download) to generate a report without signing in.
- **Is it free and private?** The app is free and MIT-licensed. Records are stored and reports computed locally, collection only talks to Douyin, and the app itself calls no AI service. AI analysis and editing moved to the separate [ReelLab](https://github.com/ZhangYukwiver/ReelLab) app: only a video you send with the "送去" (send) button (the file plus its title, author, link and duration) is handed to it, and ReelLab documents what happens next.

## 交流与反馈

| 渠道 | 怎么用 |
| --- | --- |
| [GitHub Issues](https://github.com/ZhangYukwiver/DouyinDataReview/issues) | 报 bug、提需求，公开有记录，遇到过同样问题的人也能回答你 |
| QQ 群「DDDouyin」 | 群号 1124211302，讨论与互助 |
| QQ | 940537208，问题反馈与交流直接联系 |

提问前先看一遍[常见问题](#常见问题)，并附上出问题时的操作步骤和系统版本，能省掉来回追问。

<p align="center"><img src="docs/qq-group.jpg" alt="DDDouyin QQ 群二维码" width="360" /></p>

## 致谢

感谢 [Expo](https://github.com/expo/expo) / [React Native](https://github.com/facebook/react-native) / [react-native-web](https://github.com/necolas/react-native-web)（工作台页面）、[Electron](https://github.com/electron/electron) / [electron-builder](https://github.com/electron-userland/electron-builder)（桌面壳与安装包）、[Playwright](https://github.com/microsoft/playwright)（连接浏览器 CDP 与 HTTP 请求会话）、[lucide](https://github.com/lucide-icons/lucide)（图标）和 [mafqla/douyin-api](https://github.com/mafqla/douyin-api)（评论回复签名，GPL-3.0，固定版本、按原样随安装包附带并保留其许可证）。

## 贡献

发现 bug、有功能诉求、觉得操作繁琐或界面不好看，都欢迎提 [Issue](https://github.com/ZhangYukwiver/DouyinDataReview/issues)；想动手改的话，fork 后发 [Pull Request](https://github.com/ZhangYukwiver/DouyinDataReview/pulls) 就行。

<a href="https://github.com/ZhangYukwiver/DouyinDataReview/graphs/contributors"><img src="https://contrib.rocks/image?repo=ZhangYukwiver/DouyinDataReview" alt="Contributors" /></a>

## Star History

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=ZhangYukwiver/DouyinDataReview&type=Date&theme=dark" />
  <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=ZhangYukwiver/DouyinDataReview&type=Date" />
  <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=ZhangYukwiver/DouyinDataReview&type=Date" />
</picture>

<p align="center"><strong>请负责任地使用本工具，遵守相关法律法规。</strong></p>
