import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Modal } from "react-native";
import { ArrowDown, ArrowUpRight, Maximize, MessageSquareOff, MessageSquareText, Minimize, SlidersHorizontal, Volume2, VolumeX, X } from "lucide-react-native";
import { splitChatEmoji } from "../../domain/chatEmoji";
import type { ExploreConnection } from "../../services/explorer";
import { LocalCollectorError } from "../../services/localCollector";
import {
  closeLiveRoom, DANMAKU_AREAS, DANMAKU_SPEED, DEFAULT_DANMAKU, isDanmakuBlocked, liveRoomIdFrom, loadDanmakuSettings, openLiveRoom,
  parseBlockedWords, readLiveRoom, saveDanmakuSettings, type DanmakuSettings, type DanmakuSpeed, type LiveDanmaku, type LiveRoomState,
} from "../../services/liveRoom";
import { waitForCollector } from "../../services/videoFeed";
import { count, EmojiText } from "./RecordVideoPlayer";
import "./RecordVideoPlayer.css";

export interface LiveTarget { room: string; title?: string; anchor?: string | null; cover?: string | null }

const LIST_LIMIT = 200;
const AREA_NAMES = ["1/4", "半屏", "3/4", "满屏"];
const SPEED_NAMES: Array<[DanmakuSpeed, string]> = [["slow", "慢"], ["normal", "适中"], ["fast", "快"]];

/** 弹幕层：每条是一个匀速从右往左滚的 div；每条轨道记着上一条尾巴完全进场的时刻，没空轨道就丢掉这一条。 */
function createDanmakuLayer(layer: HTMLDivElement) {
  let freeAt: number[] = [];
  return {
    push(text: string, settings: DanmakuSettings) {
      const width = layer.clientWidth, lineHeight = Math.round(settings.size * 1.45);
      const lanes = Math.max(1, Math.floor(layer.clientHeight / lineHeight));
      const now = performance.now();
      const lane = Array.from({ length: lanes }, (_, index) => index).find((index) => (freeAt[index] ?? 0) <= now);
      if (!width || lane === undefined) return;
      const item = document.createElement("div");
      item.className = "lv-dm";
      for (const part of splitChatEmoji(text)) {
        if (!("emoji" in part)) { item.append(part.text); continue; }
        const image = document.createElement("img");
        image.src = part.url; image.alt = part.emoji; image.referrerPolicy = "no-referrer";
        item.append(image);
      }
      item.style.top = `${lane * lineHeight}px`;
      layer.append(item);
      const speed = DANMAKU_SPEED[settings.speed] / 1000, itemWidth = item.offsetWidth;
      const animation = item.animate([{ transform: `translateX(${width}px)` }, { transform: `translateX(${-itemWidth}px)` }],
        { duration: (width + itemWidth) / speed, easing: "linear", fill: "both" });
      // 起跑时刻钉在现在：页面卡了几帧才画，位置也照时间算，同一条轨道上的弹幕不会挤到一起
      animation.startTime = now;
      animation.onfinish = () => item.remove();
      freeAt[lane] = now + (itemWidth + 32) / speed;
    },
    clear() { layer.replaceChildren(); freeAt = []; },
  };
}

type Props = {
  target: LiveTarget;
  connection: ExploreConnection | null;
  onClose: () => void;
  onOpenRecord?: (url: string) => Promise<void>;
  onOpenSettings?: () => void;
};

