# GitHub 宣传素材

## 当前变体

变体清单在 [`variants.json`](./variants.json)。`active` 指向当前用于 README 首屏的素材变体。每次更换封面、视频或首屏位置时，新增或更新一个 `id`，填写发布时间和观察周期。

## poster-2025

- 来源：用户提供的视频 `mmexport1790315962629.mp4`
- 画面：1440×900，约 65.9 秒，H.264，无音频流
- 内容：海报风格的年度回顾，展示话题、时长、记录完整性和收束页
- 数据：合成示例数据，不包含真实账号记录
- 发布位置：README 首屏演示入口和 GitHub `v0.1.10` Release 资源

视频文件不进入 Git 历史。发布时将它作为 Release 资源上传，并在 README 使用可提交的封面图链接。

## 监测约定

每天运行 `npm run ops:traffic` 保存 GitHub 快照，每周运行 `npm run ops:traffic:report` 生成建议。报告只生成建议，不自动修改文案或发布内容。

在 Windows 或 macOS 上可运行 `npm run ops:schedule` 安装当前用户的每日 09:00 采集和每周日 09:15 周报任务。任务使用本机 `gh auth` 登录态，不把令牌写入任务参数；Linux 请用 cron 调用上述两个命令。
