import { Alert, Platform } from "react-native";

/** 账号删除和其他确认操作共用同一套平台弹窗。 */
export function confirmAlert(
  title: string,
  message: string,
  confirmText: string,
  onDecision: (confirmed: boolean) => void,
  destructive = false,
) {
  let settled = false;
  const settle = (confirmed: boolean) => {
    if (settled) return;
    settled = true;
    onDecision(confirmed);
  };
  if (Platform.OS === "web" && typeof window !== "undefined") {
    settle(window.confirm(`${title}\n\n${message}`));
    return;
  }
  Alert.alert(title, message, [
    { text: "取消", style: "cancel", onPress: () => settle(false) },
    { text: confirmText, style: destructive ? "destructive" : "default", onPress: () => settle(true) },
  ], { cancelable: true, onDismiss: () => settle(false) });
}
