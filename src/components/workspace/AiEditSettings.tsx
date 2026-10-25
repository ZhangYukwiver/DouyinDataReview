import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from "react-native";
import { Bot, Check, ChevronRight, Plug, Plus, Puzzle, Sparkles, X, type LucideIcon } from "lucide-react-native";
import type { ExploreConnection } from "../../services/explorer";
import {
  aiConfigReady, aiRuntimeOf, borrowArkKey, sameAiEditConfig, tidyAiEditConfig, generateConfigProblem, generateKey, isArkUrl, isLocalAiRuntime, keepValidGenerateUrls, DEFAULT_AI_EDIT_GENERATE_CONFIG, GENERATE_SLOTS, LOCAL_CLI, VIDEO_PROVIDER_SLOT,
  type AiEditConfig, type AiEditGenerateConfig, type AiEditGenerateSlot, type AiEditVideoProvider, type AiRuntime,
} from "../../services/aiEdit";
import { DEFAULT_ANALYSIS_CONFIG } from "../../services/videoAnalysis";
import { AiRuntimeField, RUNTIME_LABELS } from "./AiRuntimeField";
import { useAnalysisService, videoInputNote as analysisInputNote, type AnalysisService } from "./AnalysisWorkspace";
import { SkillsPanel } from "./AiEditSkills";
import { Expand, webPointer } from "./aiEditShared";
import { kit, SmallButton } from "./CreatorKit";
import { ws } from "./motion";
import { alpha, workspaceColors as color, workspaceFonts as font, workspaceRadii as radius } from "./workspaceTheme";

// AI 剪辑的设置窗口，照 openfilm 的设置排：左边分页导航，右边一页是标题 + 几组、组里一行一行用发丝线隔开，
// 每行左边是名字和一句说明、右边是按钮。剪辑模型一页（用哪个 AI 来剪），服务商一页（解析视频，和生成图片、视频的几家，各自连上自己的 Key 或本机命令行），
// 生成素材一页（图片、视频各用连上的哪家）。服务商那一行点「连接」才在下面展开填 Key，接口地址和模型再收进「高级选项」。

export type AiEditSettingsSection = "model" | "providers" | "generate" | "skills";

const SECTIONS: Array<{ key: AiEditSettingsSection; title: string; icon: LucideIcon; note: string }> = [
  { key: "model", title: "剪辑模型", icon: Bot, note: "AI 剪辑用哪个模型来听你的话、改时间线。看参考视频可以在「服务商」里另外连一个「解析视频」，不连就也用它。" },
  { key: "providers", title: "服务商", icon: Plug, note: "解析视频、生成图片和视频的服务。用你自己的 Key 或这台电脑上登录好的命令行，按各家的价格另外计费，钱直接付给服务商；Key 只存在这台电脑上。" },
  { key: "generate", title: "生成素材", icon: Sparkles, note: "AI 剪辑时缺画面，可以自己生成图片和视频放进素材库。这里选各用连上的哪一家；每次生成视频前都会先问你。" },
  { key: "skills", title: "技能", icon: Puzzle, note: "技能是别人写好的一套做法，就是一个带 SKILL.md 的文件夹。装上以后，你的要求用得上它时，AI 会照着它的说明做，比如写一段配乐、做一张字卡；要在这台电脑上运行命令时会先问你。" },
];

type FieldKey = "apiKey" | "model" | "baseUrl";
type Field = { key: FieldKey; label: string; secret?: boolean; placeholder?: string };
/** cli：不填 Key，用这台电脑上登录好的命令行（即梦、小云雀、LibTV）；note 是展开后写在表单最上面的一句 */
type Provider = { slot: AiEditGenerateSlot; mark: string; name: string; what: string; hint: string; fields: Field[]; advanced: Field[]; cli?: boolean; note?: string };

const defaults = (slot: AiEditGenerateSlot, key: "model" | "baseUrl") => DEFAULT_AI_EDIT_GENERATE_CONFIG[slot][key];
const advanced = (slot: AiEditGenerateSlot, modelLabel = "模型"): Field[] => [
  { key: "model", label: modelLabel, placeholder: defaults(slot, "model") || "留空用服务商默认的" },
  { key: "baseUrl", label: "接口地址", placeholder: defaults(slot, "baseUrl") },
];

