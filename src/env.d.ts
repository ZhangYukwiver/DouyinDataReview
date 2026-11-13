declare const process: {
  readonly env: {
    readonly EXPO_PUBLIC_COLLECTOR_BASE_URL?: string;
    /** .github/release-notes.md 原文，metro.config.js 打包时放进来 */
    readonly EXPO_PUBLIC_RELEASE_NOTES?: string;
    /** 在线体验版打包时为 "1"，见 app.config.js */
    readonly EXPO_PUBLIC_DEMO?: string;
    /** Expo 打包时内联的 experiments.baseUrl；只有在线体验版有值 */
    readonly EXPO_BASE_URL?: string;
  };
};
