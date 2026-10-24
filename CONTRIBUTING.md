# 参与贡献

感谢你为 `DouyinDataReview` 提交问题、建议或代码。

## 开始前

```bash
npm install
npm run typecheck
npm test
```

需要验证桌面构建时，再运行 `npm run build:web` 或对应的桌面打包命令。增量读取需要本机已有支持的 Chromium 浏览器和自己的抖音登录态。

## 提交问题

- Bug 请附系统、架构、应用版本、操作步骤和可复现结果。
- 功能建议请说明使用场景、希望解决的问题和可接受的替代方案。
- 不要上传 Cookie、Token、浏览器配置、聊天记录、个人数据或未脱敏的截图。
- 使用问题和想法发到 [Discussions](https://github.com/ZhangYukwiver/DouyinDataReview/discussions)，安全问题按 [SECURITY.md](SECURITY.md) 私下报告。

## 从哪里开始

标着 `good first issue` 的问题小而明确，适合第一次参与；`help wanted` 的会大一些。准备做某个 issue 时先在下面说一声，大改动先开 issue 讲清思路，免得两个人做重复，或者做完了方向不对。

## 提交代码

1. Fork 仓库并从 `main` 创建分支。
2. 保持改动聚焦，补充与行为风险对应的测试。
3. 提交前运行 `npm run typecheck` 和 `npm test`。
4. Pull Request 中说明行为变化、验证命令和已知限制。

修改公开功能说明或下载页时，按 [GEO 内容维护](GEO.md) 同步 README、使用指南与 `docs/geo-content.json`，运行 `npm run sync:geo` 和 `npm run check:geo`，保持可见问答与结构化数据一致。

每个 Pull Request 都会在 Windows 和 macOS 上各跑一遍检查（GEO 校验、类型检查、测试、打包），两项都通过才能合并。第一次参与的人，检查要等维护者批准后才会开始。维护者会审每个 Pull Request，可能请你再改一改。

你贡献的代码和项目其余部分一样按 [MIT 许可证](LICENSE) 发布，不需要另外签协议。

## 运营监测

GitHub 流量监测脚本只把快照保存到用户本机，不提交到仓库。运行 `npm run ops:traffic` 前需要 `GH_TOKEN` 或已登录的 `gh auth`；不要把令牌写入 Issue、日志或提交。

## 使用边界

本项目只面向本人账号和本地个人使用。请遵守适用法律、抖音平台规则和仓库中的安全说明，不要将采集器改造成批量、多用户或定时操作服务。
