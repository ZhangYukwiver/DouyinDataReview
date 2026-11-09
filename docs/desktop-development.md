# 独立桌面调试环境

从源码运行 Electron 时，可以通过 `DY2_DEV_USER_DATA` 指定独立的数据目录，与已安装应用同时运行。

先安装依赖并构建 Web，再从项目根目录启动：

```bash
npm ci
npm run build:web
DY2_DEV_USER_DATA="$PWD/.local-data/desktop-debug-profile" npx electron desktop/main.mjs
```

此环境变量仅在未打包的源码模式生效。设置后，应用名称为 `DouyinDataReview Dev`，应用 ID 使用 `.dev` 后缀；页面与采集器分别优先监听 47661、47662，用户数据和浏览器会话保存在指定目录内。未设置时沿用原有名称、数据目录和 47651、47652 端口。

更改前端后需要重新构建 Web 产物，再重启调试版。原版应用与调试版分别保存数据。

调试版 MCP 可通过源码中的 stdio 桥接连接：

```bash
DY2_MCP_URL="http://127.0.0.1:47662/mcp" \
DY2_MCP_TOKEN_FILE="$PWD/.local-data/desktop-debug-profile/collector/mcp-token" \
node collector/mcpStdio.mjs
```

保持调试版打开。桥接脚本读取该数据目录中的令牌，转发到对应采集器。
