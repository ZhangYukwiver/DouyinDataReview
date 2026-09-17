<p align="center">
    <img src="build/icon.png" alt="内容数据工作台" width="200" />
</p>

<div align="center">
    <h1>DouyinReview - 抖音本地采集与年度回顾工具</h1>
    <p>本地读取抖音观看、喜欢、收藏与聊天记录并生成持续更新的年度回顾，无界面增量读取，聊天实时接收，探索工作台可搜索用户与内容，档案馆 / 内容年志两套版式，隐私优先，不接外部 AI</p>
    <p>完全本地运行：标题、作者、封面、Cookie 和报告都不会发送到任何外部分析服务。</p>
    <p>问题反馈与交流请联系 QQ：940537208，或加入 QQ 群 DDDouyin（群号 1124211302）。</p>
    <img src="https://img.shields.io/github/v/tag/ZhangYukwiver/DouyinReview" alt="Version" />
    <img src="https://img.shields.io/github/stars/ZhangYukwiver/DouyinReview" alt="Stars" />
    <img src="https://img.shields.io/github/downloads/ZhangYukwiver/DouyinReview/total" alt="Downloads" />
    <img src="https://img.shields.io/github/forks/ZhangYukwiver/DouyinReview" alt="Forks" />
    <a href="#加入群聊"><img src="https://img.shields.io/badge/QQ_Group-1124211302-12B7F5?logo=tencentqq&logoColor=white" alt="QQ Group" /></a>
    <img src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
    <img src="https://img.shields.io/badge/Expo-000020?logo=expo&logoColor=white" alt="Expo" />
    <img src="https://img.shields.io/badge/React_Native-20232A?logo=react&logoColor=61DAFB" alt="React Native" />
    <img src="https://img.shields.io/badge/Electron-47848F?logo=electron&logoColor=white" alt="Electron" />
    <img src="https://img.shields.io/badge/Playwright-2EAD33?logo=playwright&logoColor=white" alt="Playwright" />
</div>

## 年度回顾

两套版式可在应用内一键切换：**档案馆**是深色纸面的应用内分页报告，**内容年志**是纸面、墨色与信号蓝的长卷故事页。下图均为示例数据。

<table>
  <tr>
    <td align="center" colspan="2"><b>档案馆</b>（应用内 12 章分页翻阅）</td>
  </tr>
  <tr>
    <td align="center" colspan="2"><img src="docs/screenshots/report-01.jpg" alt="档案馆 · 入口" width="800"/></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/report-02.jpg" alt="档案馆 · 观测凭证" width="400"/></td>
    <td><img src="docs/screenshots/report-03.jpg" alt="档案馆 · 内容足迹" width="400"/></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/report-04.jpg" alt="档案馆 · 时间轴" width="400"/></td>
    <td><img src="docs/screenshots/report-05.jpg" alt="档案馆 · 你的节拍" width="400"/></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/report-06.jpg" alt="档案馆 · 你如何停留" width="400"/></td>
    <td><img src="docs/screenshots/report-08.jpg" alt="档案馆 · 创作者宇宙" width="400"/></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/report-11.jpg" alt="档案馆 · 意外发现" width="400"/></td>
    <td><img src="docs/screenshots/report-12.jpg" alt="档案馆 · 习惯印章" width="400"/></td>
  </tr>
  <tr>
    <td align="center" colspan="2"><b>内容年志</b>（穿卡入口 + 逐章滚动的长卷）</td>
  </tr>
  <tr>
    <td align="center" colspan="2"><img src="docs/screenshots/story-hero.jpg" alt="内容年志 · 卷首" width="800"/></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/story-sample.jpg" alt="内容年志 · 样本" width="400"/></td>
    <td><img src="docs/screenshots/story-time.jpg" alt="内容年志 · 时间" width="400"/></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/story-kept.jpg" alt="内容年志 · 留下" width="400"/></td>
    <td><img src="docs/screenshots/story-mix.jpg" alt="内容年志 · 组成" width="400"/></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/story-roll.jpg" alt="内容年志 · 高频词条长卷" width="400"/></td>
    <td><img src="docs/screenshots/story-echo.jpg" alt="内容年志 · 聊天回声" width="400"/></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/story-evidence.jpg" alt="内容年志 · 台账与边界" width="400"/></td>
    <td><img src="docs/screenshots/story-signature.jpg" alt="内容年志 · 落款" width="400"/></td>
  </tr>
