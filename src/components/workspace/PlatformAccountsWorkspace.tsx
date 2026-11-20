import React, { useState } from "react";
import { Image, ScrollView, Text, View } from "react-native";
import type { ExploreConnection } from "../../services/explorer";
import { accountChoiceLabel, accountLabel, platformLabels, workspaceRequest, type ContentPlatform, type PlatformAccount, type PlatformDirectory } from "../../services/contentWorkspace";
import { Empty, ErrorLine, kit, Loading, Panel, SmallButton, Tabs } from "./CreatorKit";
import { ConnectLibrary, contentStyles as style, SearchField } from "./ContentWorkspaceControls";

const base = "/v1/platform-accounts";
export const accountPath = (platform: ContentPlatform, id?: string) => base + "/" + platform + (id ? "/" + encodeURIComponent(id) : "");
export function PlatformSwitcher({ platform, accounts, onSelect, onManage, disabled }: {
  platform: ContentPlatform; accounts?: PlatformDirectory; onSelect: (id: string) => void; onManage: () => void; disabled: boolean;
}) {
  const group = accounts?.[platform];
  return <View style={style.switcher}><Text style={style.label}>{platformLabels[platform]} · 操作账号</Text>
    {group?.accounts.length && !disabled ? <Tabs options={group.accounts.map(a => ({ value: a.id, label: accountChoiceLabel(a, group.accounts) }))} value={group.activeId ?? ""} onChange={onSelect} />
      : <Text style={kit.muted}>{disabled ? "正在切换…" : group ? "未添加账号" : "正在读取账号"}</Text>}
    <SmallButton label="管理账号" onPress={onManage} /></View>;
}

type Props = { connection: ExploreConnection | null; accounts?: PlatformDirectory; error?: string; onReload: () => void; onConnect: () => void;
  onDouyinSessionChange: () => Promise<void>;
  onSelect: (p: ContentPlatform, id: string) => Promise<void>; onAddDouyin: () => Promise<void>; onLogin: (p: ContentPlatform, id: string) => Promise<void>;
  biliEnabled: boolean; disabled: boolean;
  /** 抖音那栏最下面多放的东西（网页版用浏览器导入登录的面板） */
  douyinExtra?: React.ReactNode };
export function PlatformAccountsWorkspace({ connection, accounts, error, onReload, onConnect, onSelect, onAddDouyin, onLogin, onDouyinSessionChange, biliEnabled, disabled, douyinExtra }: Props) {
  const [actionError, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (!connection) return <ConnectLibrary onConnect={onConnect} />;
  const run = async (operation: () => Promise<unknown>) => {
    if (busy || disabled) return;
    setBusy(true); setError("");
    try { await operation(); onReload(); }
    catch (e) { setError(e instanceof Error ? e.message : "账号操作失败。"); }
    finally { setBusy(false); }
  };
  return <ScrollView style={{ flex: 1 }} contentContainerStyle={style.page} keyboardShouldPersistTaps="handled">
    {(error || actionError) && <ErrorLine text={actionError || error || ""} onRetry={onReload} />}
    {!accounts && !error && <Loading label="正在读取账号" />}
    {accounts && (Object.keys(platformLabels) as ContentPlatform[]).filter(p => p !== "bilibili" || biliEnabled).map(platform => {
      const group = accounts[platform];
      return <Panel key={platform} title={platformLabels[platform]} subtitle={group.accounts.length + " 个账号"}
        extra={<SmallButton label={"添加" + platformLabels[platform] + "账号"} disabled={busy || disabled} onPress={() => run(async () => {
          if (platform === "douyin") await onAddDouyin();
          else await workspaceRequest(connection, accountPath(platform), { method: "POST" });
        })} />}>
        {group.accounts.map(account => <AccountRow key={platform + account.id} account={account} active={group.activeId === account.id}
          connection={connection} platform={platform} onSelect={() => onSelect(platform, account.id)} onLogin={() => onLogin(platform, account.id)}
          busy={busy || disabled} run={run} onSessionChange={platform === "douyin" && group.activeId === account.id ? onDouyinSessionChange : undefined} />)}
        {!group.accounts.length && <Empty small text="还没有添加这个平台的账号。" />}
        {platform === "douyin" ? douyinExtra : null}
      </Panel>;
    })}
    <View style={kit.row}><SmallButton label="连接与采集" onPress={onConnect} /><SmallButton label="刷新账号列表" onPress={onReload} /></View>
  </ScrollView>;
}

function AccountRow({ account, active, connection, platform, onSelect, onLogin, busy, run, onSessionChange }: {
  account: PlatformAccount; active: boolean; connection: ExploreConnection; platform: ContentPlatform;
  onSelect: () => Promise<void>; onLogin: () => Promise<void>; onSessionChange?: () => Promise<void>; busy: boolean; run: (operation: () => Promise<unknown>) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState("");
  const [impact, setImpact] = useState<{ entryCount: number; topicCount: number }>();
  const url = accountPath(platform, account.id);
  return <View style={{ gap: 9, paddingVertical: 8 }}>
    <View style={kit.row}>{account.avatar && <Image accessibilityLabel="账号头像" source={{ uri: account.avatar }} style={{ width: 32, height: 32, borderRadius: 16 }} />}
      <Text style={style.title}>{accountLabel(account)}</Text><Text style={kit.muted}>{active ? "当前账号 · " : ""}{account.loggedIn ? "已登录" : "未登录"}</Text></View>
    <Text style={kit.muted}>{[account.note && account.nickname, account.uid && "ID " + account.uid,
      account.lastSyncedAt ? "上次同步 " + new Date(account.lastSyncedAt).toLocaleString("zh-CN") : "尚无同步记录"].filter(Boolean).join(" · ")}</Text>
    <View style={kit.row}>
      {!active && <SmallButton label="切换到此账号" disabled={busy} onPress={() => run(onSelect)} />}
      <SmallButton label={account.loggedIn ? "重新登录" : "登录账号"} disabled={busy} onPress={() => run(onLogin)} />
      <SmallButton label="编辑备注" onPress={() => { setNote(account.note ?? ""); setEditing(!editing); }} />
      {(account.loggedIn || account.uid) && <SmallButton label="退出登录" disabled={busy} onPress={() => run(async () => {
        await workspaceRequest(connection, url + "/logout", { method: "POST" });
        await onSessionChange?.();
      })} />}
      <SmallButton label="删除本地资料" disabled={busy} onPress={() => run(async () => setImpact(await workspaceRequest(connection, url + "/impact")))} />
    </View>
    {editing && <View style={kit.row}><SearchField label="账号备注" value={note} onChange={setNote} />
      <SmallButton label="保存备注" disabled={busy} onPress={() => run(async () => { await workspaceRequest(connection, url, { method: "PATCH", body: { note: note.trim() } }); setEditing(false); })} /></View>}
    {impact && <View style={{ gap: 8 }}><Text style={kit.body}>删除「{accountLabel(account)}」的本地资料？涉及 {impact.entryCount} 条内容、{impact.topicCount} 个专题。其他账号仍有来源的内容会保留。</Text>
      <View style={kit.row}><SmallButton label="取消删除" onPress={() => setImpact(undefined)} />
        <SmallButton label="确认删除本地资料" disabled={busy} onPress={() => run(async () => {
          await workspaceRequest(connection, url, { method: "DELETE" });
          setImpact(undefined);
          await onSessionChange?.();
        })} /></View></View>}
  </View>;
}