const IMAGE_PROVIDERS: Provider[] = [
  { slot: "image", mark: "O", name: "OpenAI", what: "生成图片", hint: "Key 在 OpenAI 平台的 API keys 页面拿；也能填 OpenAI 兼容的中转站。",
    fields: [{ key: "apiKey", label: "API Key", secret: true, placeholder: "sk-…" }], advanced: advanced("image") },
];
const VIDEO_PROVIDERS: Array<Provider & { provider: AiEditVideoProvider }> = [
  { provider: "seedance", slot: "video", mark: "方", name: "火山方舟 Seedance", what: "生成视频", hint: "Seedance 模型要先在火山方舟控制台「开通管理」里开通（账户余额不少于 200 元）。",
    fields: [{ key: "apiKey", label: "API Key", secret: true, placeholder: "方舟的 API Key" }], advanced: advanced("video") },
  { provider: "jimeng", slot: "jimeng", mark: "即", name: "即梦", what: "生成视频", hint: "字节的 AI 创作平台，能用 Seedance 2.0、2.5 等模型，扣即梦账号的积分。用这台电脑上登录好的即梦命令行，不用填 Key。",
    note: "先在终端里运行 curl -fsSL https://jimeng.jianying.com/cli | bash 装好即梦命令行（dreamina），再运行 dreamina login 登录一次，回来点保存。有的模型第一次用要先在即梦网页版上用它生成一次。模型名用 dreamina text2video -h 查。",
    cli: true, fields: [], advanced: [{ key: "model", label: "模型", placeholder: defaults("jimeng", "model") }] },
  { provider: "xyq", slot: "xyq", mark: "云", name: "小云雀", what: "生成视频", hint: "剪映团队的 AI 视频创作，按积分扣费。用这台电脑上登录好的小云雀命令行，不用填 Key。",
    note: "先在终端里运行 npx @pippit-dev/cli@latest install 装好小云雀命令行（pippit-tool-cli），再运行 pippit-tool-cli login 在浏览器里授权一次，回来点保存。模型名用 pippit-tool-cli model list 查。",
    cli: true, fields: [], advanced: [{ key: "model", label: "模型", placeholder: defaults("xyq", "model") }] },
  { provider: "libtv", slot: "libtv", mark: "L", name: "LibTV", what: "生成视频", hint: "LiblibAI 的视频创作平台，能用 Seedance、可灵、万相等模型，按积分扣费。用这台电脑上登录好的 LibTV 命令行，不用填 Key。",
    note: "LibTV 原来的 Access Key 接口已经下线，现在只能用官方命令行：到 liblib.tv/plugin 的「CLI」页装好，在终端里运行 libtv login web 登录一次，再回来点保存。模型名用 libtv model search --type video 查。",
    cli: true, fields: [], advanced: [{ key: "model", label: "模型", placeholder: defaults("libtv", "model") }] },
];
const PROVIDER_NAMES = Object.fromEntries([...IMAGE_PROVIDERS, ...VIDEO_PROVIDERS].map((item) => [item.slot, item.name])) as Record<AiEditGenerateSlot, string>;

/** 一项的这几个字段（去掉首尾空格）和存着的不一样 */
const slotChanged = (draft: AiEditGenerateConfig, stored: AiEditGenerateConfig, slot: AiEditGenerateSlot): boolean => {
  const left = draft[slot] as unknown as Record<string, unknown>;
  const right = stored[slot] as unknown as Record<string, unknown>;
  return Object.keys(right).some((key) => (typeof left[key] === "string" ? (left[key] as string).trim() : left[key]) !== right[key]);
};
const trimSlot = <T extends object>(value: T): T => Object.fromEntries(Object.entries(value).map(([key, item]) => [key, typeof item === "string" ? item.trim() : item])) as T;

export interface AiEditSettingsProps {
  visible: boolean;
  section: AiEditSettingsSection;
  onSection: (section: AiEditSettingsSection) => void;
  onClose: () => void;
  connection: ExploreConnection | null;
  config: AiEditConfig;
  probe: { running: boolean; error?: string; key?: string };
  onSave: (config: AiEditConfig) => void;
  onRetest: () => void;
  generate: AiEditGenerateConfig;
  onSaveGenerate: (config: AiEditGenerateConfig) => void;
  /** 关窗时有地址填错没存上：这句交给外面的提示条 */
  onGenerateNote: (text: string) => void;
  /** AI 正在等你确认（花钱生成视频、运行技能命令）：窗口顶上提醒这一句，「去确认」关窗回对话；没在等是 null */
  waiting: string | null;
  onGoConfirm: () => void;
}

export function AiEditSettings(props: AiEditSettingsProps) {
  const { visible, onClose } = props;
  return <Modal animationType="fade" transparent visible={visible} onRequestClose={onClose}>
    {visible ? <Window {...props} /> : null}
  </Modal>;
}

