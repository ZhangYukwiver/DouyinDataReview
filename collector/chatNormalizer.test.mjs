import { describe, expect, it } from "vitest";

import {
  ChatConversationAccumulator,
  ChatMessageAccumulator,
  matchChatEndpoint,
  matchImapiEndpoint,
  normalizeChatPayload,
  normalizeChatPresence,
  normalizeImapiResponse,
} from "./chatNormalizer.mjs";

function encodeVarint(value) {
  let current = value;
  const bytes = [];
  while (current >= 0x80) {
    bytes.push((current & 0x7f) | 0x80);
    current = Math.floor(current / 0x80);
  }
  bytes.push(current);
  return Uint8Array.from(bytes);
}

function encodeField(field, wireType, valueBytes) {
  const tag = (field << 3) | wireType;
  const tagBytes = encodeVarint(tag);
  if (wireType === 0) {
    return Uint8Array.from([...tagBytes, ...encodeVarint(valueBytes)]);
  }
  if (wireType !== 2) throw new Error(`unsupported wire type ${wireType}`);
  return Uint8Array.from([...tagBytes, ...encodeVarint(valueBytes.length), ...valueBytes]);
}

function encodeStringField(field, value) {
  return encodeField(field, 2, new TextEncoder().encode(value));
}

function encodeMessage(fields) {
  const chunks = fields.flatMap((chunk) => [...chunk]);
  return Uint8Array.from(chunks);
}

