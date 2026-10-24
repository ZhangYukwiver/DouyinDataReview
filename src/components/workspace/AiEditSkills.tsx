import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Check } from "lucide-react-native";
import type { ExploreConnection } from "../../services/explorer";
import {
  commandLine, installAiEditSkill, listAiEditSkills, removeAiEditSkill, stopAiEditSkillJob, updateAiEditSkill,
  type AiEditCommandAsk, type AiEditSkill, type AiEditSkillJob,
} from "../../services/aiEditSkills";
import { errorText, shortTime, web, webPointer } from "./aiEditShared";
import { ErrorLine, kit, SmallButton } from "./CreatorKit";
import { ws } from "./motion";
import { workspaceColors as color, workspaceFonts as font, workspaceRadii as radius } from "./workspaceTheme";

// AI 剪辑的技能：设置里的「技能」一节（装、开关、删、停后台命令），和对话里 AI 要运行技能命令时的确认卡片。
// 技能是用户自己装的第三方做法，这里不认任何具体技能，名字、说明、命令都照采集器给的显示。
// 技能一节只要一个 connection，数据自己读，挂在哪个设置页里都行。

/** 命令、路径这类没空格的长串：web 上允许在任意处折行，不撑破卡片 */
const webWrap = web ? ({ overflowWrap: "anywhere" } as object) : null;

type SkillList = { skills: AiEditSkill[]; jobs: AiEditSkillJob[] };

// 设置收起、换到别的设置页时这一节会卸载：上次读到的列表和正在装的那一次按采集器地址记在模块里，
// 重新打开先显示上次的列表；还没装完的接着显示「安装中…」，收起期间装完的把结果补上
const lists = new Map<string, SkillList | "old">();
/** 正在装、或者装完了还没显示过的那一次。装完 note（装好了哪些）、problem（没装上的原因）有一个 */
interface InstallRun { source: string; pending: boolean; note: string | null; problem: string | null; done: Promise<void> }
const installs = new Map<string, InstallRun>();

/** 开始装一个技能：同一个采集器上还有一次没装完就不再发（返回 null）；done 不会失败，结果写在这一次上 */
export function startInstall(conn: ExploreConnection, source: string): InstallRun | null {
  if (installs.get(conn.baseUrl)?.pending) return null;
  const run: InstallRun = { source, pending: true, note: null, problem: null, done: Promise.resolve() };
  run.done = installAiEditSkill(conn, source).then(({ installed, skipped }) => {
    run.note = [installed.length
      ? `装好了${installed.map((item) => `「${item.name}」`).join("、")}，剪辑时用得上，AI 会先读它的说明再照着做。`
      : "这个地址里没有新的技能。", ...skipped].join("");
  }, (reason) => {
    run.problem = errorText(reason, "技能没装上，请检查地址后重试。");
  }).finally(() => { run.pending = false; });
  installs.set(conn.baseUrl, run);
  return run;
}

/** 列表多久重读一次：有后台命令在跑 5 秒，跑完、停掉的跟着下去；没有也 15 秒看一次（设置开着时 AI 可能刚起了后台命令，第一次没读到也接着试）。采集器没有技能功能就不读 */
export const pollEvery = (list: SkillList | "old" | null): number | null =>
  list === "old" ? null : list?.jobs.some((job) => job.status === "running") ? 5000 : 15000;

/** 读技能列表：每次发起读、改、删、停都让序号加一，读回来时序号变了就丢掉——这期间页面上的列表动过（开关先拨过去了、技能删了），
 *  旧的那份会把它闪回去；轮询时上一次还没回来就不再发，采集器卡住时请求不越堆越多。old 是采集器还没有技能接口 */