function Window({ section, onSection, onClose, connection, config, probe, onSave, onRetest, generate, onSaveGenerate, onGenerateNote, waiting, onGoConfirm }: AiEditSettingsProps) {
  const { width, height } = useWindowDimensions();
  // 服务商的改动整个窗口共用一份草稿：每家点「保存」存自己那一项，没点保存就关窗的，关窗时替用户存上（填错的地址退回原来的）
  const [draft, setDraft] = useState(generate);
  // 「解析视频」就是解析库那份配置，这里改了解析库也跟着用
  const analysis = useAnalysisService(connection);
  const ai = { config, analysis: analysis.config };
  const latest = useRef({ draft, generate, ai, onSaveGenerate, onGenerateNote });
  latest.current = { draft, generate, ai, onSaveGenerate, onGenerateNote };
  useEffect(() => () => {
    const { draft: left, generate: stored, ai: keys, onSaveGenerate: save, onGenerateNote: note } = latest.current;
    const changed = (config: AiEditGenerateConfig) => GENERATE_SLOTS.some((slot) => slotChanged(config, stored, slot));
    if (!changed(left)) return;
    const trimmed = Object.fromEntries(GENERATE_SLOTS.map((slot) => [slot, trimSlot(left[slot])])) as Omit<AiEditGenerateConfig, "use">;
    const kept = keepValidGenerateUrls({ ...trimmed, use: stored.use }, stored);
    const next = withUse(kept.config, stored, keys);
    if (changed(next)) save(next);
    if (kept.problem) note(kept.problem);
  }, []);

  const store = (next: AiEditGenerateConfig) => { onSaveGenerate(next); setDraft((current) => ({ ...current, use: next.use })); };
  const shown = SECTIONS.find((item) => item.key === section) ?? SECTIONS[0]!;

  return <View style={styles.backdrop}>
    {/* 遮罩用响应者而不是 Pressable：RN-web 的 Pressable 总带 tabIndex=0，会多出一个看不见、按回车就关窗的 Tab 停留点 */}
    <View onStartShouldSetResponder={() => true} onResponderRelease={onClose} style={[StyleSheet.absoluteFill, webPointer]} />
    <View {...ws("e-modal")} accessibilityViewIsModal accessibilityLabel="AI 剪辑设置" testID="ai-edit-settings"
      style={[styles.window, { width: Math.min(960, Math.round(width * 0.94)), height: Math.min(680, Math.round(height * 0.9)) }]}>
      <View accessibilityRole="tablist" style={styles.nav}>
        <Text style={styles.navTitle}>AI 剪辑设置</Text>
        {SECTIONS.map(({ key, title, icon: Icon }) => {
          const on = key === shown.key;
          return <Pressable key={key} accessibilityRole="tab" accessibilityState={{ selected: on }} aria-selected={on} testID={`ai-settings-tab-${key}`}
            onPress={() => onSection(key)} style={(state) => [styles.navItem, on ? styles.navItemOn : hovered(state) && styles.navItemHover, webPointer]}>
            <Icon size={17} strokeWidth={1.8} color={on ? color.text : color.textMuted} />
            <Text numberOfLines={1} style={[styles.navText, on && styles.navTextOn]}>{title}</Text>
          </Pressable>;
        })}
      </View>
      <View style={styles.main}>
        <Pressable accessibilityRole="button" accessibilityLabel="关闭设置" testID="ai-settings-close" onPress={onClose}
          style={(state) => [styles.close, hovered(state) && styles.navItemHover, webPointer]}>
          <X size={18} strokeWidth={1.9} color={color.textSecondary} />
        </Pressable>
        {/* key 跟着页走：换页时滚回顶上 */}
        <ScrollView key={shown.key} style={{ flex: 1 }} contentContainerStyle={styles.page}>
          <Text accessibilityRole="header" style={styles.pageTitle}>{shown.title}</Text>
          {waiting ? <View accessibilityRole="alert" style={styles.notice}>
            <Text style={styles.noticeText}>{`${waiting}，在对话里等你确认。`}</Text>
            <SmallButton label="去确认" onPress={onGoConfirm} />
          </View> : null}
          <Text style={styles.pageNote}>{shown.note}</Text>
          {shown.key === "model"
            ? <ModelPage connection={connection} config={config} probe={probe} onSave={onSave} onRetest={onRetest} />
            : shown.key === "providers"
              ? <ProvidersPage draft={draft} stored={generate} ai={ai} onDraft={setDraft} onStore={store} connection={connection} analysis={analysis} />
              : shown.key === "generate"
                ? <GeneratePage stored={generate} ai={ai} onStore={store} onConnect={() => onSection("providers")} />
                : <SkillsPanel connection={connection} />}
        </ScrollView>
      </View>
    </View>
  </View>;
}

type AiKeys = { config: AiEditConfig; analysis: AnalysisService["config"] };
const keyOf = (config: AiEditGenerateConfig, slot: AiEditGenerateSlot, ai: AiKeys) => generateKey(config, slot, ai.config, ai.analysis);

/** 连上一类里的第一家时顺手用上它（照 openfilm：连上服务商就补上还空着的那类）；那一类已经有连上的就不动用户的选择 */
function withUse(next: AiEditGenerateConfig, stored: AiEditGenerateConfig, ai: AiKeys): AiEditGenerateConfig {
  const use = { ...next.use };
  if (!keyOf(stored, "image", ai) && keyOf(next, "image", ai)) use.image = "openai";
  if (!VIDEO_PROVIDERS.some((item) => keyOf(stored, item.slot, ai))) {
    const first = VIDEO_PROVIDERS.find((item) => keyOf(next, item.slot, ai));
    if (first) use.video = first.provider;
  }
  return { ...next, use };
}
// ---------- 剪辑模型 ----------

function videoInputNote(config: AiEditConfig, probe: { running: boolean; error?: string }): string {
  if (probe.running) return "正在测这个模型能不能直接看视频……";
  const known = config.videoInput === true ? "这个模型能直接看视频，参考视频会整段发给它（画面和声音都能用上）。"
    : config.videoInput === false ? "这个模型看不了视频。解析参考视频时，应用会先把视频拆成镜头截图和音乐节拍再交给它，这时要开着应用。"
      : null;
  if (probe.error) return known ? `这次没测出来（${probe.error}），先沿用上次的结果：${known}` : `没测出这个模型能不能直接看视频（${probe.error}）。解析参考视频时会先整段发给它，看不了再拆成截图。`;
  return known ?? "还没测过这个模型能不能直接看视频。";
}

