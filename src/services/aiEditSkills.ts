import { LocalCollectorError } from "./localCollector";
import type { ExploreConnection } from "./explorer";
import { request } from "./aiEdit";

// AI 剪辑的技能：用户自己装在这台电脑上的一套套做法（带 SKILL.md 的文件夹），装、删、开关、停后台命令都在采集器里，
// 页面只管设置里那一页和对话里「要不要运行这条命令」的确认卡片。技能是谁写的、要干什么，代码里一概不认，全看 SKILL.md。

/** 一个装好的技能。root 是技能包根目录、dir 是 SKILL.md 所在的目录、work 是应用给它建的工作目录（都是采集器那台电脑上的绝对路径） */
export interface AiEditSkill {
  id: string;
  name: string;
  description: string;
  root: string;
  dir: string;
  work: string;
  /** 从哪装的：GitHub 仓库（ref、subdir 是地址里带的分支和子目录），或本机文件夹（原地登记，不复制） */
  source: { type: "github"; url: string; ref: string | null; subdir: string | null } | { type: "folder"; path: string };
  enabled: boolean;
  /** 用户勾了「运行命令不用每次问」 */
  trustCommands: boolean;
  installedAt: string;
  /** 目录没了、SKILL.md 读不了时的一句话；好好的是 null */
  problem: string | null;
}

/** 正在后台跑的技能命令 */
/** leftover：命令自己退了，它起的进程（比如常驻服务）还在跑，也能停（前台命令留下的也算） */
export interface AiEditSkillJob { job_id: string; skill: string; command: string[]; started_at: string; status: "running" | "exited" | "stopped"; leftover?: boolean }

/**
 * AI 要运行技能里的一条命令：这一轮先停下，把命令挂在会话的 streaming.command 上，用户点「运行」才跑；
 * 点「不运行」、停止、到 expiresAt 还没点（15 分钟），都不跑。command 是参数数组，不经过 shell。
 */
export interface AiEditCommandAsk {
  id: string;
  kind: "command";
  /** 技能的名字（给人看）和 id */
  skill: string;
  skill_id: string;
  command: string[];
  /** 在哪个目录里跑（采集器那台电脑上的绝对路径） */
  cwd: string;
  /** 后台常驻：跑起来就一直在，到设置里停 */
  background: boolean;
  /** 毫秒时间戳，按采集器的钟；页面不拿来比，到点由采集器撤掉这一问 */
  expiresAt: number;
}

/**
 * 技能那几个工具（读写技能文件、跑命令、看后台命令、把产出放进素材库、把素材交给技能）：都不动时间线，
 * AI 在用它们时页面不说「正在改时间线」「AI 正在搭时间线」。和采集器 tools.mjs 里只在有启用的技能时才发的那几个对得上（有单测核对）
 */
export const SKILL_TOOLS: ReadonlySet<string> = new Set(["read_skill", "write_skill_file", "run_skill_command", "skill_job", "import_skill_file", "give_media_to_skill"]);

const skillPath = (id: string) => `/v1/ai-edit/skills/${encodeURIComponent(id)}`;

/** 装了哪些技能、有哪些后台命令在跑。旧版采集器没有技能接口时返回 null。 */
export async function listAiEditSkills(connection: ExploreConnection): Promise<{ skills: AiEditSkill[]; jobs: AiEditSkillJob[] } | null> {
  try {
    const value = await request(connection, "/v1/ai-edit/skills");
    return { skills: Array.isArray(value?.skills) ? value.skills : [], jobs: Array.isArray(value?.jobs) ? value.jobs : [] };
  } catch (error) {
    // 404 那句「当前采集器还没有 AI 剪辑功能」在这里不对，交给调用方说
    if (error instanceof LocalCollectorError && (error.code === "not_found" || error.code === "http_404")) return null;
    throw error;
  }
}

/**
 * 装技能：GitHub 仓库地址或本机文件夹路径。GitHub 的要下载解压，采集器那边最多等 3 分钟，这里多留一点。
 * skipped 是没装的那几条（本机文件夹里链到范围太大的文件夹的技能），每条一句话。
 */
export async function installAiEditSkill(connection: ExploreConnection, source: string): Promise<{ installed: AiEditSkill[]; skipped: string[] }> {
  const value = await request(connection, "/v1/ai-edit/skills", { method: "POST", body: JSON.stringify({ source }), timeoutMs: 200_000 });
  return {
    installed: Array.isArray(value?.installed) ? value.installed : [],
    skipped: Array.isArray(value?.skipped) ? value.skipped.filter((line: unknown) => typeof line === "string") : [],
  };
}

/** 开关技能、改「运行命令不用每次问」，回改好的技能 */
export async function updateAiEditSkill(connection: ExploreConnection, id: string, patch: { enabled?: boolean; trustCommands?: boolean }): Promise<AiEditSkill> {
  const value = await request(connection, skillPath(id), { method: "PATCH", body: JSON.stringify(patch) });
  return value.skill;
}

/** 删技能：本机文件夹只去掉登记、不动文件；工作目录留着 */
export async function removeAiEditSkill(connection: ExploreConnection, id: string): Promise<void> {
  await request(connection, skillPath(id), { method: "DELETE" });
}

export async function stopAiEditSkillJob(connection: ExploreConnection, jobId: string): Promise<void> {
  await request(connection, `/v1/ai-edit/skills/jobs/${encodeURIComponent(jobId)}/stop`, { method: "POST" });
}

/**
 * 用户在确认卡片上点了「运行」（allow）或「不运行」；remember 是勾了「这个技能以后不用问」。
 * 这一问已经结束（超时、停止、别的窗口答过）时采集器回 404。
 */
export async function answerAiEditCommand(connection: ExploreConnection, sessionId: string, askId: string, allow: boolean, remember: boolean): Promise<void> {
  await request(connection, `/v1/ai-edit/sessions/${encodeURIComponent(sessionId)}/command/${encodeURIComponent(askId)}`, { method: "POST", body: JSON.stringify({ allow, remember }) });
}

/** 参数数组拼成一行给人看：带空格、引号或空的参数加上双引号，免得看不出参数从哪断开（反斜杠照原样，Windows 路径好认） */
export const commandLine = (command: readonly string[]): string =>
  command.map((arg) => (!arg || /[\s"']/u.test(arg) ? `"${arg.replace(/"/gu, "\\\"")}"` : arg)).join(" ");