</table>

## 界面预览

<table>
  <tr>
    <td align="center" colspan="2"><b>连接与采集工作台</b>（自动取配对码连接本机采集器，选择整体风格；左为档案馆，右为内容年志）</td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/setup-archive.png" alt="连接与采集 · 档案馆" width="400"/></td>
    <td><img src="docs/screenshots/setup-trace.png" alt="连接与采集 · 内容年志" width="400"/></td>
  </tr>
  <tr>
    <td align="center" colspan="2"><b>内容库</b>（观看历史、喜欢、收藏按记录展示，视频可下载到本地并在应用内播放）</td>
  </tr>
  <tr>
    <td colspan="2" align="center"><img src="docs/screenshots/records-archive.png" alt="内容库" width="800"/></td>
  </tr>
  <tr>
    <td align="center" colspan="2"><b>聊天</b>（按好友会话展示本地保存的消息，实时接收新消息，群聊只展示统计摘要）</td>
  </tr>
  <tr>
    <td colspan="2" align="center"><img src="docs/screenshots/chat-archive.png" alt="聊天" width="800"/></td>
  </tr>
  <tr>
    <td align="center" colspan="2"><b>持续报告</b>（不用选年份，默认观察最近 30 天并与此前窗口比较；采集结束后自动换新数据）</td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/dashboard-archive.png" alt="持续报告 · 档案馆" width="400"/></td>
    <td><img src="docs/screenshots/dashboard-trace.png" alt="持续报告 · 内容年志" width="400"/></td>
  </tr>
  <tr>
    <td align="center" colspan="2"><b>内容年志入口卡</b>（显示当前观看、喜欢、收藏和聊天条数，穿卡进入故事页）</td>
  </tr>
  <tr>
    <td colspan="2" align="center"><img src="docs/screenshots/story-entry.jpg" alt="内容年志入口卡" width="800"/></td>
  </tr>
</table>

## 功能一览

| 模块 | 能力 |
| --- | --- |
| 增量读取（默认） | 通过无界面接口读取新记录；每个分类首次运行读取全部可见记录并建立增量边界，再次运行只读到本地已知记录为止；本地旧记录不会因平台可见窗口缩短或取消点赞、取消收藏而被删除 |
| 前台自动增量读取 | 连接采集器后默认开启，应用回到前台时复用增量接口更新视频记录；可在设置中暂停，视频同步期间暂停聊天接收、完成后自动恢复，也不在应用关闭后常驻 |
| 完整读取 | 依次定位观看历史、点赞、收藏三个主页面，在真实可滚动区域持续滚动并合并唯一记录，直到接口明确返回末页 |
| 手动监听 | 打开独立浏览器由你自行浏览，采集器只保存监听期间实际出现的受支持网页响应 |
| 聊天实时接收 | 连接采集器后无头整理会话目录和好友历史，工作台显示进度；整理完成后保持连接，新消息自动入库，可随时暂停或重新开始。好友对话保存完整消息字段（含分享评论和内置小表情），群聊只保存群名和统计 |
| 探索 | 复用采集器已有的登录会话搜索用户与内容，不额外启动浏览器；已就绪的手动监听和聊天接收可与搜索并行。查看主页、作品详情和评论，可点赞、收藏、关注、评论并在应用内播放。读取可取消，超时会停止；需要登录或验证时，提示前往手动监听处理 |
| 内容库 | 观看历史 / 喜欢 / 收藏 / 聊天 / 持续报告五个页面；采集进行中也能打开，结束后自动换成新数据；记录卡片可把视频下载到本地并在应用内播放 |
| 持续报告 | 不需要先选年份，也不要求每条记录都有行为时间；默认观察最近 30 天，样本不足时回退 90 天，并与此前窗口比较变化 |
| 年度回顾 | 档案馆：深色纸面的应用内 12 章分页报告；内容年志：穿卡入口 + 逐章滚动的长卷，各章按汇总快照渲染 |
| 整体风格 | 档案馆 / 内容年志一键切换，同时决定采集器页、内容库和报告本体的配色、字体与圆角；选择保存在浏览器本地 |
| 换账号 | 清除独立浏览器中的抖音会话和本地记录，然后等待你登录另一个账号 |
| 文件导入 | JSON / ZIP 作为备用数据源，总结时使用文件中的全部有效记录 |
| 手机连接 | 电脑端启用 LAN 模式后，同一可信局域网内的手机可用一次性配对码连接 |

