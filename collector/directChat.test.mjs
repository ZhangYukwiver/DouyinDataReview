import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DirectChatClient, buildDirectImRequest, parseDirectConversation } from "./directChat.mjs";
import { directSessionFixture, directApiFixture, imResponse, imConversation, imMessage } from "./fixtures/directClient.mjs";
import { decodeProto, encodeProto, protoNumber as n, protoMessage as m, protoString as s, protoMapEntry as kv, protoInteger, protoChild, protoChildren, protoText } from "./directProto.mjs";
import { normalizeChatPayload } from "./chatNormalizer.mjs";
import { DouyinCollector } from "./douyinCollector.mjs";
import { createEmptyRecords } from "./normalizer.mjs";

const cid="0:1:123:456", gid="0:2:group", serverId="7654321098765432199";
const conversation=()=>({id:cid,shortId:"7654321098765432100",type:1,ticket:"fake-conversation-ticket",kind:"friend",name:"好友"});
afterEach(()=>vi.useRealTimers());
function handler(url,options) {
  if(url.pathname.includes("/query/user/")) return {payload:{status_code:0,user_uid:"123",id:"9876543210123456789"}};
  if(url.pathname.includes("/user/profile/other/")) return {payload:{status_code:0,user:{uid:url.searchParams.get("user_id"),nickname:"联系人资料",
    sec_uid:`MS4w${"x".repeat(24)}`,avatar_thumb:{url_list:["https://p3.douyinpic.com/contact.jpg"]}}}};
  if(url.pathname.includes("get_identity_security_token")) return {payload:{message:"success",data:{identity_security_token:"fake-identity",device_id:"9876543210123456789"}}};
  if(url.pathname.includes("get_info_list")) return {buffer:imResponse(610,[m(1,imConversation())])};
  if(url.pathname.endsWith("/send")) return {buffer:imResponse(100,[n(1,serverId),n(3,0),s(4,protoText(protoChild(protoChild(decodeProto(options.data),8),100),8)),n(5,0)])};
  if(url.pathname.includes("get_message_by_init")) return {buffer:imResponse(2043,[m(1,[m(1,imConversation())]),n(2,0)])};
  if(url.pathname.includes("get_by_conversation")) return {buffer:imResponse(301,[m(1,imMessage("11111")),n(2,0),n(3,0)])};
  throw new Error(`unexpected test endpoint ${url.pathname}`);
}
const frame=(id,{group=false,text="实时消息",time=1_791_700_000_000_000n}={})=>encodeProto([s(6,""),s(7,"pb"),m(8,[n(1,500),n(3,0),m(6,[m(500,[s(2,group?gid:cid),n(3,group?2:1),m(5,imMessage(id,{conversationId:group?gid:cid,type:group?2:1,text,time}))])])])]);

