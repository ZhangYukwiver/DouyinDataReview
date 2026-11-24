## v1.51.0 B 站工作台：推荐、搜索、播放与账号数据

- B 站进入「刷视频」和「探索」，支持读取首页推荐、浏览热门榜单、搜索作品、UP 主和直播间。
- 作品详情支持播放视频、切换分 P、查看可用字幕、评论和楼中楼。关注的直播开播后可在工作台播放。
- B 站内容库加入在线历史、近期点赞和关注直播，聊天和创作者中心可读取当前操作账号的私信和稿件数据。
- 隐藏小红书的平台切换和账号入口，已保存的笔记仍可在内容库和专题查阅。

验证范围：发布流程检查 Windows、macOS 和 Linux 的类型、测试、构建与安装包内容。

## 安装

**macOS（Apple Silicon）**：下载 `DouyinDataReview-<版本>-arm64.dmg`，把「DouyinDataReview」拖进「应用程序」，已采集的数据不受影响。旧版名为「内容数据工作台」，替换时移除旧应用即可，本地数据目录继续沿用。安装包没有开发者签名，首次打开前要在终端执行一次：

```bash
xattr -cr "/Applications/DouyinDataReview.app"
```

不执行会提示应用已损坏。Mac 版没法在应用里自动安装更新，每个新版本都按这个步骤手动替换。

**Windows**：下载 `DouyinDataReview-Setup-<版本>.exe` 安装。出现 SmartScreen 提示时，点「更多信息」，再点「仍要运行」。之后的新版本可以直接在应用里更新。

**Linux（x64）**：Debian / Ubuntu 系下载 `DouyinDataReview-<版本>-amd64.deb`，运行 `sudo apt install ./DouyinDataReview-<版本>-amd64.deb`。其他发行版下载 `DouyinDataReview-<版本>-x86_64.AppImage`，`chmod +x` 后直接运行，打不开时先装 libfuse2。应用里提示有新版本后，回下载页重新下载安装。
