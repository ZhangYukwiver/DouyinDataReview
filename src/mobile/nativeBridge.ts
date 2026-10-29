import { requireNativeModule } from "expo-modules-core";

export interface DirectContext { userAgent: string; values: Record<string, string> }
interface DouyinNative {
  hasContext(): Promise<boolean>;
  configure(raw: string): Promise<boolean>;
  prepare(path: string, query: string): Promise<{ url: string; userAgent: string }>;
  request(signedUrl: string, body: string | null): Promise<string>;
  readStoryAsset(name: string): Promise<string>;
}
export const nativeBridge = requireNativeModule<DouyinNative>("DouyinNative");
