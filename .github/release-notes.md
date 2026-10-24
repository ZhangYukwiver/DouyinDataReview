## v1.24.0 即梦和小云雀改用本机命令行

- AI 剪辑生成视频时，即梦和小云雀不用再填 Key：和 LibTV 一样，在这台电脑上装好官方命令行（即梦是 dreamina，小云雀是 pippit-tool-cli），在终端里登录一次，再到 AI 剪辑设置的「服务商」里点「连接」就能用。即梦扣的是你即梦账号的积分，能用 Seedance 2.0、2.5 等模型。
- 以前填过即梦 AccessKey 或小云雀 Access Key 的，升级后这两家会显示没连上，照上面的步骤重新连一次就行。

验证：全量测试与类型检查通过；用本机真实的即梦命令行确认过没登录时会提示先登录；没有用真账号实际生成过视频。

## 安装

**macOS（Apple Silicon）**：下载 `DouyinDataReview-<版本>-arm64.dmg`，把「DouyinDataReview」拖进「应用程序」，已采集的数据不受影响。旧版名为「内容数据工作台」，替换时移除旧应用即可，本地数据目录继续沿用。安装包没有开发者签名，首次打开前要在终端执行一次：

```bash
xattr -cr "/Applications/DouyinDataReview.app"
```

不执行会提示应用已损坏。Mac 版没法在应用里自动安装更新，每个新版本都按这个步骤手动替换。

**Windows**：下载 `DouyinDataReview-Setup-<版本>.exe` 安装。出现 SmartScreen 提示时，点「更多信息」，再点「仍要运行」。之后的新版本可以直接在应用里更新。