function concatBytes(...chunks) {
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function encodeMessageProto(message) {
  const fields = [
    encodeStringField(1, message.conv_id),
    encodeStringField(3, message.server_id),
    encodeField(4, 0, message.created_at_us),
    encodeField(5, 0, message.order),
    encodeField(6, 0, message.type_code),
    encodeStringField(7, message.sender_uid),
    encodeStringField(8, message.content_json),
  ];
  return encodeMessage(fields);
}

function encodeMessageBodyProto(message) {
  return encodeMessage([
    encodeStringField(1, message.conv_id),
    encodeField(3, 0, message.server_id),
    encodeField(6, 0, message.type_code),
    encodeStringField(7, message.sender_uid),
    encodeStringField(8, message.content),
    encodeField(10, 0, message.create_time),
  ]);
}

function encodeResponseEnvelope(command, body) {
  return encodeMessage([
    encodeField(1, 0, command),
    encodeField(6, 2, encodeField(command, 2, body)),
  ]);
}

describe("matchImapiEndpoint", () => {
  it("matches the supported IM API message endpoint", () => {
    expect(matchImapiEndpoint("https://imapi.douyin.com/v1/message/get_by_conversation/?cursor=1"))
      .toEqual({ kind: "chat_messages", pathname: "/v1/message/get_by_conversation" });
    expect(matchImapiEndpoint("https://evil.example/v1/message/get_by_conversation")).toBeNull();
    expect(matchImapiEndpoint("https://imapi.douyin.com/v1/message/get_message_by_init")).toEqual({
      kind: "chat_messages",
      pathname: "/v1/message/get_message_by_init",
    });
    expect(matchImapiEndpoint("https://imapi.douyin.com/v1/message/get_user_message/")).toEqual({
      kind: "chat_messages",
      pathname: "/v1/message/get_user_message",
    });
  });
});

describe("normalizeImapiResponse", () => {
  it.each(["snake", "camel"])("preserves the separate comment and source video fields (%s)", (shape) => {
    const content = shape === "snake" ? {
      comment_id: "1234", comment_user_name: "评论作者", comment_content_type: 2,
      comment_url: { url_list: ["https://p3.douyinpic.com/comment.jpg"] }, aweme_title: "来源视频标题", media_type: 1,
    } : {
      commentId: "1234", commentUserName: "评论作者", commentContentType: 2,
      commentUrl: { url_list: ["https://p3.douyinpic.com/comment.jpg"] }, awemeTitle: "来源视频标题", mediaType: 1,
    };
    const result = normalizeImapiResponse(matchImapiEndpoint("https://imapi.douyin.com/v1/message/get_by_conversation"), {
      msgs: [{ server_id: "shared-comment", type_code: 105, sender_name: "转发好友", content_json: {
        ...content, comment: "通话这个功能很好", itemId: "7650000000000000000",
        cover_url: { url_list: ["https://p3.douyinpic.com/video.jpg"] },
      } }],
    });
    expect(result.chatMessages[0]).toMatchObject({
      type: "comment", text: "通话这个功能很好", senderName: "转发好友",
      comment: { id: "1234", author: "评论作者", text: "通话这个功能很好", mediaUrl: "https://p3.douyinpic.com/comment.jpg", mediaType: "image", sourceType: "video" },
      share: { title: "来源视频标题", author: null, coverUrl: "https://p3.douyinpic.com/video.jpg", url: "https://www.douyin.com/video/7650000000000000000" },
    });
  });

  it("recognizes comment type 105 in a binary IM response without fabricating missing content", () => {
    const body = encodeField(1, 2, encodeMessageBodyProto({
      conv_id: "conv-comment", server_id: 12345, sender_uid: "sender", type_code: 105,
      content: JSON.stringify({ itemId: "123456", aweme_title: "视频标题不是评论正文", comment_id: "987" }),
      create_time: 1700000000,
    }));
    const result = normalizeImapiResponse(matchImapiEndpoint("https://imapi.douyin.com/v1/message/get_by_conversation"), encodeResponseEnvelope(301, body));
    expect(result.chatMessages[0]).toMatchObject({ type: "comment", text: null, comment: { id: "987", author: null, text: null }, share: { title: "视频标题不是评论正文" } });
  });

  it("uses comment identity only for otherwise unclassified messages, never for plain text about comments", () => {
    const result = normalizeImapiResponse(matchImapiEndpoint("https://imapi.douyin.com/v1/message/get_by_conversation"), { msgs: [
      { server_id: "comment", type_code: 0, content_json: { comment_id: "987", itemId: "123456", comment: "原评论" } },
      { server_id: "text", type_code: 7, content_json: { text: "评论区很热闹", comment_id: "987", itemId: "123456" } },
      { server_id: "share", type_code: "share", content_json: { title: "视频评论区", itemId: "123456" } },
    ] });
    expect(result.chatMessages.find(message => message.id === "comment")).toMatchObject({ type: "comment", text: "原评论" });
    expect(result.chatMessages.find(message => message.id === "text")).toMatchObject({ type: "text", text: "评论区很热闹", share: null });
    expect(result.chatMessages.find(message => message.id === "share")).toMatchObject({ type: "share" });
  });

  it("normalizes JSON chat responses for text, image, sticker, share, and call messages", () => {
    const endpoint = matchImapiEndpoint("https://imapi.douyin.com/v1/message/get_by_conversation/");
    const result = normalizeImapiResponse(endpoint, {
      has_more: 1,
      next_ts: "1700000000000000",
      msgs: [
        {
          conv_id: "conv-1",
          server_id: "text-1",
          created_at_us: "1700000000000000",
          sender_uid: "user-1",
          type_code: 7,
          content_json: "{\"text\":\"你好呀\"}",
        },
        {
          conv_id: "conv-1",
          server_id: "image-1",
          created_at_us: "1700000001000000",
          sender_uid: "user-2",
          type_code: "image",
          content_json: { image_url: "https://p3.douyinpic.com/image.jpg" },
        },
        {
          conv_id: "conv-1",
          server_id: "sticker-1",
          created_at_us: "1700000002000000",
          sender_uid: "user-2",
          type_code: "sticker",
          content_json: { sticker_url: "https://p3.douyinpic.com/sticker.png", text: "贴纸" },
        },
        {
          conv_id: "conv-1",
          server_id: "share-1",
          created_at_us: "1700000003000000",
          sender_uid: "user-3",
          type_code: "share",
          content_json: {
            share: {
              title: "分享视频",
              author: "作者甲",
              cover_url: "https://p3.douyinpic.com/cover.jpg",
              share_url: "https://www.douyin.com/video/123?token=secret#trace",
            },
          },
        },
        {
          conv_id: "conv-1",
          server_id: "call-1",
          created_at_us: "1700000004000000",
          sender_uid: "user-4",
          type_code: "call",
          content_json: { duration_ms: 125000 },
        },
      ],
    });

    expect(result.pagination).toEqual({ hasMore: true, cursor: "1700000000000000" });
    expect(result.chatMessages).toHaveLength(5);
    expect(result.chatMessages.find((message) => message.id === "text-1")).toMatchObject({
      type: "text",
      text: "你好呀",
      sentAt: "2023-11-14T22:13:20.000Z",
    });
    expect(result.chatMessages.find((message) => message.id === "image-1")).toMatchObject({
      type: "image",
      mediaUrl: "https://p3.douyinpic.com/image.jpg",
    });
    expect(result.chatMessages.find((message) => message.id === "sticker-1")).toMatchObject({
      type: "sticker",
      mediaUrl: "https://p3.douyinpic.com/sticker.png",
      text: "贴纸",
    });
    expect(result.chatMessages.find((message) => message.id === "share-1")).toMatchObject({
      type: "share",
      text: "分享视频",
      share: {
        title: "分享视频",
        author: "作者甲",
        coverUrl: "https://p3.douyinpic.com/cover.jpg",
        url: "https://www.douyin.com/video/123",
      },
    });
    expect(result.chatMessages.find((message) => message.id === "call-1")).toMatchObject({
      type: "call",
      callDurationSeconds: 125,
    });
  });

  it("uses nested contact profile metadata when a response omits the catalog", () => {
    const endpoint = matchImapiEndpoint("https://imapi.douyin.com/v1/message/get_by_conversation");
    const result = normalizeImapiResponse(endpoint, {
      msgs: [{
        conv_id: "friend-profile",
        conversation_type: 1,
        server_id: "profile-message-1",
        sender: {
          uid: "contact-1",
          nickname: "联系人乙",
          avatar_thumb: { url_list: ["https://p3.douyinpic.com/contact-2.jpg"] },
        },
        type_code: 7,
        content_json: { text: "在吗" },
      }],
    });

    expect(result.chatMessages[0]).toMatchObject({
      senderId: "contact-1",
      senderName: "联系人乙",
      senderAvatarUrl: "https://p3.douyinpic.com/contact-2.jpg",
    });
    expect(result.conversations[0]).toMatchObject({
      id: "friend-profile",
      avatarUrl: "https://p3.douyinpic.com/contact-2.jpg",
    });
  });

  it("normalizes protobuf chat responses with the nested imapi wrapper", () => {
    const endpoint = matchImapiEndpoint("https://imapi.douyin.com/v1/message/get_by_user");
    const message = encodeMessageProto({
      conv_id: "conv-2",
      server_id: "proto-1",
      created_at_us: 1_700_000_005_000_000,
      order: 1,
      type_code: 7,
      sender_uid: "user-5",
      content_json: "{\"text\":\"protobuf text\"}",
    });
    const section = encodeField(1, 2, message);
    const wrapper = encodeField(301, 2, section);
    const response = encodeField(6, 2, wrapper);

    const result = normalizeImapiResponse(endpoint, response);

    expect(result.pagination).toEqual({ hasMore: null, cursor: null });
    expect(result.chatMessages).toEqual([expect.objectContaining({
      id: "proto-1",
      conversationId: "conv-2",
      senderId: "user-5",
      type: "text",
      text: "protobuf text",
    })]);
  });

  it("does not turn a pagination-only protobuf section into an unknown message", () => {
    const endpoint = matchImapiEndpoint("https://imapi.douyin.com/v1/message/get_by_conversation");
    const section = encodeMessage([
      // These are pagination fields, not a message envelope.
      encodeField(2, 0, 12345),
      encodeField(3, 0, 1),
    ]);
    const response = encodeField(6, 2, encodeField(301, 2, section));

    const result = normalizeImapiResponse(endpoint, response);

    expect(result.pagination).toEqual({ hasMore: true, cursor: "12345" });
    expect(result.chatMessages).toEqual([]);
  });

  it("drops empty numeric unknown records produced by an old adapter while keeping identified unknown messages", () => {
    const endpoint = matchImapiEndpoint("https://imapi.douyin.com/v1/message/get_by_conversation");
    const result = normalizeImapiResponse(endpoint, {
      msgs: [{
        conv_id: "conv-legacy",
        server_id: "7678560234599844388",
        sender_uid: "user-1",
      }, {
        conv_id: "conv-legacy",
        server_id: "legacy-file-1",
        sender_uid: "user-2",
        sender_name: "联系人",
      }],
    });

    expect(result.chatMessages).toEqual([expect.objectContaining({
      id: "legacy-file-1",
      type: "unknown",
      senderName: "联系人",
    })]);
  });

  it("unwraps the initial message feed and keeps the conversation id", () => {
    const endpoint = matchImapiEndpoint("https://imapi.douyin.com/v1/message/get_message_by_init");
    const message = encodeMessageBodyProto({
      conv_id: "",
      server_id: 123456789,
      type_code: 7,
      sender_uid: 99,
      content: "{\"text\":\"初始化消息\"}",
      create_time: 1_700_000_005_000,
    });
    const conversation = encodeMessage([
      encodeField(1, 2, encodeStringField(1, "conv-init")),
      encodeField(2, 2, message),
    ]);
    const body = encodeMessage([
      encodeField(1, 2, conversation),
      encodeField(2, 0, 0),
      encodeField(3, 0, 1_700_000_005_000),
    ]);

    const result = normalizeImapiResponse(endpoint, encodeResponseEnvelope(2043, body));

    expect(result.pagination).toEqual({ hasMore: false, cursor: "1700000005000" });
    expect(result.chatMessages).toEqual([expect.objectContaining({
      id: "123456789",
      conversationId: "conv-init",
      type: "text",
      text: "初始化消息",
      sentAt: "2023-11-14T22:13:25.000Z",
    })]);
  });

  it("reads a Chinese call duration without using adjacent message timestamps", () => {
    const endpoint = matchImapiEndpoint("https://imapi.douyin.com/v1/message/get_by_conversation");
    const result = normalizeImapiResponse(endpoint, {
      msgs: [{
        conv_id: "conv-call",
        server_id: "call-text-1",
        created_at_us: "1700000000000000",
        type_code: 0,
        content_json: { aweType: 193, tips: "通话了 3 分 28 秒" },
      }],
    });

    expect(result.chatMessages[0]).toMatchObject({
      type: "call",
      callDurationSeconds: 208,
      sentAt: "2023-11-14T22:13:20.000Z",
    });
  });

  it("reads the nested message returned by get_by_id", () => {
    const endpoint = matchImapiEndpoint("https://imapi.douyin.com/v1/message/get_by_id");
    const message = encodeMessageProto({
      conv_id: "conv-by-id",
      server_id: "by-id-1",
      created_at_us: 1_700_000_005_000_000,
      order: 1,
      type_code: 7,
      sender_uid: "user-by-id",
      content_json: "{\"text\":\"按 ID 读取\"}",
    });
    const envelope = encodeMessage([
      encodeField(1, 0, 0),
      encodeField(2, 2, message),
    ]);
    const command = encodeField(211, 2, encodeField(1, 2, envelope));
    const response = encodeMessage([encodeField(6, 2, command)]);

    const result = normalizeImapiResponse(endpoint, response);

    expect(result.chatMessages).toEqual([expect.objectContaining({
      id: "by-id-1",
      conversationId: "conv-by-id",
      text: "按 ID 读取",
    })]);
  });

  it("leaves duration unavailable when the call system message omits it", () => {
    const endpoint = matchImapiEndpoint("https://imapi.douyin.com/v1/message/get_by_conversation");
    const result = normalizeImapiResponse(endpoint, {
      msgs: [{ server_id: "call-no-duration", content_json: { aweType: 193, tips: "通话成功" } }],
    });
    expect(result.chatMessages[0]).toMatchObject({ type: "call", callDurationSeconds: null });
  });

  it("uses Douyin's direct share-card fields when no nested share object exists", () => {
    const endpoint = matchImapiEndpoint("https://imapi.douyin.com/v1/message/get_by_conversation");
    const result = normalizeImapiResponse(endpoint, {
      msgs: [{
        server_id: "share-direct",
        type_code: 0,
        content_json: {
          aweType: 11054,
          content_title: "直接分享标题",
          content_name: "分享作者",
          cover_url: { url_list: ["https://p3.douyinpic.com/direct-cover.jpg"] },
          itemId: "456",
        },
      }],
    });
    expect(result.chatMessages[0]).toMatchObject({
      type: "share",
      share: {
        title: "直接分享标题",
        author: "分享作者",
        coverUrl: "https://p3.douyinpic.com/direct-cover.jpg",
        url: "https://www.douyin.com/video/456",
      },
    });
  });

  it("keeps an aweType-only title as ordinary text when share metadata is absent", () => {
    const endpoint = matchImapiEndpoint("https://imapi.douyin.com/v1/message/get_by_conversation");
    const result = normalizeImapiResponse(endpoint, {
      msgs: [{
        server_id: "plain-with-awe-type",
        type_code: 0,
        content_json: {
          aweType: 11054,
          content_title: "把手伸模型佬的钱包里就算了",
        },
      }],
    });

    expect(result.chatMessages[0]).toMatchObject({
      type: "text",
      text: "把手伸模型佬的钱包里就算了",
      share: null,
    });
  });

  it("keeps a nested title-only payload as ordinary text", () => {
    const endpoint = matchImapiEndpoint("https://imapi.douyin.com/v1/message/get_by_conversation");
    const result = normalizeImapiResponse(endpoint, {
      msgs: [{
        server_id: "plain-nested-share",
        type_code: 0,
        content_json: { share: { title: "只是普通正文" } },
      }],
    });

    expect(result.chatMessages[0]).toMatchObject({ type: "text", text: "只是普通正文", share: null });
  });

  it("does not downgrade a share that has a cover or link", () => {
    const endpoint = matchImapiEndpoint("https://imapi.douyin.com/v1/message/get_by_conversation");
    const result = normalizeImapiResponse(endpoint, {
      msgs: [{
        server_id: "share-with-evidence",
        type_code: 0,
        content_json: {
          aweType: 11054,
          content_title: "真正的分享",
          cover_url: { url_list: ["https://p3.douyinpic.com/real-cover.jpg"] },
          itemId: "789",
        },
      }],
    });

    expect(result.chatMessages[0]).toMatchObject({
      type: "share",
      share: {
        title: "真正的分享",
        coverUrl: "https://p3.douyinpic.com/real-cover.jpg",
        url: "https://www.douyin.com/video/789",
      },
    });
  });

  it("recognizes a direct Douyin URL as share evidence", () => {
    const endpoint = matchImapiEndpoint("https://imapi.douyin.com/v1/message/get_by_conversation");
    const result = normalizeImapiResponse(endpoint, {
      msgs: [{
        server_id: "share-direct-url",
        type_code: 0,
        content_json: {
          aweType: 11054,
          title: "直接链接分享",
          url: "https://www.douyin.com/video/987?from=chat",
        },
      }],
    });

    expect(result.chatMessages[0]).toMatchObject({
      type: "share",
      share: { title: "直接链接分享", url: "https://www.douyin.com/video/987" },
    });
  });

  it("keeps a nested media payload as a video message", () => {
    const endpoint = matchImapiEndpoint("https://imapi.douyin.com/v1/message/get_by_conversation");
    const result = normalizeImapiResponse(endpoint, {
      msgs: [{
        server_id: "video-message",
        type_code: 0,
        content_json: {
          video: { title: "视频消息", duration: 12, play_url: "https://p3.douyinvod.com/play" },
          poster: { origin_url_list: ["https://p3.douyinpic.com/poster.jpg"] },
        },
      }],
    });

    expect(result.chatMessages[0]).toMatchObject({ type: "video", text: "视频消息" });
  });

  it("returns conversation metadata so group bodies can be discarded", () => {
    const endpoint = matchImapiEndpoint("https://imapi.douyin.com/v1/message/get_by_conversation");
    const result = normalizeImapiResponse(endpoint, {
      conversations: [{
        id: "group-1",
        type: 2,
        name: "测试群",
        avatar_thumb: { url_list: ["https://p3.douyinpic.com/group-avatar.jpg"] },
      }],
      msgs: [{
        conv_id: "group-1",
        conversation_type: 2,
        server_id: "group-message-1",
        sender_uid: "user-1",
        type_code: 7,
        content_json: { text: "群聊正文" },
      }],
    });

    expect(result.conversations).toEqual([{
      id: "group-1",
      kind: "group",
      name: "测试群",
      avatarUrl: "https://p3.douyinpic.com/group-avatar.jpg",
    }]);
    expect(result.chatMessages[0]).toMatchObject({ conversationType: "group" });
  });
});

describe("ChatConversationAccumulator", () => {
  it("counts unique group messages and messages sent by the current user", () => {
    const accumulator = new ChatConversationAccumulator([], "me");
    accumulator.addConversations([{ id: "group-1", kind: "group", name: "测试群" }]);
    accumulator.addMessages([
      { id: "m-1", conversationId: "group-1", conversationType: "group", senderId: "me" },
      { id: "m-1", conversationId: "group-1", conversationType: "group", senderId: "me" },
      { id: "m-2", conversationId: "group-1", conversationType: "group", senderId: "other" },
    ]);
    accumulator.addConversations([{ id: "group-1", kind: "friend", name: "误分类" }]);
    expect(accumulator.snapshot()).toEqual([expect.objectContaining({
      id: "group-1",
      kind: "group",
      name: "测试群",
      messageCount: 2,
      ownMessageCount: 1,
    })]);
  });

  it("keeps a contact nickname and allow-listed avatar across catalog and messages", () => {
    const accumulator = new ChatConversationAccumulator([], "me");
    accumulator.addConversations([{
      id: "friend-1",
      kind: "friend",
      nickname: "小红",
      avatar: { url_list: ["https://p3.douyinpic.com/friend-avatar.jpg"] },
    }]);
    accumulator.addMessages([{
      id: "friend-message-1",
      conversationId: "friend-1",
      conversationType: "friend",
      senderId: "friend-id",
      senderName: "小红",
    }]);
    expect(accumulator.snapshot()).toEqual([expect.objectContaining({
      id: "friend-1",
      name: "小红",
      avatarUrl: "https://p3.douyinpic.com/friend-avatar.jpg",
      messageCount: 1,
    })]);
  });

  it("does not reintroduce an empty numeric placeholder through the message accumulator", () => {
    const accumulator = new ChatMessageAccumulator();
    accumulator.addMessages([{
      id: "7678560234599844388",
      conversationId: "conv-1",
      conversationType: "friend",
      conversationName: null,
      senderId: "me",
      senderName: null,
      sentAt: "2026-08-27T04:15:21.000Z",
      type: "unknown",
      text: null,
      mediaUrl: null,
      share: null,
      callDurationSeconds: null,
    }]);

    expect(accumulator.snapshot()).toEqual([]);
  });
});

describe("friend online status", () => {
  const STATUS_URL = "https://www.douyin.com/aweme/v1/web/im/user/active/status/?device_platform=webapp";

  it("recognises the site's own status endpoint without claiming other douyin URLs", () => {
    expect(matchChatEndpoint(STATUS_URL)).toEqual({
      kind: "chat_presence",
      pathname: "/aweme/v1/web/im/user/active/status",
    });
    expect(matchChatEndpoint("https://www.douyin.com/aweme/v1/web/im/user/active/update/")).toBeNull();
    expect(matchChatEndpoint("https://evil.example.com/aweme/v1/web/im/user/active/status/")).toBeNull();
    expect(matchChatEndpoint("https://douyin.com.evil.example/aweme/v1/web/im/user/active/status/")).toBeNull();
    // Douyin answers this from sharded hosts, not only www.
    expect(matchChatEndpoint("https://www-hj.douyin.com/aweme/v1/web/im/user/active/status/")?.kind).toBe("chat_presence");
    // The message endpoints must keep matching as before.
    expect(matchChatEndpoint("https://imapi.douyin.com/v1/message/get_by_conversation")?.kind).toBe("chat_messages");
  });

  it("reads seconds into timestamps and drops rows without a usable one", () => {
    const body = JSON.stringify({
      status_code: 0,
      data: [
        { sec_user_id: "sec-a", last_active_time: 1_758_182_400 },
        { sec_user_id: "sec-b", last_active_time: 0 },
        { sec_user_id: "", last_active_time: 1_758_182_400 },
        { last_active_time: 1_758_182_400 },
      ],
    });
    expect(normalizeChatPresence(body)).toEqual([
      { secUid: "sec-a", lastActiveAt: "2025-09-18T08:00:00.000Z" },
    ]);
    // Playwright hands back a Buffer when the response is not parsed as JSON.
    expect(normalizeChatPresence(Buffer.from(body, "utf8"))).toHaveLength(1);
  });

  it("joins presence that arrived before the conversation catalog was read", () => {
    const accumulator = new ChatConversationAccumulator();
    accumulator.applyPresence([{ secUid: "sec-a", lastActiveAt: "2025-09-18T08:00:00.000Z" }]);
    accumulator.addConversations([{ id: "conv-a", kind: "friend", name: "甲", secUid: "sec-a" }]);
    expect(accumulator.snapshot()[0].lastActiveAt).toBe("2025-09-18T08:00:00.000Z");
  });

  it("attaches presence to the matching one-to-one conversation only", () => {
    const accumulator = new ChatConversationAccumulator([
      { id: "conv-a", kind: "friend", name: "甲", secUid: "sec-a" },
      { id: "conv-b", kind: "friend", name: "乙", secUid: "sec-b" },
      { id: "conv-g", kind: "group", name: "群" },
    ]);
    accumulator.applyPresence([{ secUid: "sec-a", lastActiveAt: "2025-09-18T08:00:00.000Z" }]);
    const byId = new Map(accumulator.snapshot().map((conversation) => [conversation.id, conversation]));
    expect(byId.get("conv-a").lastActiveAt).toBe("2025-09-18T08:00:00.000Z");
    expect(byId.get("conv-b").lastActiveAt).toBeNull();
    expect(byId.get("conv-g").lastActiveAt).toBeNull();
  });
});

describe("Douyin's own notices", () => {
  it("keeps a templated notice in a new chat as a system line, not a message you sent", () => {
    const { messages } = normalizeChatPayload({ msgs: [{
      server_id: "7689823287246178873", sender_uid: "607350412292247", type_code: 7, created_at: 1790412109792,
      content_json: { text: "对方回复或关注你之前，只能发送一条文字消息。请礼貌发言，自觉遵守{{0}}", aweType: 700 },
    }] }, { conversationId: "0:1:70433296616:607350412292247", conversationType: 1 });
    expect(messages[0]).toMatchObject({ type: "system", text: "对方回复或关注你之前，只能发送一条文字消息。请礼貌发言，自觉遵守" });
    const accumulator = new ChatConversationAccumulator([], "607350412292247");
    accumulator.addMessages(messages);
    expect(accumulator.snapshot()[0]).toMatchObject({ messageCount: 1, ownMessageCount: 0 });
  });
});
