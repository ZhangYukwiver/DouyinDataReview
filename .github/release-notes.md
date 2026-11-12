## v1.47.1 导出有提示，持续报告加「近七天」

- 持续报告新增「近七天」卡：七天里每天的观看、聊天和留存，这周常聊的人、常看的博主和博主更新。
- 导出完成后页面底部会提示导出的文件名，几秒后自动消失；导出文件名带上时分秒，同一天导出多次不再重名。
- 「登录凭据已失效」的提示会在括号里写出具体原因，比如登录已失效、登录 Cookie 已过期、账号不一致，方便判断是重新扫码还是换账号。
- 窗口矮、徽章多时，侧栏徽章墙不再盖住「N 天留下记录」。

验证范围：发布流程检查 Windows、macOS 和 Linux 的类型、测试、构建与安装包内容。

## 安装

**macOS（Apple Silicon）**：下载 `DouyinDataReview-<版本>-arm64.dmg`，把「DouyinDataReview」拖进「应用程序」，已采集的数据不受影响。旧版名为「内容数据工作台」，替换时移除旧应用即可，本地数据目录继续沿用。安装包没有开发者签名，首次打开前要在终端执行一次：

```bash
xattr -cr "/Applications/DouyinDataReview.app"
```

不执行会提示应用已损坏。Mac 版没法在应用里自动安装更新，每个新版本都按这个步骤手动替换。

**Windows**：下载 `DouyinDataReview-Setup-<版本>.exe` 安装。出现 SmartScreen 提示时，点「更多信息」，再点「仍要运行」。之后的新版本可以直接在应用里更新。

**Linux（x64）**：Debian / Ubuntu 系下载 `DouyinDataReview-<版本>-amd64.deb`，运行 `sudo apt install ./DouyinDataReview-<版本>-amd64.deb`。其他发行版下载 `DouyinDataReview-<版本>-x86_64.AppImage`，`chmod +x` 后直接运行，打不开时先装 libfuse2。应用里提示有新版本后，回下载页重新下载安装。
