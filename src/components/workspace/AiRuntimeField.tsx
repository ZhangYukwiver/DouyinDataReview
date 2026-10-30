import React, { useCallback, useEffect, useSyncExternalStore } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { type AiRuntime, type AiRuntimeStatus, getAiRuntimes, isLocalAiRuntime } from "../../services/assistant";
import type { ExploreConnection } from "../../services/explorer";
import { kit, Segmented, SmallButton } from "./CreatorKit";
import { workspaceColors as color, workspaceFonts as font } from "./workspaceTheme";

// AI 助手的设置：选接口还是本机的 Codex / Claude Code，选了本机的就显示这台电脑上装没装、登没登录。

// 选项上只写「Claude」：海报风格的分段按钮更宽，放不下「Claude Code」，说明文字里写全称
const OPTIONS: Array<{ label: string; value: AiRuntime }> = [
  { label: "接口", value: "api" },
  { label: "Codex", value: "codex" },
  { label: "Claude", value: "claude" },
];

export const RUNTIME_LABELS: Record<AiRuntime, string> = { api: "接口", codex: "Codex", claude: "Claude Code" };

// 检测结果整个页面共用（按采集器地址分）：设置面板、对话页、切走再回来都不重查，点「重新检测」才查
type Checked = { runtimes: AiRuntimeStatus[] | null; loading: boolean; error: string | null };
const checked = new Map<string, Checked>();
const checking = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
let version = 0;
const emit = () => { version += 1; for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

function check(connection: ExploreConnection, fresh: boolean): Promise<void> {
  const key = connection.baseUrl;
  const running = checking.get(key);
  if (running) return running;
  const previous = checked.get(key);
  checked.set(key, { runtimes: previous?.runtimes ?? null, loading: true, error: null });
  emit();
  const task = (async () => {
    try {
      checked.set(key, { runtimes: await getAiRuntimes(connection, fresh), loading: false, error: null });
    } catch (error) {
      // 没查成功就不拿旧结果拦人了，发出去让采集器自己判断
      checked.set(key, { runtimes: [], loading: false, error: error instanceof Error ? error.message : "没查成功。" });
    } finally {
      checking.delete(key);
      emit();
    }
  })();
  checking.set(key, task);
  return task;
}

const problemOf = (connection: ExploreConnection, runtime: AiRuntime) => {
  const status = checked.get(connection.baseUrl)?.runtimes?.find((item) => item.id === runtime);
  return status && status.state !== "ready" ? status.message : null;
};

/**
 * 发消息、开始解析前：已经知道这个本机运行时用不了（没登录之类）就返回给用户看的那句话，不白跑一趟；还没查过或能用返回 null。
 * 记着的是旧的「用不了」时先再查一次（用户可能刚在终端里登录好），采集器那边对用不了的结果本来就不缓存，不花额度。
 */
export async function runtimeProblem(connection: ExploreConnection | null, runtime: AiRuntime | undefined): Promise<string | null> {
  if (!connection || !isLocalAiRuntime(runtime) || !problemOf(connection, runtime)) return null;
  await check(connection, false);
  return problemOf(connection, runtime);
}

function useRuntimeStatus(connection: ExploreConnection | null, runtime: AiRuntime) {
  useSyncExternalStore(subscribe, () => version);
  const local = isLocalAiRuntime(runtime);
  useEffect(() => {
    if (connection && local && !checked.has(connection.baseUrl)) void check(connection, false);
  }, [connection, local]);
  const refresh = useCallback(() => { if (connection) void check(connection, true); }, [connection]);
  return { state: connection ? checked.get(connection.baseUrl) : undefined, refresh };
}

function statusText(connection: ExploreConnection | null, runtime: AiRuntime, state: Checked | undefined): string {
  const label = RUNTIME_LABELS[runtime];
  if (!connection) return `连上采集器以后，才能检查这台电脑上的 ${label}。`;
  if (state?.loading) return `正在检查这台电脑上的 ${label}……`;
  if (state?.error) return `没查成功。${state.error}`;
  return state?.runtimes?.find((item) => item.id === runtime)?.message ?? `还没检查这台电脑上的 ${label}。`;
}

/** value 跟着面板里还没保存的草稿走：没点保存也能看到「没找到 Codex」。 */
export function AiRuntimeField({ connection, value, onChange }: { connection: ExploreConnection | null; value: AiRuntime; onChange: (value: AiRuntime) => void }) {
  const { state, refresh } = useRuntimeStatus(connection, value);
  return <View style={styles.field}>
    <Text style={styles.label}>用哪个 AI</Text>
    <Segmented options={OPTIONS} value={value} onChange={onChange} />
    {isLocalAiRuntime(value) ? <View style={styles.status}>
      <Text accessibilityLiveRegion="polite" style={[kit.muted, { flex: 1 }]}>{statusText(connection, value, state)}</Text>
      {state?.loading ? <ActivityIndicator size="small" color={color.cyan} /> : null}
      {/* 检测时按钮不卸载也不禁用（禁用的按钮会把键盘焦点甩回页面开头）；检测中再按会接上同一次检测 */}
      {connection ? <SmallButton label={state?.loading ? "检测中…" : "重新检测"} onPress={refresh} /> : null}
    </View> : null}
  </View>;
}

const styles = StyleSheet.create({
  field: { gap: 6 },
  label: { color: color.textSecondary, fontFamily: font.body, fontSize: 12 },
  status: { flexDirection: "row", alignItems: "center", gap: 10 },
});
