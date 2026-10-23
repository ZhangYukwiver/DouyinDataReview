declare const process: {
  readonly env: {
    readonly EXPO_PUBLIC_COLLECTOR_BASE_URL?: string;
    /** .github/release-notes.md 原文，metro.config.js 打包时放进来 */
    readonly EXPO_PUBLIC_RELEASE_NOTES?: string;
  };
};
