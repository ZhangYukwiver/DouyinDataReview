## 安装

**macOS（Apple Silicon）**：下载 `ContentInsights-<版本>-arm64.dmg`，把「内容数据工作台」拖进「应用程序」，有旧版直接覆盖，已采集的数据不受影响。安装包没有开发者签名，首次打开前要在终端执行一次：

```bash
xattr -cr "/Applications/内容数据工作台.app"
```

不执行会提示应用已损坏。Mac 版没法在应用里自动安装更新，每个新版本都按这个步骤手动替换。

**Windows**：下载 `ContentInsights-Setup-<版本>.exe` 安装。出现 SmartScreen 提示时，点「更多信息」，再点「仍要运行」。之后的新版本可以直接在应用里更新。