export function skillsLoader(onList: (list: SkillList | "old") => void, onProblem: (reason: unknown) => void) {
  let seq = 0;
  let inFlight = 0;
  const load = async (conn: ExploreConnection) => {
    const mine = ++seq;
    inFlight += 1;
    try {
      const list = (await listAiEditSkills(conn)) ?? "old";
      if (mine === seq) onList(list);
    } catch (reason) {
      if (mine === seq) onProblem(reason);
    } finally {
      inFlight -= 1;
    }
  };
  return {
    load,
    poll: (conn: ExploreConnection) => (inFlight ? Promise.resolve() : load(conn)),
    /** 还在路上的读作废 */
    bump: () => { seq += 1; },
    /** 改、删、停的请求包在这里：发之前让还在路上的读作废，做完（成没成都一样）再作废一次——请求在路上时轮询发出去的读，回来的可能还是改之前的列表 */
    async guard<T>(work: () => Promise<T>): Promise<T> {
      seq += 1;
      try { return await work(); } finally { seq += 1; }
    },
  };
}

export function SkillsPanel({ connection }: { connection: ExploreConnection | null }) {
  // 外面每次渲染都可能新建 connection 对象：只在地址或令牌变了时才重读
  const baseUrl = connection?.baseUrl ?? null;
  const token = connection?.token ?? null;
  const conn = useMemo(() => (baseUrl && token ? { baseUrl, token } : null), [baseUrl, token]);
  // null 是还在读；old 是采集器还没有技能接口。上次读到的先拿来显示，下面接着重读
  const [list, setList] = useState<SkillList | "old" | null>(() => (baseUrl ? lists.get(baseUrl) ?? null : null));
  // 列表没读到的原因：和下面装、改、删、停的提示分开，在输入框里打字不清掉它，下次读到了自己撤掉
  const [loadProblem, setLoadProblem] = useState<string | null>(null);
  const [source, setSource] = useState("");
  const [installing, setInstalling] = useState(() => Boolean(baseUrl && installs.get(baseUrl)?.pending));
  // 一行说明：装好了哪些（note），或者哪一步没做成（problem）
  const [note, setNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  // 正在改的技能、正在停的后台命令：回来之前再点不发第二次
  const pending = useRef(new Set<string>());
  const [stopping, setStopping] = useState<string[]>([]);
  const alive = useRef(false);
  // 过期的回复丢掉、轮询不叠着发（见 skillsLoader）。setList / setLoadProblem 不会变，建一次就够；换了采集器，新的那次读让旧地址的回复作废
  const loader = useRef<ReturnType<typeof skillsLoader> | null>(null);
  if (!loader.current) loader.current = skillsLoader((next) => { setList(next); setLoadProblem(null); },
    (reason) => setLoadProblem(errorText(reason, "技能列表没读到，请稍后重试。")));
  const { load: loadFrom, poll: pollFrom, guard } = loader.current;

  const load = useCallback(async () => { if (conn) await loadFrom(conn); }, [conn, loadFrom]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (baseUrl && list) lists.set(baseUrl, list); }, [baseUrl, list]);
  const every = conn ? pollEvery(list) : null;
  useEffect(() => {
    if (!every || !conn) return undefined;
    const timer = setInterval(() => void pollFrom(conn), every);
    return () => clearInterval(timer);
  }, [every, conn, pollFrom]);

  /** 等这一次装完：面板还开着就显示结果、重读列表，并从模块里撤掉；收起了就留给下次打开 */
  const follow = useCallback((run: InstallRun) => {
    setInstalling(run.pending);
    void run.done.then(() => {
      if (!alive.current || !baseUrl || installs.get(baseUrl) !== run) return;
      installs.delete(baseUrl);
      setInstalling(false);
      if (run.problem) { setProblem(run.problem); return; }
      // 装的时候又改了输入框就留着改过的
      setSource((current) => (current.trim() === run.source ? "" : current));
      setNote(run.note);
      void load();
    });
  }, [baseUrl, load]);
  useEffect(() => {
    alive.current = true;
    const run = baseUrl ? installs.get(baseUrl) : undefined;
    if (run) follow(run);
    return () => { alive.current = false; };
  }, [baseUrl, follow]);

  const install = () => {
    const text = source.trim();
    if (!conn || !text) return;
    const run = startInstall(conn, text);
    if (!run) return;
    setNote(null);
    setProblem(null);
    follow(run);
  };

  const replace = (next: AiEditSkill) => setList((current) => (current && current !== "old"
    ? { ...current, skills: current.skills.map((item) => (item.id === next.id ? next : item)) } : current));

  /** 开关、勾「不用每次问」：先在页面上改过来，没存上再改回去 */
  const patch = async (item: AiEditSkill, change: { enabled?: boolean; trustCommands?: boolean }) => {
    if (!conn || pending.current.has(item.id)) return;
    pending.current.add(item.id);
    setProblem(null);
    replace({ ...item, ...change });
    try {
      replace(await guard(() => updateAiEditSkill(conn, item.id, change)));
    } catch (reason) {
      replace(item);
      setProblem(errorText(reason, `「${item.name}」的设置没存上，请再点一次。`));
    } finally {
      pending.current.delete(item.id);
    }
  };

  const remove = async (item: AiEditSkill) => {
    setConfirm(null);
    if (!conn || pending.current.has(item.id)) return;
    pending.current.add(item.id);
    setProblem(null);
    try {
      await guard(() => removeAiEditSkill(conn, item.id));
      setList((current) => (current && current !== "old" ? { ...current, skills: current.skills.filter((other) => other.id !== item.id) } : current));
    } catch (reason) {
      setProblem(errorText(reason, `「${item.name}」没删掉，请稍后重试。`));
    } finally {
      pending.current.delete(item.id);
    }
  };

  const stop = async (job: AiEditSkillJob) => {
    if (!conn || stopping.includes(job.job_id)) return;
    setStopping((ids) => [...ids, job.job_id]);
    setProblem(null);
    try {
      await guard(() => stopAiEditSkillJob(conn, job.job_id));
      await load();
    } catch (reason) {
      setProblem(errorText(reason, "没停下来，请再点一次。"));
    } finally {
      setStopping((ids) => ids.filter((id) => id !== job.job_id));
    }
  };

  const skills = list && list !== "old" ? list.skills : [];
  const jobs = list && list !== "old" ? list.jobs : [];
  // 设置窗口「技能」那一页的正文：页标题和说明由窗口画
  return <View style={styles.panel}>
    {!conn ? <Text style={kit.muted}>连接采集器后才能装技能。</Text>
      : list === "old" ? <Text style={kit.muted}>当前采集器还没有技能功能，重启应用后再试。</Text> : <>
      <View style={styles.installRow}>
        <TextInput accessibilityLabel="技能的 GitHub 地址或本机文件夹" value={source} onChangeText={(text) => { setSource(text); setProblem(null); }} onSubmitEditing={install}
          maxLength={2000} autoCapitalize="none" autoCorrect={false} placeholder="GitHub 地址或本机文件夹路径" placeholderTextColor={color.textMuted} style={styles.input} />
        <SmallButton label={installing ? "安装中…" : "安装"} disabled={!installing && !source.trim()} onPress={install} />
      </View>
      <Text style={kit.muted}>GitHub 的会下载到应用里，重装同一个仓库就是更新；本机文件夹原地使用，不复制。</Text>
      {note ? <Text style={styles.note}>{note}</Text> : null}
      {problem ? <Text accessibilityRole="alert" style={styles.errorText}>{problem}</Text> : null}
      {loadProblem ? <ErrorLine text={loadProblem} onRetry={() => { setLoadProblem(null); void load(); }} /> : null}
      {/* 第一次就没读到：上面那行已经说了原因，不再转圈；点了重试才转 */}
      {list === null ? (loadProblem ? null : <ActivityIndicator size="small" color={color.textMuted} style={{ alignSelf: "flex-start" }} />)
        : skills.length ? skills.map((item) => <SkillRow key={item.id} skill={item}
            shared={item.source.type === "github" && skills.some((other) => other.id !== item.id && other.root === item.root)}
            confirming={confirm === item.id}
            onPatch={(change) => void patch(item, change)}
            onAskRemove={() => setConfirm(item.id)}
            onRemove={() => void remove(item)}
            onCancelRemove={() => setConfirm(null)} />)
        : <Text style={kit.muted}>还没装技能。</Text>}
      {jobs.length ? <View style={styles.jobs}>
        <Text style={styles.group}>后台在跑的命令</Text>
        {jobs.map((job) => <JobRow key={job.job_id} job={job} stopping={stopping.includes(job.job_id)} onStop={() => void stop(job)} />)}
      </View> : null}
    </>}
  </View>;
}

