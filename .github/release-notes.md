## v1.50.1 私信发不出去的修复，B 站工作台补齐

- 修复部分账号私信一直提示「抖音没有接收本次消息请求」：发送前查会话资料被拒时，改用接收消息时已拿到的发送票据继续发；仍然发不出去时，提示里会写明卡在哪一步和抖音的回执码。
- 「复制诊断信息」多一行「最近发送失败」，版本号显示应用版本，不再显示成内部组件的版本。
- B 站工作台补上推荐、搜索、热门榜单、视频详情和直播播放，内容库能看在线历史、近期点赞和关注直播；小红书入口先隐藏，已保存的笔记仍可在内容库和专题里查看。
- 移除「档案馆」界面风格和档案馆年度报告，原来选它的会自动换成极简风格。

验证范围：发布流程检查 Windows、macOS 和 Linux 的类型、测试、构建与安装包内容。

## 安装

**macOS（Apple Silicon）**：下载 `DouyinDataReview-<版本>-arm64.dmg`，把「DouyinDataReview」拖进「应用程序」，已采集的数据不受影响。旧版名为「内容数据工作台」，替换时移除旧应用即可，本地数据目录继续沿用。安装包没有开发者签名，首次打开前要在终端执行一次：

```bash
xattr -cr "/Applications/DouyinDataReview.app"
```

不执行会提示应用已损坏。Mac 版没法在应用里自动安装更新，每个新版本都按这个步骤手动替换。

**Windows**：下载 `DouyinDataReview-Setup-<版本>.exe` 安装。出现 SmartScreen 提示时，点「更多信息」，再点「仍要运行」。之后的新版本可以直接在应用里更新。

**Linux（x64）**：Debian / Ubuntu 系下载 `DouyinDataReview-<版本>-amd64.deb`，运行 `sudo apt install ./DouyinDataReview-<版本>-amd64.deb`。其他发行版下载 `DouyinDataReview-<版本>-x86_64.AppImage`，`chmod +x` 后直接运行，打不开时先装 libfuse2。应用里提示有新版本后，回下载页重新下载安装。