function ModelPage({ connection, config, probe, onSave, onRetest }: Pick<AiEditSettingsProps, "connection" | "config" | "probe" | "onSave" | "onRetest">) {
  const [draft, setDraft] = useState(config);
  // 改了没点保存就关窗或换页：能用的替用户存上（同服务商那页），不然发消息时还在用原来的
  const latest = useRef({ draft, config, onSave });
  latest.current = { draft, config, onSave };
  useEffect(() => () => {
    const { draft: left, config: stored, onSave: store } = latest.current;
    if (aiConfigReady(left) && !sameAiEditConfig(left, stored)) store(tidyAiEditConfig(left));
  }, []);
  // 保存后页面留着显示测的结果，按钮上闪一下「已保存」
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!saved) return undefined;
    const timer = setTimeout(() => setSaved(false), 1600);
    return () => clearTimeout(timer);
  }, [saved]);
  const runtime = aiRuntimeOf(draft.runtime);
  const local = isLocalAiRuntime(runtime);
  const ready = aiConfigReady({ ...draft, runtime });
  const commit = (value: AiEditConfig) => { onSave(tidyAiEditConfig(value)); setSaved(true); };
  const save = () => commit(draft);
  // 运行方式一选就生效：本机的 Codex、Claude Code 不用再填别的；切回接口时 Key、模型、地址都在才存，没填全还得点保存
  const pickRuntime = (next: AiRuntime) => {
    const value = { ...draft, runtime: next };
    setDraft(value);
    if (aiConfigReady(value)) commit(value);
  };
  const field = (key: "apiKey" | "model" | "baseUrl", label: string, props: Omit<Partial<React.ComponentProps<typeof TextInput>>, "onChange"> = {}) => <Input label={label}
    value={draft[key]} onChange={(text) => setDraft((current) => ({ ...current, [key]: text }))} {...props} />;
  return <>
    <Group title="用什么来剪">
      <Row title="运行方式" detail={local
        ? `用这台电脑上登录好的 ${RUNTIME_LABELS[runtime]} 来剪，走你自己的订阅，不用填 Key。它看不了视频，解析参考视频时应用会先把视频拆成镜头截图和音乐节拍再交给它，这时要开着应用。`
        : "接口：填一个能调用工具的大模型接口（比如火山方舟的 doubao-seed）。"}>
        <AiRuntimeField connection={connection} value={runtime} onChange={pickRuntime} />
      </Row>
    </Group>
    <Group title={local ? RUNTIME_LABELS[runtime] : "接口"}>
      <View style={styles.form}>
        {local
          ? <Input label="模型（选填）" value={draft.localModels?.[runtime] ?? ""} placeholder={`留空就用 ${RUNTIME_LABELS[runtime]} 自己的默认模型`}
              onChange={(text) => setDraft((current) => ({ ...current, localModels: { ...current.localModels, [runtime]: text } }))} />
          : <>
            {field("apiKey", "API Key", { secureTextEntry: true, placeholder: "从大模型服务商获取 API Key" })}
            {field("model", "模型", { placeholder: "doubao-seed-2-1-lite-260915" })}
            {field("baseUrl", "接口地址", { placeholder: "https://ark.cn-beijing.volces.com/api/v3" })}
          </>}
        <View style={kit.row}>
          <SmallButton label={saved ? "已保存" : "保存"} done={saved} disabled={!ready} onPress={save} />
        </View>
      </View>
      {!local && !isLocalAiRuntime(config.runtime) && config.apiKey ? <Row title="能不能看视频" detail={videoInputNote(config, probe)}>
        {probe.running ? <ActivityIndicator size="small" color={color.cyan} /> : <SmallButton label="重新测" onPress={onRetest} />}
      </Row> : null}
    </Group>
  </>;
}

// ---------- 服务商 ----------

function ProvidersPage({ draft, stored, ai, onDraft, onStore, connection, analysis }: {
  draft: AiEditGenerateConfig; stored: AiEditGenerateConfig; ai: AiKeys;
  onDraft: React.Dispatch<React.SetStateAction<AiEditGenerateConfig>>; onStore: (next: AiEditGenerateConfig) => void;
  connection: ExploreConnection | null; analysis: AnalysisService;
}) {
  const row = (provider: Provider) => <ProviderRow key={provider.slot} provider={provider} draft={draft} stored={stored} ai={ai} onDraft={onDraft} onStore={onStore} />;
  return <>
    <Group title="解析视频" footnote="解析库和 AI 剪辑看参考视频、转写字幕都用这一个，在哪边改都一样。不单独连的话，就用剪辑模型来看。">
      <AnalysisRow connection={connection} service={analysis} edit={ai.config} />
    </Group>
    <Group title="生成图片">{IMAGE_PROVIDERS.map(row)}</Group>
    <Group title="生成视频" footnote="连上几家都行，在「生成素材」里选这次用哪家。">{VIDEO_PROVIDERS.map(row)}</Group>
  </>;
}