export function SkillRow({ skill, shared, confirming, onPatch, onAskRemove, onRemove, onCancelRemove }: {
  skill: AiEditSkill;
  /** GitHub 包里还有别的技能：删这一个时下载的文件先留着 */
  shared: boolean;
  confirming: boolean;
  onPatch: (change: { enabled?: boolean; trustCommands?: boolean }) => void;
  onAskRemove: () => void; onRemove: () => void; onCancelRemove: () => void;
}) {
  const where = skill.source.type === "folder" ? `本机文件夹 ${skill.source.path}` : skill.source.url;
  const removeNote = skill.source.type === "folder" ? "删掉后 AI 就用不了它了，本机文件夹里的文件不动。"
    : shared ? "删掉后 AI 就用不了它了；同一个仓库里还装着别的技能，下载的文件先留着。"
      : "删掉后 AI 就用不了它了，下载下来的文件和技能自己存在里面的数据（比如它保存的作品）一起删掉。";
  return <View style={styles.skill}>
    <View style={styles.skillHead}>
      <Text numberOfLines={1} style={styles.skillName}>{skill.name}</Text>
      <Text style={[styles.state, skill.problem ? { color: color.danger } : skill.enabled ? { color: color.accent } : null]}>{skill.problem ? "用不了" : skill.enabled ? "已启用" : "已停用"}</Text>
    </View>
    {skill.problem ? <Text style={styles.errorText}>{skill.problem}</Text> : null}
    {skill.description ? <Text numberOfLines={2} style={kit.muted}>{skill.description}</Text> : null}
    <Text selectable numberOfLines={2} style={[styles.mono, styles.source, webWrap]}>{where}</Text>
    <View style={styles.checks}>
      {/* 装了好几个技能时读屏只念「启用」分不出是哪个：读屏名称带上技能名，看得见的字不变 */}
      <CheckChip checked={skill.enabled} label="启用" a11yLabel={`启用技能「${skill.name}」`} onToggle={() => onPatch({ enabled: !skill.enabled })} />
      <CheckChip checked={skill.trustCommands} label="运行命令不用每次问" a11yLabel={`技能「${skill.name}」运行命令不用每次问`} onToggle={() => onPatch({ trustCommands: !skill.trustCommands })} />
    </View>
    <Text style={[kit.muted, skill.trustCommands && { color: color.amber }]}>勾上后，AI 运行这个技能的命令不再先问你。命令能读写这台电脑上的文件，只给信得过的技能勾。</Text>
    {confirming
      ? <View style={styles.confirm}>
        <Text style={kit.muted}>{removeNote}</Text>
        <View style={kit.row}>
          <Pressable accessibilityRole="button" accessibilityLabel={`删除技能「${skill.name}」`} onPress={onRemove} style={webPointer}><Text style={styles.dangerLink}>删除</Text></Pressable>
          <Pressable accessibilityRole="button" onPress={onCancelRemove} style={webPointer}><Text style={kit.muted}>取消</Text></Pressable>
        </View>
      </View>
      : <Pressable accessibilityRole="button" accessibilityLabel={`删除技能「${skill.name}」`} onPress={onAskRemove} style={[styles.removeLink, webPointer]}><Text style={styles.link}>删除</Text></Pressable>}
  </View>;
}

