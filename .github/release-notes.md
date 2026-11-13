## v1.48.0 知识库：解析过的视频能检索、能问 AI

- 侧栏「我的」新增「知识库」：视频解析出的逐字稿、学习笔记和分镜脚本自动收进来，可以按关键词搜；下载本机语义模型（约 91 MB，只下一次）后，换个说法也能找到。
- 在知识库里向 AI 提问，回答只依据检索到的解析片段并标出引用，点开能看完整解析；一段都没检索到时不会调用 AI。
- 「设置 → AI」可以选 WorkBuddy：装好并登录 WorkBuddy 桌面端后，AI 对话、应用操作和口播学习笔记都能直接用它，不用填 API Key。
- 修复部分作品下载、边下边播和视频解析时报「作品接口没有返回可播放的媒体地址」。
- 对图文作品点解析，会直接说明这是图文作品、没有视频可以解析。

验证范围：发布流程检查 Windows、macOS 和 Linux 的类型、测试、构建与安装包内容。

## 安装

**macOS（Apple Silicon）**：下载 `DouyinDataReview-<版本>-arm64.dmg`，把「DouyinDataReview」拖进「应用程序」，已采集的数据不受影响。旧版名为「内容数据工作台」，替换时移除旧应用即可，本地数据目录继续沿用。安装包没有开发者签名，首次打开前要在终端执行一次：

```bash
xattr -cr "/Applications/DouyinDataReview.app"
```

不执行会提示应用已损坏。Mac 版没法在应用里自动安装更新，每个新版本都按这个步骤手动替换。

**Windows**：下载 `DouyinDataReview-Setup-<版本>.exe` 安装。出现 SmartScreen 提示时，点「更多信息」，再点「仍要运行」。之后的新版本可以直接在应用里更新。

**Linux（x64）**：Debian / Ubuntu 系下载 `DouyinDataReview-<版本>-amd64.deb`，运行 `sudo apt install ./DouyinDataReview-<版本>-amd64.deb`。其他发行版下载 `DouyinDataReview-<版本>-x86_64.AppImage`，`chmod +x` 后直接运行，打不开时先装 libfuse2。应用里提示有新版本后，回下载页重新下载安装。