/** 一家服务：标记、名字（连上了后面跟 Key 的末四位）、一句说明、右边连接或断开；点「连接」「修改」在下面展开填写 */
function ProviderRow({ provider, draft, stored, ai, onDraft, onStore }: {
  provider: Provider; draft: AiEditGenerateConfig; stored: AiEditGenerateConfig; ai: AiKeys;
  onDraft: React.Dispatch<React.SetStateAction<AiEditGenerateConfig>>; onStore: (next: AiEditGenerateConfig) => void;
}) {
  const { slot } = provider;
  const value = draft[slot] as unknown as Record<FieldKey, string>;
  const ownKey = stored[slot].apiKey.trim();
  const usingKey = keyOf(stored, slot, ai);
  const borrowed = slot === "video" && !ownKey && usingKey ? borrowArkKey(ai.config, ai.analysis) : null;
  // 有没保存的改动、或者还没连上时被点开：展开；接口地址和模型填过非默认值的，「高级选项」也先展开
  const [open, setOpen] = useState(() => slotChanged(draft, stored, slot));
  // 只看「高级选项」里真有的那几项：用命令行的几家没有接口地址，旧配置里留着的老地址不算
  const [more, setMore] = useState(() => provider.advanced.some(({ key }) => {
    const text = stored[slot][key].trim();
    return Boolean(text) && text !== DEFAULT_AI_EDIT_GENERATE_CONFIG[slot][key];
  }));
  const [problem, setProblem] = useState<string | null>(null);
  const set = (key: FieldKey, text: string) => { setProblem(null); onDraft((current) => ({ ...current, [slot]: { ...current[slot], [key]: text } })); };
  const reset = () => { setProblem(null); onDraft((current) => ({ ...current, [slot]: stored[slot] })); setOpen(false); };
  const save = () => {
    const next = { ...stored, [slot]: { ...trimSlot(draft[slot]), ...(provider.cli ? { apiKey: LOCAL_CLI } : {}) } } as AiEditGenerateConfig;
    const bad = generateConfigProblem(next, [slot]);
    if (bad) { setProblem(bad); return; }
    onStore(withUse(next, stored, ai));
    onDraft((current) => ({ ...current, [slot]: next[slot] }));
    setOpen(false);
  };
  const disconnect = () => {
    const cleared = { ...stored[slot], apiKey: "", ...(slot === "video" ? { borrow: false } : {}) };
    const next = { ...stored, [slot]: cleared } as AiEditGenerateConfig;
    onStore(next);
    onDraft((current) => ({ ...current, [slot]: cleared }));
  };
  const required = provider.fields.filter(({ key }) => key === "apiKey");
  // 方舟可以不填 Key、借已经填过的方舟 Key（用户自己勾）
  const arkBorrow = slot === "video" && isArkUrl(draft.video.baseUrl.trim() || DEFAULT_AI_EDIT_GENERATE_CONFIG.video.baseUrl) ? borrowArkKey(ai.config, ai.analysis) : null;
  const filled = required.every(({ key }) => value[key]?.trim()) || Boolean(slot === "video" && draft.video.borrow && arkBorrow);
  const tail = (key: string) => `•••• ${key.slice(-4)}`;
  return <View style={styles.row} testID={`ai-provider-${slot}`}>
    <View style={styles.rowHead}>
      <View style={styles.mark}><Text style={styles.markText}>{provider.mark}</Text></View>
      <View style={styles.copy}>
        <View style={styles.titleLine}>
          <Text style={styles.rowTitle}>{provider.name}</Text>
          {usingKey ? <View style={styles.status}>
            <View style={styles.dot} />
            <Text style={styles.statusText}>{provider.cli ? "已连接 · 用本机命令行" : borrowed ? `已连接 · 借用${borrowed.from === "edit" ? " AI 剪辑" : "解析库"}的方舟 Key` : `已连接 ${tail(usingKey)}`}</Text>
          </View> : null}
        </View>
        <Text style={styles.detail}>{provider.what} · {provider.hint}</Text>
      </View>
      {open ? null : <View style={styles.rowControl}>
        {usingKey ? <>
          <SmallButton label="修改" onPress={() => setOpen(true)} />
          <SmallButton label="断开" onPress={disconnect} />
        </> : <SmallButton label="连接" onPress={() => setOpen(true)}><Plus size={13} color={color.text} /></SmallButton>}
      </View>}
    </View>
    <Expand open={open}>
      <View style={styles.inset}>
        {provider.note ? <Text style={styles.detail}>{provider.note}</Text> : null}
        {provider.fields.map((field) => <Input key={field.key} label={field.label} value={value[field.key] ?? ""} secret={field.secret}
          placeholder={field.key === "apiKey" && slot === "video" && draft.video.borrow && arkBorrow ? "留空就借用已经填过的方舟 Key" : field.placeholder} onChange={(text) => set(field.key, text)} />)}
        {slot === "video" && arkBorrow ? <CheckRow checked={draft.video.borrow}
          label={arkBorrow.from === "edit" ? "Key 留空时借用剪辑模型里填的方舟 Key" : "Key 留空时借用解析库里填的方舟 Key"}
          onToggle={() => onDraft((current) => ({ ...current, video: { ...current.video, borrow: !current.video.borrow } }))} /> : null}
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: more }} onPress={() => setMore((was) => !was)} style={[styles.moreToggle, webPointer]}>
          <View style={{ transform: [{ rotate: more ? "90deg" : "0deg" }] }}><ChevronRight size={14} color={color.textMuted} /></View>
          <Text style={styles.moreText}>高级选项</Text>
        </Pressable>
        <Expand open={more} gap={10}>
          {provider.advanced.map((field) => <Input key={field.key} label={field.label} value={value[field.key] ?? ""} placeholder={field.placeholder} onChange={(text) => set(field.key, text)} />)}
        </Expand>
        {problem ? <Text accessibilityRole="alert" style={styles.error}>{problem}</Text> : null}
        <View style={styles.insetActions}>
          <SmallButton label="取消" onPress={reset} />
          <SmallButton label="保存" disabled={!filled} onPress={save} />
        </View>
      </View>
    </Expand>
  </View>;
}