/**
 * 一条后台命令：哪个技能、几点开始、命令，在跑的能停。
 * SmallButton 的读屏名称就是按钮上的字，几条都叫「停止」分不出来：照它的样子写，读屏名称带上技能和开始时间（同一个技能可能起了两条）
 */
export function JobRow({ job, stopping, onStop }: { job: AiEditSkillJob; stopping: boolean; onStop: () => void }) {
  return <View style={styles.job}>
    <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
      <Text numberOfLines={1} style={kit.muted}>{`技能「${job.skill}」 · ${shortTime(job.started_at)} 开始${job.leftover ? " · 命令已退出，它起的进程还在跑" : job.status === "running" ? "" : job.status === "stopped" ? " · 已停止" : " · 已结束"}`}</Text>
      <Text selectable numberOfLines={3} style={[styles.mono, webWrap]}>{commandLine(job.command)}</Text>
    </View>
    {job.status === "running" ? <Pressable {...ws("btn")} accessibilityRole="button" accessibilityLabel={`停止技能「${job.skill}」${shortTime(job.started_at)} 开始的后台命令`} onPress={onStop} style={styles.button}>
      <Text style={styles.buttonText}>{stopping ? "停止中…" : "停止"}</Text>
    </Pressable> : null}
  </View>;
}