## 报告章节

| 档案馆（12 章） | 内容年志（9 幕） |
| --- | --- |
| 01 入口 · 02 观测凭证 · 03 内容足迹 · 04 时间轴 | 卷首：把这一年的痕迹，你留下的 |
| 05 你的节拍 · 06 你如何停留 | 样本：一份样本，四种笔迹 |
| 07 内容回声 · 08 创作者宇宙 | 时间：常来的日子，常来的时辰 |
| 09 聊天回声 · 10 交叉洞察 | 留下：三个环的交集，和看完的深度 |
| 11 意外发现 · 12 习惯印章 | 组成：话题、来路，与质地 |
| | 长卷：高频词条 |
| | 回声：九种消息形态，两种边界 |
| | 证据：台账与边界 |
| | 落款：一个正在成形的自己 |

> 报告只使用记录中的显式作者、话题、音乐、时长和平台互动字段，不调用外部 AI 推测兴趣，也不做心理诊断。视频侧的"词条"只取显式话题标签，不做分词；聊天高频词用浏览器内置的 `Intl.Segmenter` 分词并先剔除平台模板消息，群聊正文不参与。

## 加入群聊

也欢迎加入下方 QQ 群「DDDouyin」（群号 1124211302）一起讨论，或直接联系 QQ 940537208。

<p align="center">
    <img src="docs/qq-group.jpg" alt="DDDouyin QQ 群二维码" width="360" />
</p>

## 快速开始

### 1. 下载桌面安装包（推荐）

1. 打开 Release 页面（最新版）：https://github.com/ZhangYukwiver/DouyinReview/releases/latest
2. Windows 下载 `ContentInsights-Setup-<version>.exe`；Apple Silicon Mac 下载 `ContentInsights-<version>-arm64.dmg`
3. 本机需要已安装 Chrome、Edge、Brave、Chromium 或 Comet 中的任意一个（Windows 自带的 Edge 即可）
4. 启动「内容数据工作台」，点击「连接采集器」；首次连接会弹出独立浏览器，在里面登录自己的抖音账号后会自动开始读取

> 安装包只含应用代码、Web 页面和已校验的签名器，不含本地记录、登录状态或浏览器配置。采集记录保存在 macOS 的 `~/Library/Application Support/内容数据工作台/collector/` 或 Windows 当前用户的应用数据目录，升级不会覆盖。
>
> 两个安装包都没有开发者签名。macOS 首次打开前需在终端执行一次 `xattr -cr "/Applications/内容数据工作台.app"`，否则会提示应用已损坏；Windows 可能出现 SmartScreen 提示，选择「更多信息 → 仍要运行」。

### 2. 从源码运行（开发者 / 高级用户）

```bash
git clone https://github.com/ZhangYukwiver/DouyinReview.git
cd DouyinReview
npm install
```

安装并离线校验固定版本的签名器（增量读取需要）：

```bash
npm run direct:setup
npm run direct:check
```

分别启动采集器与 Web 页面：

```bash
npm run collector
```

另开一个终端：

```bash
npm run web
```

打开 `http://localhost:8081`，点击「连接采集器」。页面与采集器在同一台电脑时会自动获取并填入 8 位一次性配对码。

其他开发方式：

- macOS 一键启动：`npm run app:mac` 生成 `抖音年度回顾.app`，双击即可在后台启动采集器和页面；保持它与项目在同一目录，首次打开时允许访问「文稿」文件夹，从 Dock 退出会停止它启动的本地服务。它只伺服 `dist/`，改完源码要先 `npm run build:web`。
- Windows 桌面开发版：`npm run desktop` 会构建 Web 页面并启动 Electron 和仅监听本机的内置采集器。
- 进程看护：`npm run watch:process -- npm run web` 按秒采样子进程树，CPU 持续超过 500% 或 RSS 超过 2 GB 时自动停止。
- 验证：`npm run typecheck`、`npm test`、`npm run build:web`。