describe("native chat protocol",()=>{
  it("uses the captured PC IM authentication envelope for reads and sends",()=>{
    for(const command of [2043,301,100]) {
      const fields=decodeProto(buildDirectImRequest(directSessionFixture(),command,[],{sequence:10001}));
      expect(protoInteger(fields,18)).toBe("1"); expect(protoInteger(fields,6)).toBe(command===100?"0":"1");
      expect(protoText(fields,4)).toBe(""); expect(protoText(fields,7)).toBe("0d50935:feat/pc-im-group");
    }
  });
  it("pages init with the next cursor and retains 64-bit conversation identifiers",async()=>{
    const fixture=directApiFixture((url,options)=>{
      if(!url.pathname.includes("get_message_by_init")) return handler(url,options);
      const body=protoChild(protoChild(decodeProto(options.data),8),2043), page=protoInteger(body,2);
      if(page==="0") expect(protoInteger(body,1)).toBeNull(); else expect(protoInteger(body,1)).toBe("1791700000000000");
      return {buffer:imResponse(2043,[m(1,[m(1,imConversation(page==="0"?cid:gid,page==="0"?1:2))]),n(2,page==="0"?1:0),n(3,"1791700000000000")])};
    });
    const chat=new DirectChatClient(fixture.api), payloads=[];
    await chat.initialize({onPayload:payload=>payloads.push(payload)});
    expect(chat.conversations.size).toBe(2); expect(chat.conversations.get(cid).shortId).toBe("7654321098765432100");
    expect(payloads).toHaveLength(2); await fixture.api.close();
  });
  it("rejects missing pagination rather than claiming history is complete",async()=>{
    const {api}=directApiFixture((url,options)=>url.pathname.includes("get_message_by_init") ? {buffer:imResponse(2043,[])} : handler(url,options));
    await expect(new DirectChatClient(api).initialize()).rejects.toMatchObject({code:"pagination_missing"}); await api.close();
  });
  it("fills unnamed IM conversations and senders from the matching contact profile and reuses the cache",async()=>{
    const peer="9876543210123456789", id=`0:1:${peer}:123`, avatar="https://p3.douyinpic.com/friend.jpg";
    const {api,fetch}=directApiFixture((url,options)=>{
      if(url.pathname.includes("/user/profile/other/")) {
        expect(url.searchParams.get("user_id")).toBe(peer);
        return {payload:{status_code:0,user:{uid:peer,nickname:"好友昵称",remark_name:"好友备注",sec_uid:`MS4w${"a".repeat(24)}`,avatar_larger:{url_list:[avatar]}}}};
      }
      if(url.pathname.includes("get_message_by_init")) return {buffer:imResponse(2043,[m(1,[m(1,[s(1,id),n(2,"7654321098765432100"),n(3,1),m(50,[])]),
        m(2,imMessage("98765",{conversationId:id,sender:peer}))]),n(2,0)])};
      return handler(url,options);
    });
    const chat=new DirectChatClient(api),payloads=[];
    try {
      await chat.initialize({onPayload:payload=>payloads.push(payload)});
      await chat.initialize();
      expect(chat.conversations.get(id)).toMatchObject({name:"好友备注",avatarUrl:avatar,secUid:`MS4w${"a".repeat(24)}`});
      expect(payloads[0].conversations[0]).toMatchObject({id,name:"好友备注",avatarUrl:avatar});
      expect(payloads[0].messages[0]).toMatchObject({conversationName:"好友备注",senderName:"好友备注",senderAvatarUrl:avatar});
      expect(fetch.mock.calls.filter(([url])=>url.includes("/user/profile/other/"))).toHaveLength(1);
    } finally {await api.close();}
  });
  it("keeps the self chat label and attaches its profile avatar",async()=>{
    const {api}=directApiFixture(handler), chat=new DirectChatClient(api);
    try {
      const payload=await chat.enrichPayload({conversations:[{id:"0:1:123:123",kind:"friend",name:null}],messages:[]});
      expect(payload.conversations[0]).toMatchObject({name:"我自己",avatarUrl:"https://p3.douyinpic.com/contact.jpg"});
    } finally {await api.close();}
  });
  it("ignores profiles belonging to a different uid and ids outside the current account",async()=>{
    const {api,fetch}=directApiFixture((url,options)=>url.pathname.includes("/user/profile/other/")
      ? {payload:{status_code:0,user:{uid:"999",nickname:"别人的资料",avatar_thumb:{url_list:["https://p3.douyinpic.com/wrong.jpg"]}}}} : handler(url,options));
    const chat=new DirectChatClient(api);
    try {
      const payload=await chat.enrichPayload({conversations:[{id:cid,kind:"friend",name:null},{id:"0:1:777:888",kind:"friend",name:null}],messages:[]});
      expect(payload.conversations.every(row=>row.name===null&&!row.avatarUrl)).toBe(true);
      expect(fetch.mock.calls.filter(([url])=>url.includes("/user/profile/other/"))).toHaveLength(1);
    } finally {await api.close();}
  });
  it("retains history when a contact profile is unavailable, but surfaces login failures",async()=>{
    let failure=500;
    const {api}=directApiFixture((url,options)=>url.pathname.includes("/user/profile/other/")
      ? {payload:{status_code:failure}} : handler(url,options));
    const chat=new DirectChatClient(api);
    try {
      await expect(chat.initialize()).resolves.toHaveLength(1);
      expect((await chat.messages({conversationId:cid})).messages[0].text).toBe("测试消息");
      failure=8;
      chat.profileCheckedAt.clear();
      await expect(chat.initialize()).rejects.toMatchObject({code:"login_required"});
    } finally {await api.close();}
  });
  it("reads the group icon without requesting a one-to-one user profile",async()=>{
    const avatar="https://p3.douyinpic.com/group.jpg", {api,fetch}=directApiFixture(handler), chat=new DirectChatClient(api);
    try {
      const group=parseDirectConversation(imConversation(gid,2,[s(7,avatar)]));
      const payload=await chat.enrichPayload({conversations:[group],messages:[]});
      expect(payload.conversations[0]).toMatchObject({name:"群聊",avatarUrl:avatar});
      expect(fetch).not.toHaveBeenCalled();
    } finally {await api.close();}
  });
  it("exposes every older batch even after the display cache reaches 1000 messages",async()=>{
    let page=0;
    const {api}=directApiFixture((url,options)=>{
      if(!url.pathname.includes("get_by_conversation")) return handler(url,options);
      page++; const rows=Array.from({length:50},(_,index)=>m(1,imMessage(String(100000-page*50-index),{time:1_791_700_000_000_000n-BigInt(page*50+index)*1_000_000n})));
      return {buffer:imResponse(301,[...rows,n(2,1_791_700_000_000_000n-BigInt(page)*50_000_000n),n(3,page<21?1:0)])};
    });
    const chat=new DirectChatClient(api); chat.conversations.set(cid,conversation());const collected=new Set();let result;
    for(let index=0;index<21;index++) { result=await chat.messages({conversationId:cid,older:index>0}); result.pageMessages.forEach(msg=>collected.add(msg.id)); }
    expect(collected.size).toBe(1050); expect(result.messages).toHaveLength(1000); expect(result.hasMore).toBe(false); await api.close();
  });
  it("confirms a server receipt, sends identity material, and honors moderation",async()=>{
    const {api,fetch}=directApiFixture(handler);const chat=new DirectChatClient(api);chat.conversations.set(cid,conversation());
    const input={requestId:"request-chat-123456",conversationId:cid,text:"测试消息"};
    const result=await chat.send(input); expect(result.outcome).toBe("confirmed"); expect(result.chatMessage).toMatchObject({senderId:"123",text:"测试消息"});
    const [url,options]=fetch.mock.calls.find(([url])=>url.includes("/message/send"));
    const fields=decodeProto(options.data),map=Object.fromEntries(protoChildren(fields,15).map(entry=>[protoText(entry,1),protoText(entry,2)]));
    expect(JSON.parse(map.identity_security_token)).toEqual({token:"fake-identity"});
    expect(new URL(url).searchParams.get("msToken")).toHaveLength(176); expect(options.headers["bd-ticket-guard-client-data"]).toBeTruthy();
    expect(options.headers["x-secsdk-csrf-token"]).toBeUndefined();
    api.raw=async()=>({buffer:imResponse(100,[n(1,serverId),n(3,0),s(4,"request-moderated-123"),n(5,1)])});
    chat.refreshConversation=async()=>conversation();
    expect((await chat.send({...input,requestId:"request-moderated-123"})).outcome).toBe("rejected"); await api.close();
  });
  it("keeps transport failures ambiguous without retrying, and throws pre-dispatch failures",async()=>{
    const {api,fetch}=directApiFixture((url,options)=>url.pathname.endsWith("/send") ? Promise.reject(new Error("closed")) : handler(url,options));
    const chat=new DirectChatClient(api);chat.conversations.set(cid,conversation());const onDispatch=vi.fn();
    expect((await chat.send({requestId:"request-unknown-12345",conversationId:cid,text:"测试"},{onDispatch})).outcome).toBe("unknown");
    expect(onDispatch).toHaveBeenCalledOnce(); expect(fetch.mock.calls.filter(([url])=>url.includes("/message/send"))).toHaveLength(1);
    chat.identity=null; api.raw=async()=>({text:JSON.stringify({message:"error"})});
    await expect(chat.send({requestId:"request-preflight-123",conversationId:cid,text:"测试"})).rejects.toMatchObject({code:"identity_token_rejected"});
    expect(onDispatch).toHaveBeenCalledOnce(); await api.close();
  });
  it("does not confirm a receipt belonging to a different client message",async()=>{
    const {api}=directApiFixture((url,options)=>url.pathname.endsWith("/send")
      ? {buffer:imResponse(100,[n(1,serverId),n(3,0),s(4,"another-request-123456"),n(5,0)])} : handler(url,options));
    const chat=new DirectChatClient(api);chat.conversations.set(cid,conversation());
    expect((await chat.send({requestId:"request-chat-123456",conversationId:cid,text:"测试"})).outcome).toBe("unknown");await api.close();
  });
  it("reads official streak windows from the server's conversation ext",async()=>{
    const {api}=directApiFixture((url,options)=>url.pathname.includes("get_info_list") ? {buffer:imResponse(610,[m(1,imConversation(cid,1,[kv(11,"a:consecutive_chat_data",JSON.stringify({flame_infos:[{start:1791500000,end:1791700000,real_days:12,state:1}]}))]))])} : handler(url,options));
    const chat=new DirectChatClient(api);chat.conversations.set(cid,conversation());
    expect((await chat.streaks()).streaks[0]).toMatchObject({conversationId:cid,windows:[{days:12,state:1}]}); await api.close();
  });
  it("reconnects and reads the latest server messages missed while disconnected",async()=>{
    let initialized=0;const sockets=[],received=[],errors=[];
    const {api}=directApiFixture((url,options)=>url.pathname.includes("get_message_by_init")
      ? {buffer:imResponse(2043,[m(1,[m(1,imConversation()),m(2,imMessage(String(90000+(++initialized))))]),n(2,0)])} : handler(url,options));
    const chat=new DirectChatClient(api,{socketFactory:()=>{const socket=new EventEmitter();socket.terminate=()=>socket.emit("close");sockets.push(socket);queueMicrotask(()=>socket.emit("open"));return socket;}});
    try {
      await chat.connect({onPayload:payload=>received.push(...payload.messages.map(msg=>msg.id)),onConnection:()=>{},onError:error=>errors.push(error)});
      await vi.waitFor(()=>expect(received).toContain("90001"));sockets[0].emit("close");
      await vi.waitFor(()=>expect(received).toContain("90002"),{timeout:3000});
      expect(sockets).toHaveLength(2);expect(errors).toEqual([]);
    } finally {await chat.close();await api.close();}
  });
});