/** 一个勾选框（RN-web 不输出 accessibilityState 里的 checked，aria-checked 要直接写）；a11yLabel 是读屏名称，不给就念看得见的字 */
function CheckChip({ checked, label, a11yLabel, disabled = false, onToggle }: { checked: boolean; label: string; a11yLabel?: string; disabled?: boolean; onToggle: () => void }) {
  return <Pressable accessibilityRole="checkbox" accessibilityLabel={a11yLabel ?? label} accessibilityState={{ checked, disabled }} aria-checked={checked} disabled={disabled} onPress={onToggle}
    style={[styles.chip, checked && styles.chipOn, disabled && { opacity: 0.45 }, webPointer]}>
    {checked ? <Check size={12} color={color.accent} /> : null}
    <Text style={[styles.chipText, checked && { color: color.accent }]}>{label}</Text>
  </Pressable>;
}

/**
 * AI 要运行技能里的一条命令时问一句：哪个技能、什么命令、在哪个目录，用户点「运行」采集器才跑。点过就锁住按钮和勾选框。
 * 和生成视频的确认卡片一样，超时以采集器为准，它到点撤掉这一问，卡片跟着没了；换了一问由外面按 id 换 key，状态从头来。
 */
export function CommandCard({ ask, onAnswer }: { ask: AiEditCommandAsk; onAnswer: (askId: string, allow: boolean, remember: boolean) => Promise<void> }) {
  // 点了哪个：null 是还没点（或者没送到，可以再点）
  const [choice, setChoice] = useState<boolean | null>(null);
  const [remember, setRemember] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const locked = choice !== null;
  const answer = async (allow: boolean) => {
    if (locked) return;
    setChoice(allow);
    setProblem(null);
    try {
      // 「以后不用问」只跟着「运行」走
      await onAnswer(ask.id, allow, allow && remember);
    } catch (reason) {
      // 这一问已经结束了（超时、点了停止、别的窗口答过）：按钮保持锁住；连接断了之类的放开再点
      if (/^(spend|command)_not_found$/u.test((reason as { code?: string }).code ?? "")) { setProblem("这一步已经结束了，不用再点。"); return; }
      setChoice(null);
      setProblem(errorText(reason, "没送到采集器，请再点一次。"));
    }
  };
  const status = choice === true ? (ask.background ? "好的，放到后台运行。" : "好的，开始运行。") : choice === false ? "好的，这条不运行。" : "15 分钟内不点就不运行。";
  return <View accessibilityRole="alert" style={styles.card}>
    <Text style={styles.cardTitle}>AI 想运行技能「{ask.skill}」的命令</Text>
    <Text selectable numberOfLines={6} style={[styles.mono, styles.command, webWrap]}>{commandLine(ask.command)}</Text>
    <Text numberOfLines={2} style={[styles.cardFacts, webWrap]}>在 <Text style={styles.mono}>{ask.cwd}</Text></Text>
    {ask.background ? <Text style={styles.cardFacts}>会在后台一直运行，可在设置里停止</Text> : null}
    <CheckChip checked={remember} label="这个技能以后不用问" disabled={locked} onToggle={() => setRemember((value) => !value)} />
    <View style={kit.row}>
      <SmallButton label="运行" disabled={locked} onPress={() => void answer(true)} />
      <SmallButton label="不运行" disabled={locked} onPress={() => void answer(false)} />
    </View>
    {problem ? <Text style={styles.errorText}>{problem}</Text> : <Text style={kit.muted}>{status}</Text>}
  </View>;
}