/** 「解析视频」：和服务商一样一行，展开是运行方式 + Key，模型和接口地址收进「高级选项」；断开后回到用剪辑模型 */
function AnalysisRow({ connection, service, edit }: { connection: ExploreConnection | null; service: AnalysisService; edit: AiEditConfig }) {
  const { config, probe } = service;
  const connected = aiConfigReady(config);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(config);
  const [more, setMore] = useState(() => (["model", "baseUrl"] as const).some((key) => config[key].trim() !== DEFAULT_ANALYSIS_CONFIG[key]));
  const runtime = aiRuntimeOf(draft.runtime);
  const local = isLocalAiRuntime(runtime);
  const set = (key: FieldKey, text: string) => setDraft((current) => ({ ...current, [key]: text }));
  const start = () => { setDraft(config); setOpen(true); };
  const save = () => { service.save({ ...draft, runtime }); setOpen(false); };
  const disconnect = () => service.save({ ...config, runtime: "api", apiKey: "" });
  const status = connected
    ? isLocalAiRuntime(config.runtime) ? `已连接 · 用本机 ${RUNTIME_LABELS[config.runtime]}` : `已连接 •••• ${config.apiKey.trim().slice(-4)}`
    : aiConfigReady(edit) ? "没单独连 · 用剪辑模型" : null;
  const detail = connected && !isLocalAiRuntime(config.runtime) ? analysisInputNote(config, probe)
    : "看懂视频：分段时间轴、转场、字幕和配乐卡点。最好用能直接看视频、听得到声音的模型，比如方舟 doubao-seed-2-1-lite。";
  return <View style={styles.row} testID="ai-provider-analysis">
    <View style={styles.rowHead}>
      <View style={styles.mark}><Text style={styles.markText}>解</Text></View>
      <View style={styles.copy}>
        <View style={styles.titleLine}>
          <Text style={styles.rowTitle}>解析模型</Text>
          {status ? <View style={styles.status}>
            {connected ? <View style={styles.dot} /> : null}
            <Text style={styles.statusText}>{status}</Text>
          </View> : null}
        </View>
        <Text style={styles.detail}>{detail}</Text>
      </View>
      {open ? null : <View style={styles.rowControl}>
        {connected && !isLocalAiRuntime(config.runtime) ? probe.running ? <ActivityIndicator size="small" color={color.cyan} /> : <SmallButton label="重新测" onPress={service.retest} /> : null}
        {connected ? <>
          <SmallButton label="修改" onPress={start} />
          <SmallButton label="断开" onPress={disconnect} />
        </> : <SmallButton label="连接" onPress={start}><Plus size={13} color={color.text} /></SmallButton>}
      </View>}
    </View>
    <Expand open={open}>
      <View style={styles.inset}>
        <AiRuntimeField connection={connection} value={runtime} onChange={(next) => setDraft((current) => ({ ...current, runtime: next }))} />
        {local
          ? <Input label="模型（选填）" value={draft.localModels?.[runtime] ?? ""} placeholder={`留空就用 ${RUNTIME_LABELS[runtime]} 自己的默认模型`}
              onChange={(text) => setDraft((current) => ({ ...current, localModels: { ...current.localModels, [runtime]: text } }))} />
          : <>
            <Input label="API Key" value={draft.apiKey} secret placeholder="从大模型服务商获取 API Key" onChange={(text) => set("apiKey", text)} />
            <Pressable accessibilityRole="button" accessibilityState={{ expanded: more }} onPress={() => setMore((was) => !was)} style={[styles.moreToggle, webPointer]}>
              <View style={{ transform: [{ rotate: more ? "90deg" : "0deg" }] }}><ChevronRight size={14} color={color.textMuted} /></View>
              <Text style={styles.moreText}>高级选项</Text>
            </Pressable>
            <Expand open={more} gap={10}>
              <Input label="模型" value={draft.model} placeholder={DEFAULT_ANALYSIS_CONFIG.model} onChange={(text) => set("model", text)} />
              <Input label="接口地址" value={draft.baseUrl} placeholder={DEFAULT_ANALYSIS_CONFIG.baseUrl} onChange={(text) => set("baseUrl", text)} />
            </Expand>
          </>}
        <View style={styles.insetActions}>
          <SmallButton label="取消" onPress={() => setOpen(false)} />
          <SmallButton label="保存" disabled={!aiConfigReady({ ...draft, runtime })} onPress={save} />
        </View>
      </View>
    </Expand>
  </View>;
}

// ---------- 生成素材 ----------

