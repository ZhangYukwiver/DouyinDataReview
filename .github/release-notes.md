## v1.46.0 收藏夹和抖音同步，读取和导出可以选范围

- 读取收藏时会按抖音上原有的收藏夹自动分好文件夹。打开「设置 → 隐私 → 允许在抖音上操作」后，在应用里新建、改名、删除收藏栏的文件夹，或把视频放进、移出，都会同步到抖音的收藏夹；删收藏夹、移出收藏夹都不会取消收藏。
- 应用里新建的抖音收藏夹默认私密，名字最多 15 个字。喜欢和观看历史的文件夹仍只存在本机。
- 读取时可以只勾观看历史、喜欢、收藏中的几类，下次读取会记住选择。
- 导出数据可以选全部、近一年、近 30 天或近 7 天；时间范围只筛观看历史和聊天，喜欢和收藏没有时间，会整份导出。

验证范围：发布流程检查 Windows、macOS 和 Linux 的类型、测试、构建与安装包内容。

## 安装

**macOS（Apple Silicon）**：下载 `DouyinDataReview-<版本>-arm64.dmg`，把「DouyinDataReview」拖进「应用程序」，已采集的数据不受影响。旧版名为「内容数据工作台」，替换时移除旧应用即可，本地数据目录继续沿用。安装包没有开发者签名，首次打开前要在终端执行一次：

```bash
xattr -cr "/Applications/DouyinDataReview.app"
```

不执行会提示应用已损坏。Mac 版没法在应用里自动安装更新，每个新版本都按这个步骤手动替换。

**Windows**：下载 `DouyinDataReview-Setup-<版本>.exe` 安装。出现 SmartScreen 提示时，点「更多信息」，再点「仍要运行」。之后的新版本可以直接在应用里更新。

**Linux（x64）**：Debian / Ubuntu 系下载 `DouyinDataReview-<版本>-amd64.deb`，运行 `sudo apt install ./DouyinDataReview-<版本>-amd64.deb`。其他发行版下载 `DouyinDataReview-<版本>-x86_64.AppImage`，`chmod +x` 后直接运行，打不开时先装 libfuse2。应用里提示有新版本后，回下载页重新下载安装。
