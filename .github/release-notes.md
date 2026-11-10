## v1.45.0 新增 Linux 版

- 新增 Linux x64 版：Debian / Ubuntu 系下载 .deb，其他发行版下载 .AppImage，安装包自带转码工具。
- 和 Windows、macOS 版相比，Linux 版暂时没有「开机后在后台运行」，也不能读抖音电脑客户端的登录态（抖音没有 Linux 客户端）；有新版本时应用里会提示，回下载页重新下载安装。
- Windows 和 macOS 版本次没有功能变化。

验证范围：发布流程检查 Windows、macOS 和 Linux 的类型、测试、构建与安装包内容；Linux 版另在无头环境里启动过一次，还没在各发行版的桌面上逐一试过。

## 安装

**macOS（Apple Silicon）**：下载 `DouyinDataReview-<版本>-arm64.dmg`，把「DouyinDataReview」拖进「应用程序」，已采集的数据不受影响。旧版名为「内容数据工作台」，替换时移除旧应用即可，本地数据目录继续沿用。安装包没有开发者签名，首次打开前要在终端执行一次：

```bash
xattr -cr "/Applications/DouyinDataReview.app"
```

不执行会提示应用已损坏。Mac 版没法在应用里自动安装更新，每个新版本都按这个步骤手动替换。

**Windows**：下载 `DouyinDataReview-Setup-<版本>.exe` 安装。出现 SmartScreen 提示时，点「更多信息」，再点「仍要运行」。之后的新版本可以直接在应用里更新。

**Linux（x64）**：Debian / Ubuntu 系下载 `DouyinDataReview-<版本>-amd64.deb`，运行 `sudo apt install ./DouyinDataReview-<版本>-amd64.deb`。其他发行版下载 `DouyinDataReview-<版本>-x86_64.AppImage`，`chmod +x` 后直接运行，打不开时先装 libfuse2。应用里提示有新版本后，回下载页重新下载安装。
