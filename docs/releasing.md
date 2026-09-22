# 桌面版发布

所有 PR、`main` 更新和 `v*` 标签均由 `.github/workflows/desktop-release.yml` 在干净的 GitHub 托管环境中构建 Windows x64 NSIS 安装器及 macOS Apple Silicon DMG。每个平台执行 Node.js 24、`npm ci`、类型检查、全部测试、Web 构建、签名器安装与桌面打包。PR 的安装器可从 Actions artifacts 下载，保留 14 天。

打包后执行 `scripts/verify-release-package.mjs` 检查真实 `app.asar`，确认当前采集器源码和 Web 构建完整进入安装包、前端包含自动恢复同步的逻辑、签名运行器和 Playwright 已拆包、内置签名器通过逐文件 SHA-256 校验。它还检查资源目录和 ASAR，拒绝浏览器配置、Cookies、记录、直接读取模板、`.env` 等私人运行数据路径；上传范围只包括安装器。发布任务不读取开发者电脑的数据。

macOS 构建在测试后显式重装 arm64 Electron，并用 `lipo` 同时检查构建输入和输出，避免 `electronDist` 将 Intel Electron 装入 Apple Silicon 安装包。macOS 目前沿用仓库中的 ad-hoc 签名，没有 Apple 公证；Windows 没有配置发行者证书。

发布步骤：

1. 同时更新 `package.json` 和 `package-lock.json` 的版本，提交 PR，确认两个平台的构建检查通过后合并。
2. 在合并后的提交创建与版本严格一致的 `v<version>` 标签并推送。例如版本 `0.1.1` 使用 `v0.1.1`。
3. 标签工作流再次完整构建、校验两个平台。两个任务都成功后，发布任务收齐同一版本的 EXE 与 DMG，生成 `SHA256SUMS`，先上传至草稿 Release，再公开发布。
4. 在 GitHub Release 下载对应平台的新安装器。已有版本没有自动更新功能，旧 Release 的安装器也不会被更改。

发布仅使用标签任务的临时 `contents: write` 权限；普通构建为只读。Actions 依赖固定到提交 SHA。若构建失败，不会创建公开 Release。若上传阶段失败并留下草稿，检查草稿资源后删除该草稿并重跑失败任务；不要移动已公开发布的版本标签。

本地可在 `npm run build:web`、`npm run direct:setup`、`npx electron-builder --win nsis --x64 --publish never` 后检查 Windows 资源：

```sh
node scripts/verify-release-package.mjs release/win-unpacked/resources
```

此校验不需要抖音账号、浏览器登录态或历史数据。线上站点登录、风控或接口变化仍需实际用户会话验证；CI 确保回归测试通过并且修复进入可下载的安装器。
