import React, { useMemo, useState } from "react";
import { Image, Platform, Pressable, ScrollView, StyleSheet, Text as RNText, View, type TextProps } from "react-native";
import { ArrowUpRight, MessageSquareText } from "lucide-react-native";

import type { PersonalRecordCollection } from "../../domain/personalRecords";
import type { MyComment, MyCommentReply } from "../../services/localCollector";
import { formatDate } from "./setupModel";
import { alpha, workspaceColors as color, workspaceFonts as font, workspaceRadii as radius } from "./workspaceTheme";
import { fx, ws } from "./motion";

const bodyType = { fontFamily: font.body } as const;
function Text({ style, ...rest }: TextProps) {
  return <RNText {...rest} style={[bodyType, style]} />;
}

const webPointer = Platform.OS === "web" ? ({ cursor: "pointer" } as object) : null;
// 一条评论下回复太多时先露几条，免得一张卡占满一屏
const FOLDED_REPLIES = 3;
const thisYear = new Date().getFullYear();
// 「10/05 17:30」，不是今年的带上年份
const when = (value: string | null) => !value ? null : new Date(value).getFullYear() === thisYear ? formatDate(value) : `${new Date(value).getFullYear()} 年 ${formatDate(value)}`;

/**
 * 内容库「我的评论」：自己发出的评论，每条下面挂着读到的回复，最近有动静的在前。
 * ponytail: 整页 ScrollView 一次排完；抖音那边每次最多给 100 条，攒到上千条觉得卡再换 FlatList
 */
export function MyCommentsView({ comments, mobile, onOpenRecord, privacy, records }: {
  comments: MyComment[];
  mobile: boolean;
  onOpenRecord: (url: string) => Promise<void>;
  privacy: boolean;
  records: PersonalRecordCollection;
}) {
  // 在本应用里发的那几条只知道作品编号：标题和封面从本机记录里找
  const known = useMemo(() => {
    const map = new Map<string, { title: string | null; author: string | null; coverUrl: string | null }>();
    for (const record of [...records.watch_history, ...records.liked_videos, ...records.favorite_videos])
      if (record.videoId && !map.has(record.videoId)) map.set(record.videoId, { title: record.title, author: record.author, coverUrl: record.coverUrl ?? null });
    return map;
  }, [records]);
  const replies = comments.reduce((sum, comment) => sum + comment.replies.length, 0);
  return (
    <ScrollView contentContainerStyle={[styles.content, mobile && styles.contentMobile, comments.length === 0 && styles.contentEmpty]} testID="my-comments">
      <View {...fx({ motion: "rise", ws: "w-ghead" })} style={styles.header}>
        <Text {...ws("w-gtitle")} style={styles.title}>我的评论</Text>
        <Text {...ws("mono")} style={styles.meta}>
          {comments.length ? `你发过的 ${comments.length} 条评论收到了 ${replies} 条回复，最近有人回的排在前面` : "读取记录时会顺带读抖音通知里的评论回复"}
        </Text>
      </View>
      {comments.length === 0 ? (
        <View {...fx({ motion: "rise" })} style={styles.empty} testID="my-comments-empty">
          <View {...ws("w-emptyicon")} style={styles.emptyIcon}><MessageSquareText color={color.cyan} size={24} /></View>
          <Text {...ws("w-emptytitle")} style={styles.emptyTitle}>还没读到评论</Text>
          <Text style={styles.emptyDetail}>点右上角重新读取记录，有人回复过你的评论就会出现在这里。抖音只保留最近 100 条评论通知，读到的都会留在本机；在本应用里发的评论也会记在这里。</Text>
        </View>
      ) : (
        <View style={styles.list}>
          {comments.map((comment) => (
            <CommentCard key={comment.id} comment={comment} onOpenRecord={onOpenRecord} privacy={privacy} video={comment.video?.title || comment.video?.coverUrl || !comment.videoId ? comment.video : known.get(comment.videoId) ?? null} />
          ))}
        </View>
      )}
    </ScrollView>
  );
}

