import { readFileSync } from "node:fs";

import { invalid } from "./errors.mjs";

// 剪映特效/滤镜/转场/动画/字体/蒙版/混合模式目录，由 scripts/ai-edit/export-jianying-catalog.py
// 从 pyJianYingDraft（Apache-2.0，见 collector/licenses）导出。约 1.2MB，第一次用到才读。
let catalog = null;

function load() {
  catalog ??= JSON.parse(readFileSync(new URL("./catalog.json", import.meta.url), "utf8"));
  return catalog;
}

export function catalogSource() {
  return load().source;
}

/** 某个枚举的全部成员，顺序与 pyJianYingDraft 一致：[{ name, meta }]。 */
export function members(enumName) {
  const list = load().enums[enumName];
  if (!list) throw new Error(`Unknown catalog enum: ${enumName}`);
  return list;
}

/** 成员名（如「_1998」）换成剪映里显示的名字（「1998」）；不在目录里的原样返回。 */
export function displayName(raw) {
  for (const list of Object.values(load().enums)) {
    const found = list.find((member) => member.name === raw);
    if (found) return found.meta.name ?? found.meta.title ?? found.name;
  }
  return String(raw ?? "");
}

const ANIMATION_PHASES = { IntroType: "in", OutroType: "out", GroupAnimationType: "group", TextIntro: "in", TextOutro: "out", TextLoopAnim: "loop" };

function lookup(enumNames, raw) {
  for (const enumName of enumNames) {
    const list = members(enumName);
    const found = list.find((member) => member.name === raw) ?? list.find((member) => (member.meta.name ?? member.meta.title) === raw);
    if (found) return { enumName, meta: found.meta };
  }
  return null;
}

/**
 * 给看板预览补上剪映目录里的信息（不存进工程）：动画是入场 / 出场 / 组合（文字是循环）哪一种、默认多长，转场默认多长。
 * 查法和写草稿时一样（几类按顺序找，先认成员名）；查不到的原样。
 */
export function withPreviewHints(project) {
  if (!project?.tracks) return project;
  return {
    ...project,
    tracks: project.tracks.map((track) => ({
      ...track,
      segments: (track.segments ?? []).map((segment) => {
        let next = segment;
        if (segment.animations?.length) {
          const enums = segment.kind === "text" ? ["TextIntro", "TextOutro", "TextLoopAnim"] : ["IntroType", "OutroType", "GroupAnimationType"];
          next = { ...next, animations: segment.animations.map((item) => {
            const found = lookup(enums, item.animation_type);
            return found ? { ...item, phase: ANIMATION_PHASES[found.enumName], default_us: found.meta.duration ?? null } : item;
          }) };
        }
        if (segment.transition) {
          const found = lookup(["TransitionType"], segment.transition.transition_type);
          if (found?.meta.default_duration) next = { ...next, transition: { ...segment.transition, default_us: found.meta.default_duration } };
        }
        return next;
      }),
    })),
  };
}

/**
 * 对应原仓库 draft.py 的 _enum_member：先按成员名找（如「叠化」「_1980」）。
 * ponytail: 另外接受目录里的显示名（meta.name / meta.title），方便模型直接用看到的中文名；
 * 原仓库的第二轮比较实际上只认成员名，这里是它的超集。
 */
export function enumMember(enumName, raw) {
  const list = members(enumName);
  const found = list.find((member) => member.name === raw)
    ?? list.find((member) => (member.meta.name ?? member.meta.title) === raw);
  if (!found) throw invalid("DRAFT_FEATURE_INVALID", `Unknown ${enumName}: ${raw}`);
  return found;
}