### 3. 使用流程

1. 点击「连接采集器」。应用从本机采集器自动获取一次性配对码并完成连接，默认在前台自动读取新记录，也可以手动点「增量读取」。
2. 首次连接时如果专用浏览器还没登录，会自动开始一次完整读取并弹出独立浏览器；登录后自动继续，随后自动整理聊天历史并保持实时接收。
3. 进入内容库，在观看历史、喜欢、收藏、聊天和持续报告之间切换；采集进行中也可以打开报告，结束后会提示「报告有更新」。
4. 在「03 · 整体风格」里选择档案馆或内容年志，然后点「打开报告」。内容年志会先把一份汇总快照（条数、按天与按小时的分布、交集、话题与创作者排行、聊天形态、高频词条等，不含原始记录、Cookie 或 Token）写入浏览器本地，再以应用内同源页面打开入口卡；「清除本地记录」会一并删掉这份快照。
5. 内容年志的源文件在 `prototype/`，改完运行 `npm run sync:story` 同步到 `public/story/`（`npm run build:web` 会自动同步）。

## 打包安装包

### Windows（NSIS 安装器）

```bash
npm run desktop:build
```

输出到 `release/ContentInsights-Setup-<version>.exe`，带桌面和开始菜单快捷方式。

### macOS（DMG）

```bash
npm run desktop:build:mac
```

在 Apple Silicon Mac 上输出 `release/ContentInsights-<version>-arm64.dmg`。没有 Apple 开发者签名时会做 ad-hoc 签名，收件人首次打开前仍需执行上面的 `xattr -cr`。

## 采集原理与边界

**为什么还会滚动页面。** 抖音网页接口由抖音自己的页面脚本携带当前登录状态和签名发起。采集器只监听这些网页响应，不直接伪造 Cookie、`a_bogus`、`X-Bogus` 或其他私有签名。因此完整读取需要在正确列表的真实可滚动区域中滚动，触发网页加载下一批数据，直到接口明确返回末页。若页面无法继续滚动、游标不前进或响应重复，本次列表会标记为不完整，并保留已有完整数据。完整读取不会绕过验证码或安全提示；页面结构或响应格式变化时会返回明确错误，不会把无法读取误报为空列表。

**无界面增量读取。** 复用专用 Profile 的登录态，使用真正的 Chrome 无头模式，不弹窗口、不出现在任务栏。观看历史逐页直接请求接口；点赞和收藏由抖音页面运行时生成当前签名并在后台自动滚动。每个分类完成后立即合并保存，后续分类失败不会撤销已完成分类。签名器来自 `mafqla/douyin-api@42987a1`，安装时逐文件校验 SHA-256 并保存在已忽略的 `.local-data/direct-signer/`；macOS 用系统沙箱禁止签名进程联网和写文件，Windows 用 Node 权限模型禁止写文件、创建子进程和 Worker。页面初始化时的单次 401/403 会继续等待同次加载中的有效响应；遇到游标异常、重复页、429 或非零平台状态时，当前分类不保存不完整结果。

**时间字段口径。** 观看日期优先读取响应中的逐作品 `aweme_date` 映射并兼容 `history_info.view_time`；喜欢和收藏日期统一读取 `play_progress.last_modified_time`；两者缺失时保持为空，不会用发布时间或采集时间替代。观看进度优先用 `play_progress.play_progress` 与视频时长计算，采集器不会按进度阈值丢弃可识别记录。

**当前边界。**

- 增量读取走的是未经抖音公开文档承诺的私有接口，可能失效或触发账号风控；当前仅用于本机个人账号，不应作为公开、多用户或商业服务。
- 报告描述的是网页或接口当前可见并成功读取的记录，不保证覆盖抖音服务端未提供的更早历史。
- 暂不包含直播或影视综历史、收藏夹深度遍历、截图分享、PNG / PDF 导出。
- Web 端提供持续报告、记录、聊天和数据源页面；原生端暂时只保留记录和数据源。

## 本地接口与隐私

