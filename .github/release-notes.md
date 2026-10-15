## v1.14.1 应用统一更名为 DouyinDataReview

- 桌面应用、窗口与通知、工作台顶栏、Windows 安装快捷方式统一使用 `DouyinDataReview`。
- macOS 源码启动器更名为 `DouyinDataReview.app`，同步更新应用元数据、启动提示及构建校验路径。
- 继续使用旧版的数据与浏览器会话目录，保留已有采集记录、登录凭据和界面设置；应用标识保持一致。
- 同步更新下载页、README 和安装说明。

验证：77 个测试文件、869 项测试通过；类型检查、Web 构建、应用及下载页名称显示、macOS 源码启动器签名校验通过。本次未进行 Windows 实机升级或真实账号验收。

## 安装

**macOS（Apple Silicon）**：下载 `DouyinDataReview-<版本>-arm64.dmg`，把「DouyinDataReview」拖进「应用程序」，已采集的数据不受影响。旧版名为「内容数据工作台」，替换时移除旧应用即可，本地数据目录继续沿用。安装包没有开发者签名，首次打开前要在终端执行一次：

```bash
xattr -cr "/Applications/DouyinDataReview.app"
```

不执行会提示应用已损坏。Mac 版没法在应用里自动安装更新，每个新版本都按这个步骤手动替换。

**Windows**：下载 `DouyinDataReview-Setup-<版本>.exe` 安装。出现 SmartScreen 提示时，点「更多信息」，再点「仍要运行」。之后的新版本可以直接在应用里更新。