const styles = StyleSheet.create({
  panel: { gap: 10 },
  group: { color: color.text, fontFamily: font.body, fontSize: 12.5, fontWeight: "600" },
  installRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  input: { flex: 1, minWidth: 0, minHeight: 34, paddingHorizontal: 11, color: color.text, fontFamily: font.body, fontSize: 13, borderWidth: 1, borderColor: color.border, borderRadius: radius.small, backgroundColor: color.surfaceRaised },
  note: { color: color.text, fontFamily: font.body, fontSize: 12, lineHeight: 18 },
  errorText: { color: color.danger, fontFamily: font.body, fontSize: 12, lineHeight: 18 },
  mono: { color: color.textSecondary, fontFamily: font.mono, fontSize: 11, lineHeight: 16 },

  skill: { gap: 6, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.borderSoft },
  skillHead: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  skillName: { flexShrink: 1, color: color.text, fontFamily: font.body, fontSize: 13, fontWeight: "600" },
  state: { color: color.textMuted, fontFamily: font.body, fontSize: 11 },
  source: { color: color.textMuted },
  checks: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: { flexDirection: "row", alignItems: "center", gap: 5, alignSelf: "flex-start", paddingHorizontal: 9, paddingVertical: 5, borderWidth: 1, borderColor: color.border, borderRadius: radius.small, backgroundColor: color.surface },
  chipOn: { borderColor: color.accent, backgroundColor: color.accentSoft },
  chipText: { color: color.text, fontFamily: font.body, fontSize: 11, fontWeight: "600" },
  confirm: { gap: 4 },
  removeLink: { alignSelf: "flex-start" },
  link: { color: color.accentAction, fontFamily: font.body, fontSize: 11 },
  dangerLink: { color: color.danger, fontFamily: font.body, fontSize: 12, fontWeight: "600" },
  jobs: { gap: 8, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.borderSoft },
  job: { flexDirection: "row", alignItems: "center", gap: 8 },
  // 和 CreatorKit 的 SmallButton 一样
  button: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 7, borderWidth: 1, borderColor: color.border, borderRadius: radius.small, backgroundColor: color.surface },
  buttonText: { color: color.text, fontFamily: font.body, fontSize: 12, fontWeight: "600" },

  card: { gap: 6, padding: 10, borderWidth: 1, borderColor: color.accent, borderRadius: radius.small, backgroundColor: color.accentSoft },
  cardTitle: { color: color.text, fontFamily: font.body, fontSize: 13, fontWeight: "600" },
  cardFacts: { color: color.textSecondary, fontFamily: font.body, fontSize: 11.5, lineHeight: 17 },
  command: { paddingHorizontal: 9, paddingVertical: 6, color: color.text, borderRadius: radius.small, backgroundColor: color.surface },
});
