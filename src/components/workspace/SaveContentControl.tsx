import React, { useState } from "react";
import { Text, View } from "react-native";
import { type ManualContent, type LibraryTopic, workspaceRequest } from "../../services/contentWorkspace";
import type { ExploreConnection } from "../../services/explorer";
import { ErrorLine, kit, SmallButton } from "./CreatorKit";
import { useWorkspaceRead } from "./ContentWorkspaceControls";

/** Saving is local. The account and native ID belong to the item on screen. */
export function SaveContentControl({ connection, item }: { connection: ExploreConnection; item: ManualContent }) {
  const [showTopics, setShowTopics] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const topics = useWorkspaceRead<{ topics: LibraryTopic[] }>(connection, showTopics ? "/v1/library/topics" : null);
  const save = async (topic?: LibraryTopic) => {
    if (pending) return;
    setPending(true); setError(""); setNotice("");
    try {
      await workspaceRequest(connection, "/v1/library/save", { body: item });
      if (topic) await workspaceRequest(connection, "/v1/library/topics/" + encodeURIComponent(topic.id) + "/items", { body: { key: item.platform + ":" + item.contentId } });
      setNotice(topic ? "已加入「" + topic.name + "」" : "已保存到内容库"); setShowTopics(false);
    } catch (e) { setError(e instanceof Error ? e.message : "保存失败。"); }
    finally { setPending(false); }
  };
  return <View style={{ gap: 6 }}><View style={kit.row}>
    <SmallButton label="保存到内容库" disabled={pending} onPress={() => void save()} />
    <SmallButton label="加入专题" disabled={pending} onPress={() => setShowTopics(!showTopics)} /></View>
    {showTopics && <View style={kit.row}>{topics?.value?.topics.map(t => <SmallButton key={t.id} label={t.name} disabled={pending} onPress={() => void save(t)} />)}
      {topics?.value?.topics.length === 0 && <Text style={kit.body}>可以先保存到内容库，再新建专题。</Text>}</View>}
    {(error || topics?.error) && <ErrorLine text={error || topics?.error || ""} />}
    {notice && <Text accessibilityLiveRegion="polite" style={kit.body}>{notice}</Text>}
  </View>;
}