function GeneratePage({ stored, ai, onStore, onConnect }: { stored: AiEditGenerateConfig; ai: AiKeys; onStore: (next: AiEditGenerateConfig) => void; onConnect: () => void }) {
  const imageOn = Boolean(keyOf(stored, "image", ai));
  const videos = VIDEO_PROVIDERS.filter((item) => keyOf(stored, item.slot, ai));
  const imageValue = stored.use.image && imageOn ? "openai" : null;
  const videoValue = stored.use.video && keyOf(stored, VIDEO_PROVIDER_SLOT[stored.use.video], ai) ? stored.use.video : null;
  const pick = (use: Partial<AiEditGenerateConfig["use"]>) => onStore({ ...stored, use: { ...stored.use, ...use } });
  const modelOf = (slot: AiEditGenerateSlot) => stored[slot].model.trim() || DEFAULT_AI_EDIT_GENERATE_CONFIG[slot].model;
  return <Group footnote="生成视频一轮最多问两段、图片最多六张；同样的说明生成过会直接用那一个，不再花钱。">
    <Row title="生成图片" detail="背景、插画、封面底图这类素材库里没有的静态画面。按张计费。" stacked>
      {imageOn
        ? <Choices value={imageValue} onChange={(value) => pick({ image: value as "openai" | null })}
            options={[{ value: null, label: "不生成" }, { value: "openai", label: `OpenAI · ${modelOf("image")}` }]} />
        : <NotConnected onConnect={onConnect} />}
    </Row>
    <Row title="生成视频" detail="素材库里实在没有、又非要动态画面的镜头。要花钱，每段都先问你。" stacked>
      {videos.length
        ? <Choices value={videoValue} onChange={(value) => pick({ video: value as AiEditVideoProvider | null })}
            options={[{ value: null, label: "不生成" }, ...videos.map((item) => ({ value: item.provider, label: modelOf(item.slot) ? `${PROVIDER_NAMES[item.slot]} · ${modelOf(item.slot)}` : PROVIDER_NAMES[item.slot] }))]} />
        : <NotConnected onConnect={onConnect} />}
    </Row>
  </Group>;
}

function NotConnected({ onConnect }: { onConnect: () => void }) {
  return <View style={kit.row}>
    <Text style={styles.detail}>还没连上能用的服务商。</Text>
    <SmallButton label="去连接" onPress={onConnect} />
  </View>;
}

// ---------- 零件 ----------

function Group({ title, footnote, children }: { title?: string; footnote?: string; children: React.ReactNode }) {
  return <View style={styles.group}>
    {title ? <Text style={styles.groupTitle}>{title}</Text> : null}
    <View>{children}</View>
    {footnote ? <Text style={styles.footnote}>{footnote}</Text> : null}
  </View>;
}

function Row({ title, detail, stacked = false, children }: { title: string; detail?: string; stacked?: boolean; children?: React.ReactNode }) {
  return <View style={[styles.row, stacked ? styles.rowStacked : styles.rowHead]}>
    <View style={styles.copy}>
      <Text style={styles.rowTitle}>{title}</Text>
      {detail ? <Text style={styles.detail}>{detail}</Text> : null}
    </View>
    {children ? <View style={stacked ? null : styles.rowControl}>{children}</View> : null}
  </View>;
}

function Input({ label, value, onChange, secret = false, placeholder, ...rest }: { label: string; value: string; onChange: (text: string) => void; secret?: boolean; placeholder?: string } & Omit<Partial<React.ComponentProps<typeof TextInput>>, "onChange">) {
  return <View style={styles.field}>
    <Text style={styles.label}>{label}</Text>
    <TextInput accessibilityLabel={label} value={value} onChangeText={onChange} secureTextEntry={secret} placeholder={placeholder} autoCapitalize="none" autoCorrect={false}
      placeholderTextColor={color.textMuted} style={styles.input} {...rest} />
  </View>;
}

/** 一列单选：选中的那项前面一个实心点 */
function Choices<T extends string | null>({ value, options, onChange }: { value: T; options: Array<{ value: T; label: string }>; onChange: (value: T) => void }) {
  return <View accessibilityRole="radiogroup" style={styles.choices}>
    {options.map((option) => {
      const on = option.value === value;
      return <Pressable key={String(option.value)} accessibilityRole="radio" accessibilityState={{ checked: on }} aria-checked={on} onPress={() => { if (!on) onChange(option.value); }}
        style={(state) => [styles.choice, on && styles.choiceOn, !on && hovered(state) && styles.navItemHover, webPointer]}>
        <View style={[styles.radio, on && styles.radioOn]}>{on ? <View style={styles.radioDot} /> : null}</View>
        <Text numberOfLines={1} style={[styles.choiceText, on && styles.navTextOn]}>{option.label}</Text>
      </Pressable>;
    })}
  </View>;
}

function CheckRow({ checked, label, onToggle }: { checked: boolean; label: string; onToggle: () => void }) {
  return <Pressable accessibilityRole="checkbox" accessibilityLabel={label} accessibilityState={{ checked }} aria-checked={checked} onPress={onToggle} style={[styles.check, webPointer]}>
    <View style={[styles.box, checked && styles.boxOn]}>{checked ? <Check size={11} strokeWidth={3} color={color.buttonText} /> : null}</View>
    <Text style={styles.detail}>{label}</Text>
  </Pressable>;
}

const hovered = (state: unknown) => Boolean((state as { hovered?: boolean }).hovered);