function CommentCard({ comment, onOpenRecord, privacy, video }: { comment: MyComment; onOpenRecord: (url: string) => Promise<void>; privacy: boolean; video: MyComment["video"] }) {
  const [open, setOpen] = useState(false);
  const shown = open ? comment.replies : comment.replies.slice(0, FOLDED_REPLIES);
  const meta = [when(comment.at), comment.likes ? `${comment.likes} 赞` : null, comment.source === "app" ? "在本应用里发的" : null].filter(Boolean).join(" · ");
  return (
    <View {...ws("w-card")} style={styles.card} testID={`my-comment-${comment.id}`}>
      <Pressable
        accessibilityLabel={comment.videoId ? "在抖音打开这条作品" : "作品已经看不到了"}
        accessibilityRole="link"
        disabled={!comment.videoId}
        {...fx({ hover: "tint" })}
        onPress={() => void onOpenRecord(`https://www.douyin.com/video/${comment.videoId}`)}
        style={({ pressed }) => [styles.video, pressed && styles.pressed, comment.videoId ? webPointer : null]}
      >
        <View style={styles.cover}>
          {video?.coverUrl && !privacy ? <Image source={{ uri: video.coverUrl }} style={styles.coverImage} /> : null}
        </View>
        <View style={styles.videoCopy}>
          <Text numberOfLines={1} style={styles.videoTitle}>{!comment.videoId ? "作品已经删了或设成了私密" : privacy ? "某条作品" : video?.title || "这条作品"}</Text>
          <Text numberOfLines={1} style={styles.videoAuthor}>{!comment.videoId ? "评论和回复还留着" : privacy || !video?.author ? "在抖音打开" : `${video.author} · 在抖音打开`}</Text>
        </View>
        {comment.videoId ? <ArrowUpRight color={color.textMuted} size={15} /> : null}
      </Pressable>

      <View style={styles.mine}>
        <View style={[styles.chip, { backgroundColor: alpha(color.accent, 0.14) }]}><Text style={[styles.chipText, { color: color.accent }]}>我</Text></View>
        <View style={styles.body}>
          <Text style={comment.text ? styles.mineText : styles.missing}>{privacy ? "隐私模式下不显示正文" : comment.text ?? "你在这条作品下的评论（原文没读到）"}</Text>
          {meta ? <Text {...ws("mono")} style={styles.time}>{meta}</Text> : null}
        </View>
      </View>

      {comment.replies.length ? (
        <View style={styles.replies}>
          {shown.map((reply) => <ReplyRow key={reply.id} privacy={privacy} reply={reply} />)}
          {comment.replies.length > FOLDED_REPLIES ? (
            <Pressable accessibilityRole="button" onPress={() => setOpen(!open)} style={({ pressed }) => [styles.more, pressed && styles.pressed, webPointer]}>
              <Text style={styles.moreText}>{open ? "收起" : `再看 ${comment.replies.length - FOLDED_REPLIES} 条回复`}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : <Text style={styles.noReply}>还没读到回复</Text>}
    </View>
  );
}

function ReplyRow({ privacy, reply }: { privacy: boolean; reply: MyCommentReply }) {
  const name = privacy ? "某位网友" : reply.user.name;
  return (
    <View style={styles.reply}>
      <View {...ws("c-avatar")} style={styles.avatar}>
        {reply.user.avatarUrl && !privacy ? <Image source={{ uri: reply.user.avatarUrl }} style={styles.avatarImage} /> : <Text style={styles.avatarText}>{Array.from(name)[0]}</Text>}
      </View>
      <View style={styles.body}>
        <View style={styles.replyHead}>
          <Text numberOfLines={1} style={styles.replyName}>{name}</Text>
          {reply.label && !privacy ? <View style={[styles.chip, { backgroundColor: alpha(color.cyan, 0.14) }]}><Text style={[styles.chipText, { color: color.cyan }]}>{reply.label}</Text></View> : null}
          {reply.at ? <Text {...ws("mono")} style={styles.time}>{when(reply.at)}</Text> : null}
        </View>
        <Text style={styles.replyText}>{privacy ? "隐私模式下不显示正文" : reply.text}</Text>
        {/* 楼里回的是别人：带上回的那句，免得看不懂 */}
        {Object.hasOwn(reply, "quote") && !privacy ? (
          <Text numberOfLines={2} style={styles.quote}>回复 {reply.replyToName ? `@${reply.replyToName}` : "楼里的人"}：{reply.quote ?? "…"}</Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 28, paddingTop: 18, paddingBottom: 42 },
  contentMobile: { paddingHorizontal: 12, paddingTop: 12, paddingBottom: 96 },
  contentEmpty: { flexGrow: 1 },
  header: { minHeight: 60, justifyContent: "center", marginBottom: 14 },
  title: { color: color.text, fontSize: 16, fontWeight: "600", letterSpacing: 2.5, fontFamily: font.serif },
  meta: { color: color.textMuted, fontSize: 10, marginTop: 5 },
  list: { width: "100%", maxWidth: 820, gap: 14 },
  card: { gap: 12, padding: 16, borderWidth: 1, borderColor: color.border, borderRadius: radius.medium, backgroundColor: color.surface },
  video: { flexDirection: "row", alignItems: "center", gap: 10, padding: 6, marginHorizontal: -6, marginTop: -6, borderRadius: radius.small },
  pressed: { opacity: 0.7 },
  cover: { width: 36, height: 48, overflow: "hidden", borderRadius: radius.small, backgroundColor: color.surfaceMuted },
  coverImage: { width: "100%", height: "100%" },
  videoCopy: { flex: 1, minWidth: 0, gap: 3 },
  videoTitle: { color: color.textSecondary, fontSize: 12, fontWeight: "600" },
  videoAuthor: { color: color.textMuted, fontSize: 11 },
  mine: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  chip: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: radius.pill },
  chipText: { fontSize: 10, fontWeight: "700" },
  body: { flex: 1, minWidth: 0, gap: 4 },
  mineText: { color: color.text, fontSize: 14, lineHeight: 21 },
  missing: { color: color.textMuted, fontSize: 13, lineHeight: 20 },
  time: { color: color.textMuted, fontSize: 10 },
  replies: { gap: 12, marginLeft: 12, paddingLeft: 14, borderLeftWidth: 2, borderLeftColor: color.borderSoft },
  reply: { flexDirection: "row", alignItems: "flex-start", gap: 9 },
  avatar: { width: 26, height: 26, alignItems: "center", justifyContent: "center", overflow: "hidden", borderRadius: 13, backgroundColor: color.surfaceMuted },
  avatarImage: { width: "100%", height: "100%" },
  avatarText: { color: color.textSecondary, fontSize: 11, fontWeight: "600" },
  replyHead: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },
  replyName: { color: color.textSecondary, fontSize: 12, fontWeight: "600", flexShrink: 1 },
  replyText: { color: color.text, fontSize: 13, lineHeight: 20 },
  quote: { color: color.textMuted, fontSize: 11, lineHeight: 17 },
  more: { alignSelf: "flex-start", paddingVertical: 2 },
  moreText: { color: color.cyan, fontSize: 12, fontWeight: "600" },
  noReply: { marginLeft: 12, color: color.textMuted, fontSize: 11 },
  empty: { flex: 1, minHeight: 360, alignItems: "center", justifyContent: "center", paddingHorizontal: 24 },
  emptyIcon: { width: 58, height: 58, alignItems: "center", justifyContent: "center", borderRadius: 29, borderWidth: 1, borderColor: color.border },
  emptyTitle: { color: color.text, fontSize: 17, fontWeight: "600", letterSpacing: 3, marginTop: 16, fontFamily: font.serif },
  emptyDetail: { maxWidth: 460, color: color.textMuted, fontSize: 12, lineHeight: 19, textAlign: "center", marginTop: 7 },
});
