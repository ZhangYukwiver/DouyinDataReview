<div align="center">
  <a href="https://github.com/ZhangYukwiver/DouyinDataReview/releases/latest"><img src="build/icon.png" alt="DouyinDataReview" width="160" /></a>
  <h1>DouyinDataReview | 抖音数据导出、推荐流控制与视频解析工作台</h1>
  <p><strong>把你的抖音数据，留在自己的电脑上</strong></p>
  <p>导出观看历史与聊天记录，按关键词控制抖音推荐流，把视频解析成学习笔记；还能在电脑上刷抖音推荐，管理喜欢和收藏、批量下载视频，生成自己的抖音年度回顾。<br>
  免费开源 · Windows / macOS / Linux · 本地保存 · MIT 许可</p>
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
  <tr><td><img src="docs/screenshots/feed-filter-trace.jpg" alt="推荐流控制 · 词条与处置记录" width="400"/></td><td><img src="docs/screenshots/video-notes-trace.jpg" alt="视频解析 · 带配图的学习笔记" width="400"/></td></tr>
</table>

<p align="center"><sub>推荐流控制、把视频解析成学习笔记。笔记由作者自己的讲解片解析而来，词条和处置记录是示例数据。</sub></p>

<p align="center"><a href="https://github.com/ZhangYukwiver/DouyinDataReview/releases/latest">下载桌面版</a> · <a href="https://zhangyukwiver.github.io/DouyinDataReview/">国内下载（加速线路）</a> · <a href="https://zhangyukwiver.github.io/DouyinDataReview/app/">在线体验</a> · <a href="https://zhangyukwiver.github.io/DouyinDataReview/#demo">在线看示例报告</a> · <a href="#面向开发者">从源码运行</a> · <a href="https://github.com/ZhangYukwiver/DouyinDataReview/stargazers">觉得有用就 Star</a></p>

**DouyinDataReview 是一款免费开源的抖音数据采集、导出与分析桌面应用。** 它用你本人登录的抖音会话读取观看历史、喜欢、收藏和好友聊天记录，保存在本机；能按关键词控制抖音推荐流，把视频解析成逐字稿、学习笔记和分镜脚本。工作台还能在电脑上刷抖音推荐、下载视频、实时聊天、看创作者中心和直播，生成持续报告和抖音年度报告（Douyin Wrapped），另有可选的 AI 助手。

