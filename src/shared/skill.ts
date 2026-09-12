/**
 * Skill 契约 —— IPC 四层的第 1 层。
 *
 * 一个 skill 就是中心存储里的一个文件夹：`skills/<slug>/SKILL.md`。
 * frontmatter 里的 `name` 与 `description` 是 pi 拼进 system prompt 的索引，
 * 正文是模型按索引 read 进去才看的详细指令。
 *
 * **归属不在这份契约里留字段**：一个 skill 属于哪些集合，由 `skill-links/` 里的
 * symlink 表达（磁盘布局就是全部真相，没有第二份清单）。`global` / `workspaces`
 * 是扫链接目录算出来的结果，不是我们存的值。
 */

/**
 * 列表里的一条 skill。
 *
 * **`slug` 与 `name` 是两个东西，不要合并**：
 *   slug = 目录名，**定位用它**（link / 读写 SKILL.md 都按它）
 *   name = frontmatter 里的名字，**pi 用它做 prompt 标识与 `/skill:name` 调用**
 *
 * 两者会分叉（用户改了 name 但目录不动），这是允许的。合并的代价是改个名字就要
 * rename 目录——rename 不可逆，不该由一次输入框编辑触发。
 */
export interface SkillMeta {
  slug: string;
  name: string;
  description: string;
  /** 链在 `skill-links/global/`：对所有会话生效（含无工作区的会话） */
  global: boolean;
  /** 链在哪些工作区的 `skill-links/<workspaceId>/` 里（按目录名排序） */
  workspaces: string[];
  /**
   * 断链：链接还在、中心存储里的文件夹没了（用户在访达里删了存储目录）。
   * 要列出来并提供清理，**不能静默消失**——否则用户不知道自己的归属配置悬空了。
   */
  missing: boolean;
}

/**
 * link / unlink 的目标集合。
 *
 * **global 与 workspace 互斥**（双向）：链进 global 时它各 workspace 的链接删掉，
 * 链进某个 workspace 时 global 的链接删掉——否则 pi 会看到两条同名 skill。
 * 从 global 移出不自动加回任何 workspace（移入时删掉的链接不记历史）。
 */
export type SkillScope =
  | { kind: "global" }
  | { kind: "workspace"; workspaceId: string };

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