describe("production HTTP chat entry",()=>{
  it("receives live pushes, protects group text, deduplicates sends and releases its socket without Chromium",async()=>{
    let socket;
    const {api,fetch}=directApiFixture((url,options)=>url.pathname.includes("get_message_by_init")
      ? {buffer:imResponse(2043,[m(1,[m(1,imConversation())]),m(1,[m(1,imConversation(gid,2)),m(2,imMessage("44444",{conversationId:gid,type:2,text:"群内容",time:1_780_000_000_000_000n}))]),n(2,0)])}
      : handler(url,options));
    api.chatClient=new DirectChatClient(api,{socketFactory:()=>{socket=new EventEmitter();socket.terminate=()=>socket.emit("close");queueMicrotask(()=>socket.emit("open"));return socket;}});
    const store={save:vi.fn(async(records,warnings,options)=>({schemaVersion:2,records,warnings,updatedAt:new Date().toISOString(),...options}))};
    const collector=new DouyinCollector({dataDirectory:".test",store,account:{id:"default",uid:"123"}});
    collector.snapshot={schemaVersion:2,records:createEmptyRecords(),chatMessages:[],chatConversations:[{id:gid,kind:"group",name:"群聊",messageCount:12,ownMessageCount:5}],warnings:[],updatedAt:"2026-10-01T00:00:00Z"};
    collector.ensureDirectApi=vi.fn(async()=>api);collector.ensureBrowser=vi.fn(()=>{throw new Error("browser must not launch");});
    try {
      expect(collector.startChatObservation()).toBe(true);
      await vi.waitFor(()=>expect(collector.chat?.historyReady).toBe(true));
      expect(collector.snapshot.chatConversations.find(c=>c.id===cid)).toMatchObject({name:"联系人资料",avatarUrl:"https://p3.douyinpic.com/contact.jpg"});
      socket.emit("message",frame("22222"),true);socket.emit("message",frame("33333",{group:true,text:"不得落盘的群正文"}),true);socket.emit("message",frame("33333",{group:true,text:"不得落盘的群正文"}),true);
      await vi.waitFor(()=>expect(collector.snapshot.chatMessages.some(msg=>msg.text==="实时消息")).toBe(true));
      expect(JSON.stringify(collector.snapshot)).not.toContain("不得落盘的群正文");
      expect(collector.snapshot.chatConversations.find(c=>c.id===gid).messageCount).toBe(13);
      const input={requestId:"request-http-entry-123",conversationId:cid,text:"本机测试"};
      const results=await Promise.all([collector.sendChatMessage(input),collector.sendChatMessage(input)]);
      expect(results[0]).toEqual(results[1]);expect(results[0].outcome).toBe("confirmed");
      expect(fetch.mock.calls.filter(([url])=>url.includes("/message/send"))).toHaveLength(1);
      expect(collector.ensureBrowser).not.toHaveBeenCalled();
    } finally {await collector.stopChatObservation();await collector.close();}
    expect(collector.chatPromise).toBeNull();expect(collector.status.chat.state).toBe("idle");
  });
});