const styles = StyleSheet.create({
  backdrop: { flex: 1, alignItems: "center", justifyContent: "center", padding: 16, backgroundColor: color.scrim },
  window: { flexDirection: "row", overflow: "hidden", borderWidth: 1, borderColor: color.border, borderRadius: radius.large, backgroundColor: color.surface },
  // 左边导航：标题 + 一列页签，选中的那页浅底
  nav: { width: 196, flexShrink: 0, gap: 2, paddingHorizontal: 10, paddingTop: 18, borderRightWidth: 1, borderRightColor: color.borderSoft, backgroundColor: alpha(color.text, 0.02) },
  navTitle: { paddingHorizontal: 10, paddingBottom: 12, fontFamily: font.body, color: color.textMuted, fontSize: 12.5, fontWeight: "500" },
  navItem: { flexDirection: "row", alignItems: "center", gap: 10, height: 36, paddingHorizontal: 10, borderRadius: radius.small },
  navItemHover: { backgroundColor: alpha(color.text, 0.05) },
  navItemOn: { backgroundColor: alpha(color.text, 0.08) },
  navText: { flex: 1, fontFamily: font.body, color: color.textSecondary, fontSize: 14 },
  navTextOn: { color: color.text, fontWeight: "500" },
  main: { flex: 1, minWidth: 0 },
  close: { position: "absolute", top: 12, right: 12, zIndex: 1, width: 34, height: 34, alignItems: "center", justifyContent: "center", borderRadius: radius.small },
  page: { paddingHorizontal: 36, paddingTop: 26, paddingBottom: 36, maxWidth: 760 },
  pageTitle: { fontFamily: font.body, color: color.text, fontSize: 20, lineHeight: 28, fontWeight: "600" },
  pageNote: { marginTop: 8, marginBottom: 22, fontFamily: font.body, color: color.textMuted, fontSize: 13, lineHeight: 21 },
  notice: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 14, paddingVertical: 8, paddingHorizontal: 12, borderRadius: radius.medium, backgroundColor: color.amberSoft },
  noticeText: { flex: 1, fontFamily: font.body, color: color.text, fontSize: 13, lineHeight: 19 },
  group: { marginBottom: 28 },
  groupTitle: { marginBottom: 2, fontFamily: font.body, color: color.text, fontSize: 15, lineHeight: 22, fontWeight: "600" },
  footnote: { paddingTop: 8, fontFamily: font.body, color: color.textMuted, fontSize: 12.5, lineHeight: 19 },
  // 每行之间一道发丝线
  row: { paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: color.borderSoft },
  rowHead: { flexDirection: "row", alignItems: "center", gap: 14 },
  rowStacked: { gap: 12 },
  rowControl: { flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 0 },
  copy: { flex: 1, minWidth: 0, gap: 3 },
  titleLine: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", columnGap: 10, rowGap: 2 },
  rowTitle: { fontFamily: font.body, color: color.text, fontSize: 14, lineHeight: 20, fontWeight: "500" },
  detail: { fontFamily: font.body, color: color.textMuted, fontSize: 12.5, lineHeight: 19 },
  mark: { width: 34, height: 34, flexShrink: 0, alignItems: "center", justifyContent: "center", borderRadius: radius.small, backgroundColor: alpha(color.text, 0.06) },
  markText: { fontFamily: font.body, color: color.text, fontSize: 14, fontWeight: "600" },
  status: { flexDirection: "row", alignItems: "center", gap: 6 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: color.green },
  statusText: { fontFamily: font.sans, color: color.textMuted, fontSize: 12, fontVariant: ["tabular-nums"] },
  // 点「连接」后在那一行下面展开的一块：缩进对齐名字
  inset: { gap: 10, marginTop: 12, marginLeft: 48, padding: 14, borderWidth: 1, borderColor: color.borderSoft, borderRadius: radius.medium },
  insetActions: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
  form: { gap: 10, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: color.borderSoft },
  field: { gap: 5 },
  label: { fontFamily: font.body, color: color.textSecondary, fontSize: 12.5 },
  input: { height: 36, paddingHorizontal: 10, borderWidth: 1, borderColor: color.border, borderRadius: radius.small, color: color.text, fontFamily: font.sans, fontSize: 13, backgroundColor: color.surface },
  moreToggle: { flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-start", paddingVertical: 2 },
  moreText: { fontFamily: font.body, color: color.textMuted, fontSize: 12.5 },
  error: { fontFamily: font.body, color: color.danger, fontSize: 12.5, lineHeight: 19 },
  choices: { gap: 4 },
  choice: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 34, paddingHorizontal: 10, borderWidth: 1, borderColor: "transparent", borderRadius: radius.small },
  choiceOn: { borderColor: color.border, backgroundColor: alpha(color.text, 0.03) },
  choiceText: { flex: 1, fontFamily: font.body, color: color.textSecondary, fontSize: 13 },
  radio: { width: 16, height: 16, alignItems: "center", justifyContent: "center", borderWidth: 1.5, borderColor: color.frame, borderRadius: 8 },
  radioOn: { borderColor: color.accent },
  radioDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: color.accent },
  check: { flexDirection: "row", alignItems: "center", gap: 8, alignSelf: "flex-start" },
  box: { width: 16, height: 16, alignItems: "center", justifyContent: "center", borderWidth: 1.5, borderColor: color.frame, borderRadius: 4 },
  boxOn: { borderColor: color.accent, backgroundColor: color.accent },
});