export function LiveRoomPlayer({ target, connection, onClose, onOpenRecord, onOpenSettings }: Props) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<LiveRoomState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [disconnected, setDisconnected] = useState(false);
  const [messages, setMessages] = useState<LiveDanmaku[]>([]);
  const [quality, setQuality] = useState<string | null>(null);
  const [videoAttempt, setVideoAttempt] = useState(0);
  const [videoError, setVideoError] = useState(false);
  const [buffering, setBuffering] = useState(true);
  const [muted, setMuted] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [settings, setSettings] = useState(loadDanmakuSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [blockText, setBlockText] = useState(() => settings.blocked.join(" "));
  const [unread, setUnread] = useState(false);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const stageRef = useRef<HTMLDivElement | null>(null);
  const layerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const engine = useRef<ReturnType<typeof createDanmakuLayer> | null>(null);
  const room = state?.room ?? null;
  const stream = room?.qualities.find((item) => item.key === quality) ?? room?.qualities[0] ?? null;
  const roomUrl = `https://live.douyin.com/${room?.webRid ?? liveRoomIdFrom(target.room) ?? ""}`;

  // 一批弹幕（每秒取一次）在这一秒里摊开放，不然会一起蹦出来
  const deliver = (batch: LiveDanmaku[]) => {
    if (!batch.length) return;
    setMessages((list) => [...list, ...batch].slice(-LIST_LIMIT));
    batch.forEach((message, index) => setTimeout(() => {
      const current = settingsRef.current;
      if (current.enabled && !isDanmakuBlocked(message.text, current.blocked)) engine.current?.push(message.text, current);
    }, index * 1000 / batch.length));
  };

  useEffect(() => { saveDanmakuSettings(settings); }, [settings]);
  useEffect(() => { if (!settings.enabled) engine.current?.clear(); }, [settings.enabled]);
  useLayoutEffect(() => {
    if (layerRef.current && !engine.current) engine.current = createDanmakuLayer(layerRef.current);
  });
  useEffect(() => {
    const sync = () => setFullscreen(Boolean(stageRef.current) && document.fullscreenElement === stageRef.current);
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  // 进房：采集器开标签页读直播间信息；没在播的直播间不占着标签页
  useEffect(() => {
    if (!connection) return;
    const controller = new AbortController();
    let opened: string | null = null;
    setState(null); setError(null); setDisconnected(false); setMessages([]); setVideoError(false); engine.current?.clear();
    void waitForCollector(() => openLiveRoom(connection, target.room, controller.signal), controller.signal).then((result) => {
      if (controller.signal.aborted || !result.room?.live) { void closeLiveRoom(connection, result.id).catch(() => {}); }
      if (controller.signal.aborted) return;
      if (result.room?.live) opened = result.id;
      setState(result);
      setQuality(result.room?.defaultQuality ?? null);
      deliver(result.messages);
    }).catch((cause) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "直播间没打开，请稍后重试。");
    });
    return () => {
      controller.abort();
      if (opened) void closeLiveRoom(connection, opened).catch(() => {});
    };
  }, [connection?.baseUrl, connection?.token, target.room, attempt]);

  // 每秒取一次新弹幕、在线人数和点赞
  const liveId = room?.live ? state!.id : null;
  useEffect(() => {
    if (!connection || !liveId) return;
    const controller = new AbortController();
    let cursor = state!.cursor, failures = 0, timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const next = await readLiveRoom(connection, liveId, cursor, controller.signal);
        failures = 0;
        cursor = next.cursor;
        setState((current) => current && { ...current, online: next.online, likes: next.likes, ended: next.ended });
        deliver(next.messages);
      } catch (cause) {
        if (controller.signal.aborted) return;
        if ((cause instanceof LocalCollectorError && cause.code === "session_expired") || ++failures >= 5) { setDisconnected(true); return; }
      }
      timer = setTimeout(tick, 1000);
    };
    timer = setTimeout(tick, 1000);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [connection?.baseUrl, connection?.token, liveId]);

  // 有点击进来的用户手势，一般能带声音自动播；被拦就先静音播
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !stream) return;
    setBuffering(true); setVideoError(false);
    video.muted = muted;
    void video.play().catch(() => { video.muted = true; setMuted(true); void video.play().catch(() => {}); });
  }, [stream?.url, videoAttempt]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    if (stick.current) list.scrollTop = list.scrollHeight;
    else setUnread(true);
  }, [messages]);

  const update = (patch: Partial<DanmakuSettings>) => setSettings((current) => ({ ...current, ...patch }));
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void stageRef.current?.requestFullscreen().catch(() => {});
  };
  const shown = messages.filter((message) => !isDanmakuBlocked(message.text, settings.blocked));
  const status = !connection ? null : error ? "error" : !state ? "connecting" : !room?.live ? "offline" : disconnected ? "disconnected" : state.ended ? "ended" : videoError ? "video" : null;
  const anchor = room?.anchor.name || target.anchor || "主播";

  return <Modal animationType="fade" transparent visible onRequestClose={() => settingsOpen ? setSettingsOpen(false) : onClose()}>
    <div className="rv-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="lv-layout" role="dialog" aria-modal="true" aria-label="直播间">
        <section className="lv-main">
          <header className="lv-header">
            <button className="rv-icon-button" aria-label="关闭直播间" onClick={onClose}><X color="#fff" size={22} /></button>
            <div className="lv-avatar">{room?.anchor.avatar ? <img src={room.anchor.avatar} alt="" referrerPolicy="no-referrer" /> : <span>{anchor.slice(0, 1)}</span>}</div>
            <div className="lv-heading">
              <strong>{anchor}{room?.live && !state?.ended ? <span className="lv-badge">直播中</span> : null}</strong>
              <span title={room?.title || target.title}>{room?.title || target.title || "抖音直播间"}</span>
            </div>
            {room?.live ? <div className="lv-stats"><span>{count(state?.online)} 人在看</span><span>本场点赞 {count(state?.likes)}</span></div> : null}
            {onOpenRecord ? <button className="lv-link" onClick={() => void onOpenRecord(roomUrl)}>去抖音<ArrowUpRight color="#fff" size={15} /></button> : null}
          </header>
          <div ref={stageRef} className="lv-stage">
            {stream ? <video key={`${stream.key}:${videoAttempt}`} ref={videoRef} src={stream.url} playsInline muted={muted} aria-label={`${anchor}的直播画面`}
              onPlaying={() => setBuffering(false)} onWaiting={() => setBuffering(true)} onError={() => setVideoError(true)} /> : null}
            <div ref={layerRef} className="lv-danmaku" aria-hidden="true"
              style={{ height: `${settings.area * 100}%`, opacity: settings.opacity, "--dm-size": `${settings.size}px` } as React.CSSProperties} />
            {status || (stream && buffering) ? <div className={`rv-message lv-message ${status ? "" : "lv-quiet"}`} role={status === "error" || status === "video" ? "alert" : "status"}>
              {status === "connecting" || (!status && buffering) ? <><span className="rv-spinner" /><p>{status ? "正在进入直播间…" : "正在载入画面…"}</p></>
                : status === "error" ? <><p>{error}</p><button className="rv-button" onClick={() => setAttempt((value) => value + 1)}>重新进入</button></>
                : status === "offline" ? <><p>{anchor}现在没在播。</p><button className="rv-button" onClick={() => setAttempt((value) => value + 1)}>再看看</button></>
                : status === "disconnected" ? <><p>和直播间的连接断了，可能是采集器去做别的读取了。</p><button className="rv-button" onClick={() => setAttempt((value) => value + 1)}>重新进入</button></>
                : status === "ended" ? <p>直播已经结束了。</p>
                : <><p>画面没加载出来，可以重试或换个清晰度。</p><button className="rv-button" onClick={() => setVideoAttempt((value) => value + 1)}>重试</button></>}
            </div> : null}
            {!connection ? <div className="rv-message lv-message">
              <p>连上本地采集器才能看直播。</p>
              {onOpenSettings ? <button className="rv-button" onClick={onOpenSettings}>连接与采集</button> : null}
            </div> : null}
            {stream ? <div className="lv-controls">
              <button className="rv-icon-button" aria-label={settings.enabled ? "关闭弹幕" : "打开弹幕"} aria-pressed={settings.enabled} onClick={() => update({ enabled: !settings.enabled })}>
                {settings.enabled ? <MessageSquareText color="#fff" size={20} /> : <MessageSquareOff color="#fff" size={20} />}
              </button>
              <button className={`rv-icon-button ${settingsOpen ? "lv-on" : ""}`} aria-label="弹幕设置" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(!settingsOpen)}>
                <SlidersHorizontal color="#fff" size={19} />
              </button>
              <span className="rv-control-spacer" />
              {room && room.qualities.length > 1 ? <select className="lv-select" aria-label="清晰度" value={stream?.key ?? ""} onChange={(event) => setQuality(event.target.value)}>
                {room.qualities.map((item) => <option key={item.key} value={item.key}>{item.name}</option>)}
              </select> : null}
              <button className="rv-icon-button" aria-label={muted ? "开启声音" : "静音"} onClick={() => { setMuted(!muted); if (videoRef.current) videoRef.current.muted = !muted; }}>
                {muted ? <VolumeX color="#fff" size={20} /> : <Volume2 color="#fff" size={20} />}
              </button>
              <button className="rv-icon-button" aria-label={fullscreen ? "退出全屏" : "全屏"} onClick={toggleFullscreen}>
                {fullscreen ? <Minimize color="#fff" size={19} /> : <Maximize color="#fff" size={19} />}
              </button>
            </div> : null}
            {stream && settingsOpen ? <div className="lv-settings" role="group" aria-label="弹幕设置">
              <label><span>不透明度</span><input type="range" min={10} max={100} step={5} value={Math.round(settings.opacity * 100)} onChange={(event) => update({ opacity: Number(event.target.value) / 100 })} /><em>{Math.round(settings.opacity * 100)}%</em></label>
              <label><span>字号</span><input type="range" min={14} max={36} step={1} value={settings.size} onChange={(event) => update({ size: Number(event.target.value) })} /><em>{settings.size}</em></label>
              <div className="lv-row"><span>速度</span><div className="lv-segments">{SPEED_NAMES.map(([key, name]) =>
                <button key={key} aria-pressed={settings.speed === key} className={settings.speed === key ? "lv-on" : ""} onClick={() => update({ speed: key })}>{name}</button>)}</div></div>
              <div className="lv-row"><span>显示区域</span><div className="lv-segments">{DANMAKU_AREAS.map((area, index) =>
                <button key={area} aria-pressed={settings.area === area} className={settings.area === area ? "lv-on" : ""} onClick={() => update({ area })}>{AREA_NAMES[index]}</button>)}</div></div>
              <label className="lv-block"><span>屏蔽词</span><input type="text" value={blockText} placeholder="用空格或逗号隔开" aria-label="屏蔽词"
                onChange={(event) => { setBlockText(event.target.value); update({ blocked: parseBlockedWords(event.target.value) }); }} /></label>
              <p>含屏蔽词的弹幕，画面上和右边列表里都不显示。</p>
              <button className="lv-reset" onClick={() => { setSettings({ ...DEFAULT_DANMAKU, enabled: settings.enabled }); setBlockText(""); }}>恢复默认</button>
            </div> : null}
          </div>
        </section>
        <aside className="lv-side" aria-label="弹幕列表">
          <h2>弹幕</h2>
          <div ref={listRef} className="lv-list" tabIndex={0}
            onScroll={(event) => {
              const list = event.currentTarget;
              stick.current = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
              if (stick.current) setUnread(false);
            }}>
            {shown.map((message) => <p key={message.seq}><span>{message.user || "观众"}：</span><EmojiText text={message.text} /></p>)}
            {!shown.length ? <p className="lv-empty">{room?.live ? "弹幕来了会显示在这里。" : room ? "开播以后，弹幕会显示在这里。" : "进了直播间，弹幕会显示在这里。"}</p> : null}
          </div>
          {unread ? <button className="lv-unread" onClick={() => { stick.current = true; setUnread(false); if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight; }}>
            <ArrowDown color="#fff" size={14} />有新弹幕</button> : null}
          <p className="lv-note">这里只看直播、收弹幕，不能发弹幕、送礼物或点赞；弹幕也不会存到本机。</p>
        </aside>
      </div>
    </div>
  </Modal>;
}
