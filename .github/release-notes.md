## v1.50.0 小红书的收藏和点赞能导出，还能看推荐、搜笔记

- 侧栏「我的 → 小红书」：在页面里扫码登录小红书，选收藏、点赞或两类一起导出，导完出看板（常看的作者、常见话题、最热的笔记，笔记能搜）。需要电脑上装有 Chrome，Windows 也可以用 Edge。
- 同一页还能看小红书首页推荐、搜笔记、翻自己和别人的主页，点开一篇看正文、赞藏评论数和评论。
- 设置「关于」页加了「复制诊断信息」，反馈问题时一键复制版本、系统和采集器状态，不含账号昵称和登录信息。
- 读取观看历史、点赞、收藏时碰上抖音限流，会等一阵再接着读，不再整次停下。
- 添加账号或换号扫码时，不会再先弹出已有账号的「确认导入」。

验证范围：发布流程检查 Windows、macOS 和 Linux 的类型、测试、构建与安装包内容。

## 安装

**macOS（Apple Silicon）**：下载 `DouyinDataReview-<版本>-arm64.dmg`，把「DouyinDataReview」拖进「应用程序」，已采集的数据不受影响。旧版名为「内容数据工作台」，替换时移除旧应用即可，本地数据目录继续沿用。安装包没有开发者签名，首次打开前要在终端执行一次：

```bash
xattr -cr "/Applications/DouyinDataReview.app"
```

不执行会提示应用已损坏。Mac 版没法在应用里自动安装更新，每个新版本都按这个步骤手动替换。

**Windows**：下载 `DouyinDataReview-Setup-<版本>.exe` 安装。出现 SmartScreen 提示时，点「更多信息」，再点「仍要运行」。之后的新版本可以直接在应用里更新。

**Linux（x64）**：Debian / Ubuntu 系下载 `DouyinDataReview-<版本>-amd64.deb`，运行 `sudo apt install ./DouyinDataReview-<版本>-amd64.deb`。其他发行版下载 `DouyinDataReview-<版本>-x86_64.AppImage`，`chmod +x` 后直接运行，打不开时先装 libfuse2。应用里提示有新版本后，回下载页重新下载安装。
