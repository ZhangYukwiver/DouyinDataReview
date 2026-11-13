// 在线体验版（EXPO_PUBLIC_DEMO=1）放在 GitHub Pages 的 /DouyinDataReview/app/ 下，资源路径要带上这一段；其他构建照旧用 app.json
module.exports = ({ config }) => process.env.EXPO_PUBLIC_DEMO === "1"
  ? { ...config, experiments: { ...config.experiments, baseUrl: "/DouyinDataReview/app" } }
  : config;
