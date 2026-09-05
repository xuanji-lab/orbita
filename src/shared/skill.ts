/**
 * Skill 契约 —— IPC 四层的第 1 层。
 *
 * 一个 skill 就是 `skills/<slug>/SKILL.md`：frontmatter 里的 `name` 与 `description`
 * 是 pi 拼进 system prompt 的索引，正文是模型按索引 read 进去才看的详细指令。
 *
 * **启停不在这份契约里留字段**，因为它不是一个状态位而是文件在哪：
 * 在 `skills/` 里就启用，在 `skills-inactive/` 里就停用。
 * `enabled` 是扫盘时算出来的结果，不是我们存的值——磁盘布局就是全部真相。
 */

/**
 * 列表里的一条 skill。
 *
 * **`slug` 与 `name` 是两个东西，不要合并**：
 *   slug = 目录名，**定位用它**（启停 rename、读写 SKILL.md 都按它）
 *   name = frontmatter 里的名字，**pi 用它做 prompt 标识与 `/skill:name` 调用**
 *
 * 两者会分叉（用户改了 name 但目录不动），这是允许的。合并的代价是改个名字就要
 * rename 目录——那会让启停中的路径在用户眼皮底下变化，而且 rename 不可逆，
 * 不该由一次输入框编辑触发。
 */
export interface SkillMeta {
  slug: string;
  name: string;
  description: string;
  /** 由所在目录推出来：`skills/` = true，`skills-inactive/` = false */
  enabled: boolean;
}

/**
 * 详情页要编辑的三段。
 *
 * **渲染层拿不到也不需要 SKILL.md 原文**——frontmatter 的解析与重写留在主进程。
 * 这样渲染层不必知道文件格式，读-改-写也在同一侧完成，中间不会插进另一个写入者。
 */
export interface SkillContent {
  name: string;
  description: string;
  /** frontmatter 之外的正文 */
  body: string;
}

/**
 * 改哪几段。**缺席 = 不动**，不是「清空」。
 *
 * frontmatter 里 name / description 之外的字段（比如 `disable-model-invocation`）
 * 由主进程原样保留：用户手写的东西不该因为我们不认识就被吃掉。
 */
export interface SkillPatch {
  name?: string;
  description?: string;
  body?: string;
}

/** 名字上限。和工作区同一个理由：侧栏只有 288px。 */
export const SKILL_NAME_MAX = 60;

/**
 * slug 必须长得像个目录名。
 *
 * **这是安全检查，不是洁癖**：slug 从 renderer 经 IPC 传进来，直接拼进路径的话，
 * 一个 `../../` 就能读写 skills 目录之外的文件（同 `SESSION_ID` 的理由）。
 * 白名单比转义可靠：小写字母、数字、连字符、下划线、点，且不以点开头。
 */
const SLUG = /^[a-z0-9][a-z0-9._-]*$/i;

export function isSkillSlug(value: string): boolean {
  return value.length <= 100 && SLUG.test(value) && !value.includes("..");
}
