# GEO 内容维护

本仓库的 GEO（Generative Engine Optimization，生成式搜索优化）面向公开项目介绍、使用步骤和功能边界，使搜索工具更容易读取、核对并引用。核心入口是 [README](README.md)、[下载页](https://zhangyukwiver.github.io/DouyinDataReview/)与[使用指南](https://zhangyukwiver.github.io/DouyinDataReview/guide.html)。

## 修改入口

- `docs/geo-content.json`：产品摘要、平台和许可事实、首页问答、页面标题、描述及核对日期。
- `docs/index.html`：下载交互与生成区块以外的正文。`geo:*` 注释之间的内容由脚本维护。
- `docs/guide.html`：导出步骤、年度报告、数据范围、数据去向与公开源码依据；元数据由脚本维护。
- `README.md`：仓库介绍和中英文问答；功能行为变化时同步更新。

更新功能事实时，先核对对应源码。日期使用实际内容修改日期，同时更新 JSON 中相应页面的 `modified` 和指南中可见的核对日期。发布版本与安装包链接使用 Releases，不将当前开发版本写成已发布版本。

运行：

```bash
npm run sync:geo
npm run check:geo
```

同步会更新两个 HTML 页面的元数据、首页的事实摘要与问答，以及根目录和 `docs/` 下相同的 `llms.txt`、`docs/sitemap.xml`。首页可见问答与 FAQ JSON-LD 共用同一份内容，HTML 无需执行 JavaScript 即可读取；下载按钮也有静态 Release 链接。`--check` 仅检查，不写文件；CI 会拒绝尚未同步的生成内容。

## 发布与抓取

将这些改动通过仓库原有流程发布到 GitHub Pages 的 `docs/` 站点后，检查：

- `/DouyinDataReview/`、`/DouyinDataReview/guide.html` 返回正常 HTML，canonical 与实际部署地址一致。
- `/DouyinDataReview/llms.txt`、`/DouyinDataReview/sitemap.xml` 可公开读取。
- 站内导航、指南锚点、示例报告和下载链接正常。模拟 JavaScript 关闭或 GitHub Release API 请求失败时，下载入口仍可用。
- 有站点管理权限时，可在搜索引擎站长工具提交站点地图并检查 URL 抓取情况；站长验证和账号操作需要相应授权。

这是 GitHub Pages 的项目子路径站点。爬虫读取的 robots.txt 必须位于源站根路径 `https://zhangyukwiver.github.io/robots.txt`；本仓库的 `docs/robots.txt` 只会部署到项目子路径，无法控制源站爬虫策略，因此这里不创建该文件。若要改抓取策略，需在控制源站根路径的仓库操作，并保留用户既有的训练与搜索抓取偏好。

站点地图只包含项目介绍和指南，不将合成数据演示页作为真实产品事实页提交。页面没有虚构评分、用户数、第三方背书或隐藏的推荐指令。

## 验证效果

可定期人工抽样以下问题，记录测试日期、搜索工具、是否引用本项目，以及回答的准确性：

- 如何导出抖音观看历史和好友聊天记录？
- 有哪些可在自己电脑上生成的抖音年度报告工具？
- 抖音官方个人信息下载的 JSON / ZIP 能生成年度报告吗？
- DouyinDataReview 会把哪些个人数据发出去？送去拆片工坊的是什么？

重点核对平台是否被误写为国际版 TikTok、是否误称可以恢复全部历史、是否误称群聊正文可备份、是否还把已经拆到拆片工坊（ReelLab）的 AI 解析、剪辑写成本应用的功能。使用站长工具的展现、点击、抓取记录和实际引荐流量作为可观测数据；仓库 Star 数不能代替搜索引用效果。

`llms.txt` 是便于工具读取的补充索引，并非各搜索引擎都遵循的标准。结构化数据描述可见事实，不承诺 FAQ 富结果、收录、排名或 AI 引用。Google 的公开指南说明，AI 搜索功能沿用 SEO 基础要求，强调可抓取、可见文本、内链，以及结构化数据与正文一致。

参考：[Google AI features and your website](https://developers.google.com/search/docs/appearance/ai-features)、[Schema.org FAQPage](https://schema.org/FAQPage)、[robots.txt 的作用范围](https://developers.google.com/search/docs/crawling-indexing/robots/robots_txt#file-location-and-range-of-validity)。