- 本地服务默认监听 `127.0.0.1:4765`。
- `/v1/health` 用于健康检查，`/v1/pairing-code` 仅向本机回环连接返回一次性配对码，`/v1/pair` 完成配对，`/v1/sync` 启动完整页面同步，`/v1/sync/stop` 停止当前读取；`/v1/chat/observe` 开始聊天实时接收，`/v1/chat/observe/stop` 暂停接收；`/v1/explore/*` 只在你点击探索页操作时才复用后台会话搜索、读取或互动。工作台取视频、读评论与探索页面会预先禁止远端自动播放并拦截观看历史写入，播放发生在应用内。
- `/v1/experimental/records-direct` 只允许本机回环连接，启动默认增量读取使用的观看历史直读及点赞、收藏无界面采集。
- 12 小时会话 Token 只保存在应用内存和请求头中，不进入 URL 或本地存储。
- 独立浏览器配置保存在 `.local-data/browser-profile/`；直接读取模板保存在 `.local-data/direct-history-template.json`，只含 UA、`webid` 和白名单参数；归一化记录保存在 `.local-data/records.json`。
- 原始响应、请求头、Cookie、签名和完整诊断 URL 不会写入记录文件。
- 应用中的「清除本地记录」只删除本地归一化记录和汇总快照，不会清除登录状态，也不会修改抖音账号里的观看、点赞或收藏状态。

## 手机连接

电脑和手机需位于同一可信局域网。电脑端显式启用 LAN 模式，并在 Web 页面从局域网访问时传入实际页面来源：

```bash
npm run collector -- --lan --origin http://192.168.1.20:8081
```

应用中把服务地址改为采集器显示的局域网地址，例如 `http://192.168.1.20:4765`。LAN 模式仍使用一次性配对码和内存会话，但流量是局域网 HTTP，只应在可信网络使用。

## 安全说明

**重要提醒**：

1. **仅限个人使用**：此工具只读取你本人登录账号当前可见的记录，请勿用于他人账号
2. **登录态安全**：独立浏览器配置目录保存着抖音登录 Cookie，请妥善保管，不要拷贝或分享给他人
3. **数据隐私**：本地记录和聊天快照包含个人隐私信息，请谨慎处理；仓库和安装包本身不含任何数据
4. **合法使用**：请遵守相关法律法规和平台规则，不得用于非法目的

## 免责声明

请在充分理解以下内容，并自愿承担相应责任的前提下使用本项目：

1. **项目性质**

   本项目为独立开发的非官方开源工具，与抖音、字节跳动及其关联主体不存在隶属、授权、合作或认可关系。相关产品名称和商标归其权利人所有。

2. **合法使用**

   本项目仅可用于处理使用者本人合法持有、管理或已经取得明确授权访问的数据。使用者应遵守适用的法律法规、软件许可协议、平台规则和隐私保护义务。

3. **数据与备份**

   使用过程涉及本地记录、浏览器登录态、聊天快照和下载的视频文件。开始前请备份重要数据，并自行负责登录态保管、数据安全和隐私保护。

4. **兼容性与运行风险**

   抖音页面结构、接口格式或风控策略变化，可能导致读取失败、功能失效、账号提醒或其他不可预期结果。本项目不保证对未来抖音版本持续兼容。

5. **责任范围**

   本项目按现状提供，不对功能的准确性、完整性、稳定性或持续可用性作出明示或默示保证。在适用法律允许的范围内，因使用、误用、版本不兼容、操作中断或第三方策略变化产生的损失和后果，由使用者自行承担。

使用或继续使用本项目，即表示使用者已经阅读、理解并同意以上内容，并愿意对自己的操作及其结果负责。

## 致谢

1. **[mafqla/douyin-api](https://github.com/mafqla/douyin-api)** — 固定版本签名器
2. **[Expo](https://github.com/expo/expo)** / **[React Native](https://github.com/facebook/react-native)** / **[react-native-web](https://github.com/necolas/react-native-web)**
3. **[Electron](https://github.com/electron/electron)** / **[electron-builder](https://github.com/electron-userland/electron-builder)**
4. **[Playwright](https://github.com/microsoft/playwright)**
5. **[lucide](https://github.com/lucide-icons/lucide)**

## 贡献

欢迎提交 Issue 和 Pull Request 来改进这个项目。
