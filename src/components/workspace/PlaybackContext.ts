import { createContext, type RefObject } from "react";
import type { AssistantVideo } from "../../services/assistant";

// 播放器在画面切换时更新；助手只在用户按下发送时读取。
export const PlaybackContext = createContext<RefObject<AssistantVideo | null> | null>(null);
