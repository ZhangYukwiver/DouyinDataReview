## v1.23.2 修好 Windows 上 AI 剪辑的网页片段做不出来

- Windows 上让 AI 剪辑写网页片段（片头大字、字卡、动画标题这类），会一直报「截图超过 30 秒没回来」，片段做不出来。原因是渲染用的隐藏窗口在 Windows 上不出画面，现在改成离屏渲染，透明背景和导出视频照常可用。

验证：在 Windows 和 macOS 上都用真实的渲染窗口逐帧截图核对过画面、透明通道和视频编码；全量测试与类型检查通过。

## 安装

**macOS（Apple Silicon）**：下载 `DouyinDataReview-<版本>-arm64.dmg`，把「DouyinDataReview」拖进「应用程序」，已采集的数据不受影响。旧版名为「内容数据工作台」，替换时移除旧应用即可，本地数据目录继续沿用。安装包没有开发者签名，首次打开前要在终端执行一次：

```bash
xattr -cr "/Applications/DouyinDataReview.app"
```

不执行会提示应用已损坏。Mac 版没法在应用里自动安装更新，每个新版本都按这个步骤手动替换。

**Windows**：下载 `DouyinDataReview-Setup-<版本>.exe` 安装。出现 SmartScreen 提示时，点「更多信息」，再点「仍要运行」。之后的新版本可以直接在应用里更新。
