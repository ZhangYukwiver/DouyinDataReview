## v1.49.0 群聊记录能导出，可选范围和成员

- 群聊页新增「导出记录」：选近 7 天、近 30 天、近 90 天或全部，从抖音现读后按发言人勾选（全选 / 只选我），导出文本或 JSON；群消息照旧不存到本机。
- 群聊里往上翻更早的消息时，不会再中途误报「没有更早的消息了」，超过 1000 条也能接着翻。
- 探索里搜索时，抖音翻到后面开始塞和搜索词无关的推荐，会停止加载并提示；刷视频的「想看的词条」也不再混进这类无关视频。

验证范围：发布流程检查 Windows、macOS 和 Linux 的类型、测试、构建与安装包内容。

## 安装

**macOS（Apple Silicon）**：下载 `DouyinDataReview-<版本>-arm64.dmg`，把「DouyinDataReview」拖进「应用程序」，已采集的数据不受影响。旧版名为「内容数据工作台」，替换时移除旧应用即可，本地数据目录继续沿用。安装包没有开发者签名，首次打开前要在终端执行一次：

```bash
xattr -cr "/Applications/DouyinDataReview.app"
```

不执行会提示应用已损坏。Mac 版没法在应用里自动安装更新，每个新版本都按这个步骤手动替换。

**Windows**：下载 `DouyinDataReview-Setup-<版本>.exe` 安装。出现 SmartScreen 提示时，点「更多信息」，再点「仍要运行」。之后的新版本可以直接在应用里更新。

**Linux（x64）**：Debian / Ubuntu 系下载 `DouyinDataReview-<版本>-amd64.deb`，运行 `sudo apt install ./DouyinDataReview-<版本>-amd64.deb`。其他发行版下载 `DouyinDataReview-<版本>-x86_64.AppImage`，`chmod +x` 后直接运行，打不开时先装 libfuse2。应用里提示有新版本后，回下载页重新下载安装。
