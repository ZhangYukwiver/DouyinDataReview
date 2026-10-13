<div align="center">
  <a href="https://github.com/ZhangYukwiver/DouyinDataReview/releases/latest"><img src="build/icon.png" alt="内容数据工作台" width="160" /></a>
  <h1>DouyinDataReview | 抖音内容数据工作台</h1>
  <p><strong>把你的抖音数据，留在自己的电脑上</strong></p>
  <p>DouyinDataReview（内容数据工作台）是一个<strong>免费开源</strong>的抖音数据采集桌面应用：把你自己的抖音观看历史、喜欢、收藏和聊天记录读到本机离线保存，聊天可实时接收，还能续火花、批量下载视频；<br>
  同时在工作台里看自己的创作者中心数据（数据总览、作品数据、粉丝画像、评论分析）和抖音热点榜、抖音指数；攒够了数据，也能随时生成抖音年度报告。支持 Windows 和 macOS，MIT 许可。</p>
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

> **先看什么？** 想安装，直接打开[最新 Release](https://github.com/ZhangYukwiver/DouyinDataReview/releases/latest)；想了解实现，查看[面向开发者](#面向开发者)；想比较另一种视觉风格，继续看下面的[年度回顾](#年度回顾)。

> [!NOTE]
> 登录凭据导入支持 Chrome 144+、提供远程调试开关的 Edge，以及 macOS Comet。导入成功后，凭据有效时可关闭调试及浏览器；失效后重新连接并导入。无需安装扩展，不再启动专用浏览器。工具只读取你本人登录账号在网页端当前可见的记录；采集使用抖音未公开承诺的私有接口，可能失效或触发账号风控，只用于本机个人账号。

## 主要功能

- 本地读取观看历史、喜欢、收藏和聊天记录，默认无界面增量更新；关掉窗口后留在托盘（macOS 菜单栏）里，每 3 小时补读一次，可选开机后台运行；能存多个抖音账号，各自的登录和记录分开放，随时切换
- 聊天实时接收，能直接回复好友和群、看好友在线状态；续火花看板读抖音官方火花天数，还能一键给勾选的人续火花
- 内容库按记录浏览，能按标题、作者、话题或音乐搜索，看过的直播单独一栏；视频可下载到本地、在应用内播放，播放时能看评论、发评论、转发给好友
- 创作者中心：在工作台里看自己账号的数据总览、作品数据、粉丝数据与画像，以及每条作品的流量、观众和评论分析，字段和抖音创作者中心网页一致；只读
- 探索工作台：复用登录会话搜索用户与内容，可点赞、收藏、关注、评论；进用户主页能下载作品，也能多选批量打包成 ZIP；首页显示抖音实时热点和飙升热点两个榜，点一个热点就去搜它；进用户主页还会显示 TA 在抖音指数里的达人详情：新增点赞、涨粉这些核心指标和逐日趋势、近 30 天作品、粉丝画像（读的是创作者平台里的官方数据，只读）
- 视频解析（可选功能）：内容库和探索页的视频点「解析」，用 AI 拆解选题、开头钩子、内容结构、画面声音和可复用的拍法，结果存进侧栏「解析库」，能搜索。要自备解析用大模型的 API Key（可填支持视频输入的 OpenAI 兼容接口），视频会发给你填的这个接口。Windows 安装时勾选、Mac 第一次打开时选，之后也能在「设置」里安装或移除
- 在工作台里看直播：弹幕实时滚动，能调透明度、字号、速度、显示区域和屏蔽词；直播页顶上列出关注的人谁正在播。只看不发，不发弹幕、不送礼物、不点赞
- 界面默认是白底细线的极简风格；「设置」里集中放着界面风格、自动补读、隐私模式、账号、导出清除、可选功能和应用更新
- 持续报告：默认看最近 30 天，和上一段比较变化
- 年度回顾：内容年志、档案馆和海报三种风格，读的是同一份本地汇总；可导出独立 HTML 报告和 1080 × 1440 的 PNG 分享图

### 本次改造

v1.13.0 统一使用日常浏览器的 CDP 凭据导入：核对账号后一次性导出 Cookie、接口参数和签名凭据，成功后自动断开连接。有效凭据按账号保存，重启工作台也可继续使用；凭据失效或平台要求验证时，再由本人完成登录或验证并重新导入。专用浏览器及网页手动监听入口已移除。

v1.13.1 修复未登录浏览器连接后过早关闭的问题：连接后会等待本人登录，最多五分钟，可手动取消。观看、点赞和收藏仍通过接口分页读取，不滚动页面。

v1.13.3 在未开启调试时尝试自动打开所选浏览器的调试设置页，本人开启开关后再次连接。每次成功导入登录凭据后，都会自动执行一次完整读取，更新观看历史、喜欢和收藏。这一次读取不受「自动补读新记录」开关影响，可在采集器页面停止。

记录采集、搜索与互动、创作者中心、视频解析与下载通过 HTTP 接口完成，聊天和直播弹幕通过 WebSocket 接收；完整和增量读取均不要求滚动网页。源码运行和桌面版共用静态服务的媒体策略，允许播放本机采集器提供的视频。

2026 年 10 月 12 日已在 macOS 本地实测 Chrome 凭据导入、断开 CDP 并关闭调试后读取观看／喜欢／收藏，以及重启采集器后复用凭据；本地模拟短期令牌过期验证了重新导入提示，该模拟不代表自然失效周期。移除旧入口后通过页面验收，旧记录保持不变。本轮 CDP 验证未发消息或互动。

此前 HTTP／WebSocket 改造已在 macOS 实测完整及重复增量读取、账号切换、批量 ZIP、导出导入、一键发送、真实 AI 解析、报告与设置。一键发送成功不等于火花天数已经增加；跨天增长仍需双方在真实日期内持续互聊，再以抖音官方状态确认。Windows 构建校验与真实设备登录验收分别报告。

## 年度回顾

在「设置」的「界面风格」里挑一种，再点「打开报告」。风格同时决定采集器页和工作台的样子；默认的极简风格只管这两页，没有单独的报告页，打开报告时用设置里选的一套。

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

连接与采集页点「连接采集器」会自动取配对码；内容库的卡片可以下载视频、在应用内播放；聊天页的新消息实时进来，列表头的火苗按钮打开续火花看板，群聊打开时从抖音接口现读消息；创作者中心里能看数据总览、作品数据、粉丝数据和粉丝画像，字段和抖音创作者中心网页一致。

</details>

## 支持平台与设备

| 平台 | 设备 / 架构 | 安装包 |
| --- | --- | --- |
| Windows | x64 | `DouyinDataReview-Setup-<version>.exe`（NSIS 安装器） |
| macOS | Apple Silicon（arm64） | `DouyinDataReview-<version>-arm64.dmg` |

两个安装包都没有开发者签名，首次打开的处理方式见下面「快速开始」。手机端通过同一局域网连接电脑上的采集器使用，见[面向开发者](#面向开发者)末尾的[手机连接](#手机连接)小节。

## 快速开始

1. 打开[最新 Release](https://github.com/ZhangYukwiver/DouyinDataReview/releases/latest)，按上表下载对应安装包。

   **macOS 首次打开前需在终端执行一次 `xattr -cr "/Applications/内容数据工作台.app"`，否则会提示应用已损坏；Windows 可能出现 SmartScreen 提示，点「更多信息」，再点「仍要运行」。**

2. 启动「内容数据工作台」，点击「连接采集器」。应用会从本机采集器自动取一次性配对码完成连接，之后默认在前台自动读取新记录，也可以手动点「增量读取」。关掉窗口应用会留在托盘里接着每 3 小时读一次，要完全退出就在托盘图标的菜单里点「退出」。
3. 首次使用请在「设置 → 账号」连接已登录抖音的 Chrome、Edge 或 macOS Comet，核对昵称并导入凭据。导入成功后自动断开 CDP，并完整读取一次观看历史、喜欢和收藏，可以关闭浏览器。凭据失效时重新连接并导入。
4. 进入内容库，在观看历史、喜欢、收藏、聊天和持续报告之间切换；在「设置」里换界面风格、选报告用哪一套，点「打开报告」看年度回顾。

### 导入已有浏览器登录凭据

在「设置 → 账号 → 导入浏览器登录凭据」选择 Chrome、Edge 或 macOS 的 Comet，点击「连接浏览器」。尚未开启远程调试时，工作台会自动打开所选浏览器的调试设置页；本人勾选允许远程调试后，再次点击「连接浏览器」。自动打开失败时，可在对应浏览器中手动访问 `chrome://inspect/#remote-debugging`、`edge://inspect/#remote-debugging` 或 `comet://inspect/#remote-debugging`。浏览器弹出确认框时本人允许连接；尚未登录抖音时，工作台会尝试打开登录框，未弹出时可在新开的抖音页面点击「登录」。工作台会保留页面并等待最多 5 分钟，登录成功后自动显示账号，等待期间可点击「取消连接」。核对应用显示的抖音昵称后点击「确认导入」。工作台会导出 Cookie、接口参数和配套签名凭据，成功后自动断开 CDP，并立即完整读取一次观看历史、喜欢和收藏；此后可关闭调试开关及浏览器。已有账号会复用自己的记录目录，首次连接的其他账号会单独保存。每次成功导入都会触发这一次完整读取，包括重新导入已有账号的凭据；取消连接或导入失败不会触发。首次使用或添加账号也使用此入口，不再启动专用浏览器。

Chrome 的现有实例连接方式需要 144 或更新版本；Edge 需要提供远程调试开关的版本。工作台自动检测默认安装的稳定版用户目录和有效本机调试端口，并核对监听进程属于该浏览器，避免旧端口文件接到另一个实例；自定义用户目录、其他浏览器渠道和 Firefox 暂不支持此入口。无需安装浏览器扩展，也无需手填端口。

远程调试授权覆盖整个浏览器实例；工作台只读取抖音域 Cookie，并仅在自己创建的抖音标签页初始化凭据，不清理日常浏览器缓存、不修改原有标签页。凭据有效时，接口读取和实时接收不依赖 CDP，重启工作台也可继续使用已导入的凭据。读取仍使用 HTTP 分页，不要求滚动页面。断开连接、切换账号或退出应用只清理工作台创建的标签页并断开调试连接，保留浏览器进程。调试开关需由本人在浏览器中关闭。短期令牌过期、登录失效或平台要求验证时，工作台会提示重新连接浏览器并导入，不会自动启动专用浏览器兜底；凭据有效期由抖音控制，不保证固定时长。专用浏览器和网页手动监听已移除，未导入凭据时也不会自动弹出登录窗口。

> 安装包只含应用代码、Web 页面和已校验的签名器，不含本地记录、登录状态或浏览器配置。采集记录保存在 macOS 的 `~/Library/Application Support/内容数据工作台/collector/` 或 Windows 当前用户的应用数据目录，升级不会覆盖。
>
> 桌面版启动后会检查 GitHub Release。Windows 可在「设置」里下载并「重启并安装」，采集进行中不会自动重启；macOS 使用设置里的下载入口，手动替换应用。

出了问题，先看[常见问题](#常见问题)；要从源码跑、自己打包或用手机连，看[面向开发者](#面向开发者)。

## 本地数据与接口

<details>
<summary>数据放在哪、本地接口和不落盘的内容（点击展开）</summary>

### 数据放在哪

从源码运行时数据在项目里的 `.local-data/`（已被 git 忽略）；桌面版在 macOS 的 `~/Library/Application Support/内容数据工作台/collector/` 或 Windows 当前用户的应用数据目录。

- 旧版的 `.local-data/browser-profile/` 不再使用；升级保留原目录和已有记录，不会自动删除
- 代码请求登录会话：`.local-data/direct-session.json`，从本人确认连接的日常浏览器导出，按账号隔离并以仅当前用户可读写的权限保存；不包含在安装包中
- 浏览器来源：每个账号目录中的 `external-browser.json` 只记录浏览器类型，不包含连接地址或凭据；重启后复用该账号已导入的有效凭据，失效时才要求重新连接，不会自动改用另一个浏览器的登录态
- 直接读取模板保存在 `.local-data/direct-history-template.json`，只含浏览器标识和白名单查询参数，不含 Cookie。签名器位于 `.local-data/direct-signer/`，所有账号共用，桌面安装包已内置校验版本。
- `.local-data/records.json` 保存归一化记录；新增账号各自保存在 `.local-data/accounts/<12 位编号>/`，账号列表在 `.local-data/accounts.json`。
- 内容年志只把汇总快照写入浏览器本地，不含原始记录、Cookie 或 Token。
- 「清除本地记录」只删除当前账号的归一化记录和汇总快照，不清除登录状态，也不修改抖音账号里的观看、点赞或收藏状态。

### 本地接口

本地服务默认监听 `127.0.0.1:4765`。

- 配对与采集：`/v1/health`、`/v1/pairing-code`、`/v1/pair`、`/v1/sync*`、`/v1/experimental/records-direct`；完整和增量读取均通过 HTTP 分页，配对码和增量读取接口仅允许本机回环连接。
- 记录与账号：`/v1/status`、`/v1/records*`、`/v1/accounts*`；支持按账号操作，切换冲突时返回 `409`。
- 聊天与探索：`/v1/chat/*`、`/v1/explore/*`；聊天通过 HTTP 整理历史、WebSocket 实时接收，发消息和转发走 IM 接口，其他探索操作走 HTTP；发送由用户触发并校验回执，结果不明时不自动重发。
- 创作者与直播：`/v1/creator/read`、`/v1/live/*`；按需通过 HTTP 查询，直播弹幕通过 WebSocket 接收，正在直播的关注列表缓存 30 秒；群聊、火花和直播数据不写入记录文件。
- 视频与解析：`/v1/downloads*`、`/v1/analyses*`；下载和播放由用户触发。解析时最低清晰度视频及提示词会发送到你配置的解析用大模型接口，结果存入 `analyses.json`，API Key 不落盘；播放地址使用独立密钥。
- 浏览器凭据：`/v1/browser/sources`、`/v1/browser/connect`、`/v1/browser/confirm`、DELETE `/v1/browser/pending`、`/v1/browser/disconnect`；仅本机可用，未登录时等待最多五分钟，取消请求会释放连接；登录后预览账号，本人确认才导出凭据并自动断开，成功后启动一次完整读取；待确认连接两分钟后释放，断开连接保留有效凭据及接口任务。

代码请求复用当前账号导入的登录会话。CDP 导入时一次性导出 Cookie、请求参数、签名密钥和设备凭据，之后记录、聊天、互动、创作者中心和直播都走 HTTP 或 WebSocket。直播弹幕只在内存保留最近 300 条。没有凭据、短期令牌过期或需要验证时，提示本人在所选浏览器中完成登录或验证并重新导入，不启动后台浏览器。

应用内取视频、读评论和用探索页时，会先禁止远端自动播放并拦截观看历史写入，视频只在应用内播放。

### 不落盘的内容

- 12 小时会话 Token 只保存在应用内存和请求头中，不进入 URL 或本地存储。
- 原始响应、请求头、Cookie、签名和完整诊断 URL 不会写入记录文件。
- 群聊消息和官方火花数据都是用的时候通过 IM 接口现读，不写入记录文件。
- 直播弹幕只在采集器内存里留最近 300 条，退出直播间就没了。

</details>

## 常见问题

### 有没有像 Spotify Wrapped 那样的抖音年度报告？

有。DouyinDataReview 用你本机保存的观看、喜欢、收藏和聊天记录生成抖音年度报告，不用等平台发，随时都能打开，还能存成 3:4 的分享图。报告有内容年志、海报等几种视觉风格，不装软件也可以先[在线看示例报告](https://zhangyukwiver.github.io/DouyinDataReview/#demo)（里面是编出来的演示数据）。

### 怎么导出抖音观看历史和聊天记录？

装好 DouyinDataReview，连上采集器并登录抖音网页版，等读取完成后在「设置」里点「导出数据」。观看历史、喜欢、收藏和好友聊天记录会一起存成一个 JSON 文件。换电脑时在新电脑的采集器页「选择文件」导入，再点「并入本机记录」就能接着用。群聊消息是打开时从接口现读的，不在导出文件里。

### 已经用抖音官方「个人信息下载」导出过数据，能直接用吗？

能。在采集器页「或者导入个人档案」那里点「选择文件」，选官方导出的 JSON 或 ZIP，就能用这份档案生成报告，不用登录。导入的文件只在这次打开时读取，关掉应用后要重新导入。

### 能批量下载抖音里喜欢和收藏的视频吗？

能。内容库里点「批量下载」进入多选，选好的视频会打包成 ZIP 存到本机；探索页进到某个用户的主页，也能单条或多选下载这个用户的作品。图文作品会下载全部图片。

### 收费吗？数据会传到哪里？

免费，源码以 MIT 许可开源。采集记录和年度报告在本机处理，不发送到统计或分析服务。可选的「视频解析」只有在你主动点「解析」时，才会把选中的视频、公开作品资料和提示词发给你配置的 AI 接口；不会把抖音登录 Cookie 或整份个人记录发给 AI。API Key 保存在当前设备的浏览器配置里，采集器只在本次请求中使用。

### 会被封号吗？

没法保证不会。工具用的是你自己在抖音网页版登录的会话，读的是你本人能看到的记录；但增量读取走的是抖音没有公开承诺的接口，可能失效，也可能触发风控。建议只在自己的账号上用，别拿它批量操作别人的账号或群发消息。

### macOS 打开时提示应用已损坏？

安装包没有开发者签名。在终端执行一次 `xattr -cr "/Applications/内容数据工作台.app"`，再打开就行。

### Windows 弹出 SmartScreen？

点「更多信息」，再点「仍要运行」。

### 首次使用如何登录？

在 Chrome、Edge 或 macOS Comet 中开启远程调试，再到「设置 → 账号」连接浏览器；未登录时，在新开的抖音页面完成登录，工作台会等待并自动继续，核对账号后确认导入凭据。采集器本身可在没有浏览器可执行文件时启动；凭据导入需要受支持且已开启远程调试的浏览器，成功后可关闭。

### 提示「采集器端口 4765 已被占用」？

通常是旧实例仍在后台运行。先从旧版的托盘或菜单栏选择「退出」，再启动新版；从源码运行时，也要停止之前启动的采集器。只关闭窗口可能仍会留在后台，不需要删除本地记录或登录配置。

### 已连接却提示需要导入凭据或读取配置不完整？

在「设置 → 账号」重新连接已登录的浏览器并确认导入。导入会建立 HTTP 分页所需的请求参数，成功后自动完整读取一次。升级保留本地记录，旧版已有完整且有效的凭据也可以继续使用。

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

# 2. 安装并离线校验固定版本的签名器（增量读取需要）
npm run direct:setup
npm run direct:check

# 3. 启动采集器（终端 A）
npm run collector

# 4. 启动 Web 页面（终端 B），然后打开 http://localhost:8081 点「连接采集器」
npm run web
```

页面与采集器在同一台电脑时会自动获取并填入 8 位一次性配对码。

其他开发方式：

- macOS 一键启动：`npm run app:mac` 生成 `抖音年度回顾.app` 并启动采集器和页面；启动时会重建页面，修改 `prototype/` 后需运行 `npm run sync:story`。
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

DouyinDataReview is a local-first desktop app for Windows and macOS that works with Douyin, the Chinese version of TikTok. It reads your own watch history, likes, favorites and chat messages using your Douyin login session, keeps these records on your computer, and turns them into a rolling report and a year-in-review (a "Douyin Wrapped"). You can also export all records as JSON, receive chats in real time, keep chat streaks going, play and download videos, and view your Creator Center stats read-only. Optional video analysis sends the selected video, its public metadata and a prompt to the AI endpoint you configure. The interface is in Chinese. Get the installer from [Releases](https://github.com/ZhangYukwiver/DouyinDataReview/releases/latest).

Since v1.13.0, sign in to Douyin in Chrome 144+, an Edge version with the remote debugging toggle, or Comet on macOS. In Settings → Account, connect, check the account name, and confirm the credential import. In v1.13.3, connecting before remote debugging is enabled attempts to open the selected browser's debugging settings; enable the toggle and connect again. If opening fails, use the displayed settings URL. The app disconnects automatically after exporting the complete credentials, then reads watch history, likes and favorites once in full. You can turn off debugging and close the browser; valid credentials work through HTTP and WebSocket, including after an app restart. If they expire or Douyin requires verification, reconnect and import again. No extension, dedicated browser or manual page-listening mode is required. Firefox, custom user-data directories and other browser channels are not supported.

Since v1.13.1, an unsigned-in browser connection stays open while you sign in (up to five minutes, with a cancel option). The current source automatically starts one full read of watch history, likes and favorites after every successful credential import, even when automatic incremental reading is disabled. You can stop the read from the collector page. Records are still read through paginated APIs without scrolling the page.

- **Is there a Douyin Wrapped?** DouyinDataReview builds a Wrapped-style year-in-review from your own records on your computer, any time you want; you can [preview a demo report](https://zhangyukwiver.github.io/DouyinDataReview/#demo) in the browser without installing anything.
- **How do I export my Douyin watch history?** Install DouyinDataReview, connect the collector, and import credentials from your signed-in browser in Settings → Account. A full read starts automatically after import. After it finishes, click 导出数据 (Export data) in Settings. Watch history, likes, favorites and friend chats are saved to one JSON file.
- **Can it read the official Douyin data download?** Yes. Import the JSON or ZIP from Douyin's 个人信息下载 (personal data download) to generate a report without signing in.
- **Is it free and private?** Yes. It is MIT-licensed. Personal records and reports stay on your computer. Optional video analysis sends only the selected video, public metadata and a prompt to your configured AI endpoint; it does not send your Douyin login cookies or complete personal records. The API key stays in this device's browser configuration and is used by the collector only for the requested analysis.

## 交流与反馈

| 渠道 | 怎么用 |
| --- | --- |
| [GitHub Issues](https://github.com/ZhangYukwiver/DouyinDataReview/issues) | 报 bug、提需求，公开有记录，遇到过同样问题的人也能回答你 |
| QQ 群「DDDouyin」 | 群号 1124211302，讨论与互助 |
| QQ | 940537208，问题反馈与交流直接联系 |

提问前先看一遍[常见问题](#常见问题)，并附上出问题时的操作步骤和系统版本，能省掉来回追问。

<p align="center"><img src="docs/qq-group.jpg" alt="DDDouyin QQ 群二维码" width="360" /></p>

## 致谢

1. **[mafqla/douyin-api](https://github.com/mafqla/douyin-api)** — 固定版本签名器
2. **[Expo](https://github.com/expo/expo)** / **[React Native](https://github.com/facebook/react-native)** / **[react-native-web](https://github.com/necolas/react-native-web)** — 工作台页面与原生端
3. **[Electron](https://github.com/electron/electron)** / **[electron-builder](https://github.com/electron-userland/electron-builder)** — 桌面壳与安装包
4. **[Playwright](https://github.com/microsoft/playwright)** — 连接已授权的浏览器 CDP，并提供 HTTP 请求会话
5. **[lucide](https://github.com/lucide-icons/lucide)** — 图标

没有这些项目，这个工具做不出来，谢谢他们。

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
