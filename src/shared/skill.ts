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
  /**
   * 中心存储条目本身是个指向用户目录的 symlink（4-1 导入的形态，两跳：
   * skill-link → store 条目 → 真身）。null = 普通文件夹。详情里要标 Linked
   * 并显示真实路径，「在访达里显示」揭示的也是真身。
   */
  linkedPath: string | null;
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

/**
 * `/skill:<target>` 指令的解析（主进程展开用）。**target 取到第一个空白为止**，
 * 其余全是附加指示。不是这个形状返回 null，照常发送。
 */
export function parseSkillInvocation(text: string): { target: string; rest?: string } | null {
  const match = /^\/skill:([^\s]+)(?:\s([\s\S]*))?$/.exec(text.trim());
  if (match === null) return null;
  const target = match[1] ?? "";
  const rest = match[2]?.trim();
  return target === "" ? null : rest !== undefined && rest !== "" ? { target, rest } : { target };
}

/**
 * `/skill:` 的 target 匹配：先按 slug（面板插入的形态、文件系统安全字符集），
 * 再按 frontmatter 名。可用性过滤（missing / global / workspace）由调用方先做，
 * 这里只管名字。找不到返回 null。
 */
export function matchSkillTarget<T extends { slug: string; name: string }>(
  available: readonly T[],
  target: string,
): T | null {
  return available.find((m) => m.slug === target) ?? available.find((m) => m.name === target) ?? null;
}

/**
 * 展开成 pi 同款的 `<skill>` 块用户消息（pi 的 formatSkillInvocation 同一形状，
 * 两端必须一致：模型靠它认 skill，显示端靠它认折叠卡）。instructions 是
 * `/skill:x` 后面用户补的附加指示，拼在块后。
 */
export function formatSkillBlock(parts: {
  name: string;
  location: string;
  body: string;
  instructions?: string;
}): string {
  const slash = Math.max(parts.location.lastIndexOf("/"), parts.location.lastIndexOf("\\"));
  const dir = slash > 0 ? parts.location.slice(0, slash) : "/";
  const block = `<skill name="${parts.name}" location="${parts.location}">\nReferences are relative to ${dir}.\n\n${parts.body}\n</skill>`;
  return parts.instructions !== undefined ? `${block}\n\n${parts.instructions}` : block;
}

/**
 * 从用户消息原文里解析 skill 块（显示端用）。解析出块时 rest 是块后面的
 * 附加指示（可能是空串）；没解析出返回 null，消息照常渲染。
 */
export function parseSkillBlock(text: string): { name: string; content: string; rest: string } | null {
  const match = /^<skill name="([^"]+)"[^>]*>\n([\s\S]*)\n<\/skill>(?:\n\n([\s\S]*))?$/.exec(text);
  if (match === null) return null;
  return { name: match[1] ?? "", content: match[2] ?? "", rest: match[3] ?? "" };
}

/**
 * 一次 read 调用是不是在用某条 skill：路径以 `<任意目录>/<slug>/SKILL.md` 结尾
 * 且 slug 命中已知 skill。**只认 slug 尾巴不认全路径**——pi 把链接目录
 * （junction / symlink）的路径写进 system prompt，真实读到的路径随平台与
 * 规范化而变，但 `<slug>/SKILL.md` 这个尾巴在存储路径和链接路径上都在。
 * # ponytail: 极端情况会误标（某仓库里恰好有同名 `<slug>/SKILL.md` 被读），
 * 代价只是一个徽标，不值得为此把存储路径传进 renderer。
 */
export function skillForReadPath(
  path: string,
  skills: ReadonlyArray<{ slug: string; name: string }>,
): { slug: string; name: string } | null {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  const match = /(^|\/)([^/]+)\/skill\.md$/.exec(normalized);
  const dir = match?.[2];
  if (dir === undefined) return null;
  return skills.find((skill) => skill.slug.toLowerCase() === dir) ?? null;
}