工作台面向抖音（中国版），不支持国际版 TikTok。工作台另能扫码导出[小红书的收藏和点赞](#小红书收藏和点赞导出)并出看板，也能看小红书推荐、搜笔记、读评论和主页（[接口](#小红书内容读取)）。桌面版提供 Windows x64、macOS Apple Silicon 和 Linux x64 安装包。本项目是独立开发的非官方工具，与抖音、字节跳动及其关联主体不存在隶属、授权、合作或认可关系。完整步骤见[数据导出与年度报告使用指南](https://zhangyukwiver.github.io/DouyinDataReview/guide.html)，给检索工具读的项目事实在 [llms.txt](llms.txt)。

> [!NOTE]
> 只能读到本人账号在接口当前返回的记录，不保证取回全部历史。采集用的是抖音没有公开承诺的接口，可能失效，也可能触发账号风控。

## 主要功能

- **采集与导出**：观看历史、喜欢、收藏和聊天记录存在本机，导出 JSON，也能导入抖音官方档案
- **推荐流控制**：按关键词屏蔽不想看的视频，把想看的词条混进推荐，软件和网页都能用
- **视频解析与学习笔记**：把视频转成带时间戳的逐字稿、带配图的学习笔记或分镜脚本，能批量解析
- **刷视频与内容库**：在电脑上刷抖音推荐，浏览、搜索、批量下载自己的记录
- **聊天与续火花**：实时收发消息，一键续火花
- **创作者中心、探索与直播**：看自己的作品和粉丝数据（能导出表格）、热点榜、关注的人的直播
- **AI 助手（可选）**：用对话查数据、替你操作，可在设置中选择本机 Codex、Claude Code 或 WorkBuddy，也支持模型接口；Claude Code、Codex 等客户端还可通过 MCP 接入
- **年度报告**：三种风格，可导出 HTML 和分享图

WorkBuddy 接入需要安装并打开桌面版、保持账号已登录。应用通过 WorkBuddy 自带的本机通道使用账号，无需填写 API Key。当前支持 AI 对话、应用工具操作和口播学习笔记；关键帧识别请使用 Codex 或支持图片的接口模型。

点赞、评论这些和抖音里一样，默认关着，在「设置 → 隐私」打开。

## 年度回顾

在「设置 → 界面风格」选一种，点「打开报告」：内容年志（默认）是十章夜色长卷，档案馆是可以翻页的暗色星图卷宗，海报是墨黑配信号橙的展览海报。报告只用本机已存的记录，不补造缺失数据，也不接外部 AI。

https://github.com/user-attachments/assets/f4dd2420-121d-49b7-ba37-c632c03f10ec

<p align="center"><sub>海报风格的年度回顾，从封面一路滚到落款。视频和截图都是合成示例数据；这是可切换的其中一种视觉风格。</sub></p>

<table>
  <tr><td><img src="docs/screenshots/story-entry.jpg" alt="内容年志 · 入口卡" width="400"/></td><td><img src="docs/screenshots/trace-arrive.jpg" alt="内容年志 · 抵达" width="400"/></td></tr>
  <tr><td><img src="docs/screenshots/trace-time.jpg" alt="内容年志 · 二十四小时的天色" width="400"/></td><td><img src="docs/screenshots/trace-kept.jpg" alt="内容年志 · 三张叠在一起的卡" width="400"/></td></tr>
  <tr><td><img src="docs/screenshots/trace-taste.jpg" alt="内容年志 · 被光照到的名字" width="400"/></td><td><img src="docs/screenshots/trace-sign.jpg" alt="内容年志 · 落款" width="400"/></td></tr>
</table>

<details>
<summary>工作台截图：连接与采集、持续报告、内容库、聊天、创作者中心（点击展开）</summary>

<table>
  <tr><td><img src="docs/screenshots/setup-trace.jpg" alt="连接与采集" width="400"/></td><td><img src="docs/screenshots/dashboard-trace.jpg" alt="持续报告" width="400"/></td></tr>
  <tr><td><img src="docs/screenshots/records-trace.jpg" alt="内容库" width="400"/></td><td><img src="docs/screenshots/chat-trace.jpg" alt="聊天" width="400"/></td></tr>
  <tr><td><img src="docs/screenshots/creator-overview-trace.jpg" alt="创作者中心 · 数据总览" width="400"/></td><td><img src="docs/screenshots/creator-works-trace.jpg" alt="创作者中心 · 作品数据与粉丝数据" width="400"/></td></tr>
  <tr><td><img src="docs/screenshots/creator-fans-trace.jpg" alt="创作者中心 · 粉丝画像" width="400"/></td><td></td></tr>
</table>

</details>

## 快速开始

1. 从[最新 Release](https://github.com/ZhangYukwiver/DouyinDataReview/releases/latest) 下载安装包：Windows 用 `DouyinDataReview-Setup-<version>.exe`，macOS（Apple Silicon）用 `DouyinDataReview-<version>-arm64.dmg`，Linux x64 用 `DouyinDataReview-<version>-amd64.deb`（Debian / Ubuntu 系）或 `DouyinDataReview-<version>-x86_64.AppImage`。

   **macOS 首次打开前需在终端执行一次 `xattr -cr "/Applications/DouyinDataReview.app"`，否则会提示应用已损坏；Windows 出现 SmartScreen 时点「更多信息」，再点「仍要运行」。**

2. 打开应用，在首屏用抖音 App 扫码并在手机上确认；核对昵称，勾选读取视频、读取聊天，点「确认导入」，读取自动开始。
3. 进工作台默认是刷视频，内容库、聊天和持续报告在侧栏。在「设置」里换风格、导出数据，点「打开报告」看年度回顾。

也可以在「设置 → 账号」从 Chrome / Edge / macOS Comet 导入登录凭据，或直接读本机抖音电脑客户端的登录态。关掉窗口后应用留在托盘，每 3 小时补读一次，完全退出要在托盘菜单里点「退出」。记录存在本机，升级不会覆盖。

## 常见问题

### 能按关键词屏蔽抖音推荐里不想看的视频吗？

能，在「设置 → 推荐流」写好词条，软件里刷视频直接生效，Chrome、Edge 网页装一次扩展。还能把想看的词条混进推荐，或者只看词条。

### 能把抖音视频转成文字稿或学习笔记吗？

能，在播放器或内容库里点「解析视频」，选逐字稿、学习笔记或分镜脚本；笔记和分镜要先在「设置 → AI」填好模型。

### 能在电脑上刷抖音推荐吗？

能，进工作台默认就是「刷视频」，还能把想看的词条混进推荐。

### 怎么导出抖音观看历史和聊天记录？

读取完成后在「设置 → 数据」点「导出数据」，勾选要导出的类型存成 JSON。

### 能批量下载抖音里喜欢和收藏的视频吗？

能，内容库里点「批量下载」，多选后打包成 ZIP。

### 有没有像 Spotify Wrapped 那样的抖音年度报告？

有，用本机记录随时生成，能存成分享图；不装软件也能先[在线看示例报告](https://zhangyukwiver.github.io/DouyinDataReview/#demo)。

### 收费吗？数据会传到哪里？

免费开源。记录和报告都在本机，采集只请求抖音；视频解析会把音轨交给语音识别服务、把文字和画面交给你配置的模型，可选的 AI 助手只把对话和它查到的数据发给你自己配置的模型。

### 会被封号吗？

没法保证。用的接口抖音没有公开承诺，可能触发风控，只在自己的账号上用。

### 打开时提示应用已损坏，或弹出 SmartScreen？

安装包没有开发者签名。macOS 在终端执行一次 `xattr -cr "/Applications/DouyinDataReview.app"`；Windows 点「更多信息」，再点「仍要运行」。

### 提示端口被占用，或要求重新登录？

端口 4765 被占用是旧版还在后台，从托盘点「退出」再打开；要求登录或验证就在首屏点「重新扫码登录」。

## 面向开发者

工作台用 React / React Native / Expo 写，本地采集器是 Node.js，桌面壳是 Electron。采集器用导入的登录会话发签名 HTTP 请求、按游标分页读取记录，聊天和直播弹幕走 WebSocket。

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

- 桌面开发版：`npm run desktop`；打安装包：`npm run desktop:build`（Windows）、`npm run desktop:build:mac`（Apple Silicon）或 `npm run desktop:build:linux`（x64，要先装 nasm），输出到 `release/`。
- 验证：`npm run typecheck`、`npm test`、`npm run build:web`。
- 手机连接：电脑和手机在同一可信局域网时，用 `npm run collector -- --lan --origin http://<手机打开的页面地址>` 启动采集器，手机上把服务地址改成采集器显示的局域网地址。

### 小红书收藏和点赞导出

工作台侧栏「我的 → 小红书」：在页面里扫码登录小红书，选收藏、点赞或两类一起导出，导出完出看板（常看的作者、常见话题、最热的笔记、可搜索的笔记列表）；「推荐 / 搜索 / 主页」页签用登录的账号读首页推荐、搜笔记、看主页，点开一篇看正文和评论。需要本机装有 Chrome（Windows 也可用 Edge），采集器用无头浏览器打开小红书网页，二维码透传到工作台，不弹浏览器窗口。登录状态存在采集器数据目录的 `xiaohongshu/browser-profile`，「退出登录」会删掉它。

也可以直接调接口（只接受本机请求，沿用工作台的 Bearer 配对令牌：本机 `GET /v1/pairing-code` 取配对码，再以 `{"code":"配对码"}` 请求 `POST /v1/pair` 拿 `token`）：

```sh
curl -X POST http://127.0.0.1:4765/v1/xiaohongshu/export \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"lists":["favorites","likes"]}'
```

| 接口 | 作用 |
|---|---|
| `POST /v1/xiaohongshu/export` | 开始导出，`lists` 可只传 `favorites`（收藏）或 `likes`（点赞），省略时两类都导；没登录会先等扫码 |
| `POST /v1/xiaohongshu/login` | 只扫码登录 |
| `GET /v1/xiaohongshu` | 任务进度（`job.state`：starting / login / reading / done / failed / cancelled；等扫码时 `job.qr` 是二维码图片）和上次登录的账号 |
| `GET /v1/xiaohongshu/latest` | 看板数据：每类最近一次导出的笔记 |
| `POST /v1/xiaohongshu/cancel`、`POST /v1/xiaohongshu/logout` | 取消当前任务、退出登录 |

采集器通过本人主页读取网页接口 `GET /api/sns/web/v2/note/collect/page`（收藏）和 `GET /api/sns/web/v1/note/like/page`（点赞），再逐篇打开笔记读正文。导出完成后 `job.file` 是本机 JSON 文件的绝对路径，`lists.favorites.notes` 和 `lists.likes.notes` 包含笔记 ID、标题、作者、类型、封面、链接、赞数和正文；详情页读不到时 `body` 为 `null`，列表翻页失败会让任务失败。导出文件位于采集器数据目录下的 `xiaohongshu/`。

### 小红书内容读取

以下接口和导出共用配对令牌和小红书登录（先扫码登录过），均为 `POST`、JSON 请求体，读完直接返回结果。每次读取在后台开一次无头浏览器，通常 5–12 秒。

| 路径 | 请求体 | 返回数据 |
|---|---|---|
| `/v1/xiaohongshu/feed` | `{}` | 登录账号首页当前加载的推荐笔记，按页面顺序 |
| `/v1/xiaohongshu/search` | `{"keyword":"阅读笔记"}` | 首批搜索结果 `notes` 和平台的 `has_more` |
| `/v1/xiaohongshu/detail` | `{"url":"笔记网页链接"}` | 笔记 ID、标题、正文、作者、作者主页和赞/收藏/评论数 |
| `/v1/xiaohongshu/comments` | `{"url":"笔记网页链接"}` | 首批一级评论：评论 ID、作者、正文、点赞数、回复数及 `has_more` |
| `/v1/xiaohongshu/profile` | `{}` 或 `{"url":"用户主页链接"}` | 默认读本人主页；指定主页时返回昵称、简介、统计和首批已发布笔记 |

例如先搜索，把 `notes[0].url` 原样传给详情或评论接口，再用详情的 `author_url` 读作者主页。链接用 `www.xiaohongshu.com` 的完整网页地址，保留小红书带的 `xsec_token` 参数。列表只读首批，`has_more` 表示平台还有后续。没登录或登录失效返回 `409 xiaohongshu_login_required`；正在登录或导出时返回 `409 xiaohongshu_busy`；同时发起的多个读取会排队依次执行。

## 免责声明

> [!IMPORTANT]
> - 本项目是独立开发的非官方开源工具，与抖音、字节跳动及其关联主体不存在隶属、授权、合作或认可关系，相关名称和商标归其权利人所有。
> - 只能用来处理你本人合法持有或已取得明确授权的数据。请遵守法律法规和平台规则，不要用于他人账号，也别拿它群发或刷屏。
> - 数据目录里存着登录 Cookie 和签名凭据，本地记录含个人隐私，请自行保管，不要分享给他人。
> - 抖音接口或风控策略变化可能导致读取失败、功能失效或账号提醒，本项目不保证持续兼容。
> - 本项目按现状提供，不作任何明示或默示保证；使用产生的损失和后果由使用者自行承担。

## English

**DouyinDataReview is a free, open-source desktop app for exporting and analyzing your own Douyin data on Windows x64, macOS Apple Silicon and Linux x64.** It targets Douyin in China; international TikTok is not supported. It saves watch history, likes, favorites and friend chats locally as JSON, filters your Douyin feed by keyword, and turns videos into transcripts, study notes or shot lists. It also lets you browse your Douyin feed, download videos, chat, check Creator Center stats, watch live streams, and generates rolling reports and a year-in-review ("Douyin Wrapped"). This is an independent, unofficial project; the interface is in Chinese and the source is MIT-licensed. Download it from [Releases](https://github.com/ZhangYukwiver/DouyinDataReview/releases/latest) and see the [export and privacy guide](https://zhangyukwiver.github.io/DouyinDataReview/guide.html).

- **How does it work?** Scan the Douyin login QR code on the first screen, or import credentials from Chrome / Edge / Comet or the Douyin desktop client. A local Node.js collector then reads your records with signed, paginated HTTP requests, and reports are computed on your computer.
- **Can I block videos in my Douyin feed?** Yes. Add keywords in Settings → 推荐流 (Feed); they apply in the app right away, and in Chrome / Edge after installing the extension once.
- **Can it turn a video into notes?** Yes. Click 解析视频 (Analyze video) in the player or library and pick a transcript, study notes or a shot list; notes and shot lists need a model set in Settings → AI.
- **How do I export my watch history?** After reading finishes, click 导出数据 (Export data) in Settings → Data and pick what to save as JSON.
- **Can it read the official Douyin data download?** Yes. Import the JSON or ZIP from 个人信息下载 (personal data download) to build a report without signing in.
- **Is there a Douyin Wrapped?** Yes, built from your own records whenever you want; [preview a demo report](https://zhangyukwiver.github.io/DouyinDataReview/#demo) without installing anything.
- **Is it free and private?** Yes. Records and reports stay on your computer and collection only talks to Douyin. Video analysis sends audio to a speech-recognition service and text or frames to the model you configure; the optional AI assistant sends your messages and the data it looks up only to that model.
- **Limits:** it can only read what Douyin's private APIs currently return for your account, so a complete history and future compatibility are not guaranteed.

## 交流与反馈

| 渠道 | 怎么用 |
| --- | --- |
| [GitHub Issues](https://github.com/ZhangYukwiver/DouyinDataReview/issues) | 报 bug、提需求，公开有记录，遇到过同样问题的人也能回答你 |
| QQ 群「DDDouyin」 | 群号 1124211302，讨论与互助 |
| QQ | 940537208，问题反馈与交流直接联系 |

提问时附上操作步骤和系统版本，能省掉来回追问。

<p align="center"><img src="docs/qq-group.jpg" alt="DDDouyin QQ 群二维码" width="360" /></p>

## 致谢

感谢 [Expo](https://github.com/expo/expo) / [React Native](https://github.com/facebook/react-native) / [react-native-web](https://github.com/necolas/react-native-web)（工作台页面）、[Electron](https://github.com/electron/electron) / [electron-builder](https://github.com/electron-userland/electron-builder)（桌面壳与安装包）、[Playwright](https://github.com/microsoft/playwright)（连接浏览器 CDP 与 HTTP 请求会话）、[lucide](https://github.com/lucide-icons/lucide)（图标）和 [mafqla/douyin-api](https://github.com/mafqla/douyin-api)（评论回复签名，GPL-3.0，固定版本、按原样随安装包附带并保留其许可证）。

## 贡献

欢迎提 [Issue](https://github.com/ZhangYukwiver/DouyinDataReview/issues) 或发 [Pull Request](https://github.com/ZhangYukwiver/DouyinDataReview/pulls)。

<a href="https://github.com/ZhangYukwiver/DouyinDataReview/graphs/contributors"><img src="https://contrib.rocks/image?repo=ZhangYukwiver/DouyinDataReview" alt="Contributors" /></a>

## Star History

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=ZhangYukwiver/DouyinDataReview&type=Date&theme=dark" />
  <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=ZhangYukwiver/DouyinDataReview&type=Date" />
  <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=ZhangYukwiver/DouyinDataReview&type=Date" />
</picture>

<p align="center"><strong>请负责任地使用本工具，遵守相关法律法规。</strong></p>
