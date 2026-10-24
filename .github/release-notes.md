## v1.23.1 升级应用底层的 Electron，修掉 12 个安全问题

- 应用底层的 Electron 从 43.4.0 升到 43.8.3，修掉官方公布的 12 个安全问题，比如从受限页面打开的新窗口没有跟着受限、本地文件和网页能被别的网站跨站读到。功能和已采集的数据都没有变化。

验证：全量测试与类型检查通过；Windows 和 macOS 安装包都在 CI 里打包并校验通过。没有在真机上重新走一遍采集和登录。

## 安装

**macOS（Apple Silicon）**：下载 `DouyinDataReview-<版本>-arm64.dmg`，把「DouyinDataReview」拖进「应用程序」，已采集的数据不受影响。旧版名为「内容数据工作台」，替换时移除旧应用即可，本地数据目录继续沿用。安装包没有开发者签名，首次打开前要在终端执行一次：

```bash
xattr -cr "/Applications/DouyinDataReview.app"
```

不执行会提示应用已损坏。Mac 版没法在应用里自动安装更新，每个新版本都按这个步骤手动替换。

**Windows**：下载 `DouyinDataReview-Setup-<版本>.exe` 安装。出现 SmartScreen 提示时，点「更多信息」，再点「仍要运行」。之后的新版本可以直接在应用里更新。
