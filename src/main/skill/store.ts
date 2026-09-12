/**
 * Skills 落盘 —— 中心存储 + 集合链接（三-B 裁决的模型）：
 *
 *   skills/<slug>/SKILL.md                 中心存储：每个 skill 唯一的真实文件夹，从不移动
 *   skill-links/global/<slug>              → skills/<slug>（对所有会话生效）
 *   skill-links/<workspaceId>/<slug>       → skills/<slug>（只对该工作区的会话生效）
 *
 * **一个 skill 的状态 = 它被哪些集合链接着。** 哪里都没链 = 停用。
 * 没有开关字段、没有清单文件——磁盘布局就是全部状态，不会出现「清单说链了
 * 但文件早删了」这种两份真相对不上的情况。
 *
 * **用户的文件夹永远不被 rename / 删除**：启停只是加 / 删 symlink（链接坏了
 * 也只是丢一次归属，存储无损）。这是弃用目录互移的理由——rename 不可逆，
 * 而且表达不了多对多。
 *
 * symlink 目标一律绝对路径：Windows 目录链接要走 junction（要特权才能建真
 * symlink），而 junction 只认绝对路径——统一用绝对目标，一条代码路径两平台通吃。
 */
import { lstat, mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isNotFound } from "../fs-errors.ts";
import {
  isSkillSlug,
  type SkillContent,
  type SkillMeta,
  type SkillPatch,
  type SkillScope,
} from "../../shared/skill.ts";

/** 中心存储。每个 skill 的真身只住在这里。 */
export const SKILLS_DIR = "skills";
/** 集合链接的根：global 与每个 workspace 各一个子目录。 */
export const SKILL_LINKS_DIR = "skill-links";
/** global 集合的目录名。 */
export const GLOBAL_SET = "global";

const SKILL_FILE = "SKILL.md";

export class SkillStore {
  private readonly storeDir: string;
  private readonly linksRoot: string;

  constructor(configDir: string) {
    this.storeDir = join(configDir, SKILLS_DIR);
    this.linksRoot = join(configDir, SKILL_LINKS_DIR);
  }

  /** 中心存储目录（「在文件管理器中打开」给新建 / 删除用）。 */
  storeRoot(): string {
    return this.storeDir;
  }

  /**
   * 某条会话该拿哪些集合目录（主进程把它填进开轮命令的 `skillsDirs`）。
   * global 恒在；有工作区的会话再加它自己的那条。目录不存在不是错——
   * pi 的加载器对不存在的目录返回空（resource-loader.js 先 existsSync）。
   */
  linkDirs(workspaceId: string | null): string[] {
    const dirs = [join(this.linksRoot, GLOBAL_SET)];
    if (workspaceId !== null) dirs.push(join(this.linksRoot, workspaceId));
    return dirs;
  }

  /** 建出中心存储与 global 集合目录。workspace 的集合目录在第一次 link 时按需建。 */
  async ensureDirs(): Promise<void> {
    await mkdir(this.storeDir, { recursive: true });
    await mkdir(join(this.linksRoot, GLOBAL_SET), { recursive: true });
  }

  /**
   * 列全部 skill：中心存储里的每一条 + 只剩断链引用的（missing）。
   *
   * **按 slug 排序，不用 readdir 的顺序。** 这不是为了好看：skill 的索引进 system
   * prompt，而 prompt 是 provider 端缓存的第一个断点。顺序一抖，内容明明没变，
   * 整条 prefix 缓存也会作废——pi 自己不排序（它按 readdir 返回，实测是创建顺序），
   * 所以这道保险得我们来上。
   */
  async list(): Promise<SkillMeta[]> {
    const memberships = await this.scanLinks();
    const stored = await this.scanStore();
    const bySlug = new Map<string, SkillMeta>();
    for (const meta of stored) bySlug.set(meta.slug, meta);
    // 断链的归属：链接在、存储里没有这条——列出来（missing），提供清理而不是静默消失
    for (const [slug, sets] of memberships) {
      const meta = bySlug.get(slug);
      if (meta === undefined) {
        bySlug.set(slug, {
          slug,
          name: slug,
          description: "",
          global: sets.has(GLOBAL_SET),
          workspaces: [...sets].filter((s) => s !== GLOBAL_SET).sort(),
          missing: true,
        });
        continue;
      }
      meta.global = sets.has(GLOBAL_SET);
      meta.workspaces = [...sets].filter((s) => s !== GLOBAL_SET).sort();
    }
    return [...bySlug.values()].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  }

  /**
   * 把 skill 链进一个集合。
   *
   * 互斥是双向的（否则 pi 会看到两条同名 skill）：链进 global 时删它在各
   * workspace 的链接；链进 workspace 时删它的 global 链接。从集合移出
   * （unlink）不自动补链接——删掉的归属不记历史。
   *
   * 目标位置已有**不是 symlink** 的东西就拒绝：那可能是用户手放的文件夹，
   * 覆盖等于删用户文件。
   */
  async link(slug: string, scope: SkillScope): Promise<void> {
    assertSlug(slug);
    // 输入校验先于一切 IO：坏的集合 id 不该走到磁盘检查那步才被拦
    if (scope.kind === "workspace") assertSetId(scope.workspaceId);
    const storeDir = join(this.storeDir, slug);
    if (!(await exists(join(storeDir, SKILL_FILE)))) {
      throw new Error(`skill 不存在：${slug}（中心存储里没有这个文件夹，断链请用 clean）`);
    }
    if (scope.kind === "global") {
      // global 是「对所有会话生效」，与任何 workspace 链接互斥
      for (const workspaceId of await this.workspaceSetDirs()) {
        await this.removeLink(join(this.linksRoot, workspaceId, slug));
      }
      await this.createLink(storeDir, join(this.linksRoot, GLOBAL_SET, slug));
      return;
    }
    assertSetId(scope.workspaceId);
    await this.removeLink(join(this.linksRoot, GLOBAL_SET, slug));
    await this.createLink(storeDir, join(this.linksRoot, scope.workspaceId, slug));
  }

  /** 从一个集合里移出。只删链接，永不碰中心存储。没链就静默（幂等）。 */
  async unlink(slug: string, scope: SkillScope): Promise<void> {
    assertSlug(slug);
    const setDir = scope.kind === "global" ? GLOBAL_SET : assertSetId(scope.workspaceId);
    await this.removeLink(join(this.linksRoot, setDir, slug));
  }

  /**
   * 清掉一条 skill 的全部链接引用（missing 的收尾动作）。
   * 只删 symlink；遇到同名非链接条目照样拒绝——它可能是用户放的实体文件夹。
   */
  async clean(slug: string): Promise<void> {
    assertSlug(slug);
    for (const set of await this.setDirs()) {
      await this.removeLink(join(this.linksRoot, set, slug));
    }
  }

  /**
   * 工作区被移除时，它的集合目录整个删掉——**只是链接，不伤中心存储**。
   * 失败只丢链接不丢数据，但会留下悬空集合，调用方应当打日志。
   */
  async removeWorkspace(workspaceId: string): Promise<void> {
    assertSetId(workspaceId);
    await rm(join(this.linksRoot, workspaceId), { recursive: true, force: true });
  }

  /** 读详情。不存在返回 null（用户可能刚在访达里删掉了它）。 */
  async read(slug: string): Promise<SkillContent | null> {
    const file = await this.locate(assertSlug(slug));
    if (file === null) return null;
    const raw = await readFile(file, "utf8");
    const parsed = parseSkillMd(raw);
    return { name: parsed.name ?? slug, description: parsed.description ?? "", body: parsed.body };
  }

  /**
   * 改详情。**只替换指定字段**，frontmatter 里其它键原样保留——
   * 用户手写的 `disable-model-invocation`、`allowed-tools` 之类不该因为我们
   * 不认识就被吃掉。
   */
  async write(slug: string, patch: SkillPatch): Promise<void> {
    const file = await this.locate(assertSlug(slug));
    if (file === null) throw new Error(`skill 不存在：${slug}`);
    const raw = await readFile(file, "utf8");
    await writeFile(file, rebuildSkillMd(raw, patch), "utf8");
  }

  /** 这条 skill 的目录在哪（给「在文件管理器中显示」用）；不存在返回 null。 */
  async locateDir(slug: string): Promise<string | null> {
    const file = await this.locate(assertSlug(slug));
    return file === null ? null : join(file, "..");
  }

  private async locate(slug: string): Promise<string | null> {
    const file = join(this.storeDir, slug, SKILL_FILE);
    return (await exists(file)) ? file : null;
  }

  /** 集合目录名列表（global + 各 workspace）。linksRoot 读不出来 = 一个集合都没有。 */
  private async setDirs(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(this.linksRoot);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    return entries.filter((name) => name !== "." && name !== "..").sort();
  }

  /** 只有 workspace 集合（不含 global）。 */
  private async workspaceSetDirs(): Promise<string[]> {
    return (await this.setDirs()).filter((name) => name !== GLOBAL_SET);
  }

  /**
   * 扫全部集合目录，算出 slug → 集合名的映射。断链（目标文件夹没了）也算归属：
   * 它是 missing 状态的根据，clean 要能找到它们。
   */
  private async scanLinks(): Promise<Map<string, Set<string>>> {
    const memberships = new Map<string, Set<string>>();
    for (const set of await this.setDirs()) {
      let entries: string[];
      try {
        entries = await readdir(join(this.linksRoot, set));
      } catch (error) {
        if (isNotFound(error)) continue;
        throw error;
      }
      for (const slug of entries) {
        if (!isSkillSlug(slug)) continue;
        const sets = memberships.get(slug) ?? new Set<string>();
        sets.add(set);
        memberships.set(slug, sets);
      }
    }
    return memberships;
  }

  /**
   * 扫中心存储。
   *
   * 目录不存在 = 一个都没装，返回空；**其它失败往上抛**（权限、IO）。
   * 这两件事必须分开：把「读不出来」说成「一个都没有」，用户会以为 skill 丢了
   * 而去重装——D-3 修的就是这个形状。
   *
   * 单条读坏则跳过那一条：一份坏 frontmatter 不该让整张列表打不开。
   */
  private async scanStore(): Promise<SkillMeta[]> {
    let entries: string[];
    try {
      entries = await readdir(this.storeDir);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    const metas: SkillMeta[] = [];
    for (const slug of entries) {
      if (!isSkillSlug(slug)) continue;
      const raw = await readFile(join(this.storeDir, slug, SKILL_FILE), "utf8").catch(() => null);
      if (raw === null) continue;
      const parsed = parseSkillMd(raw);
      metas.push({
        slug,
        name: parsed.name ?? slug,
        description: parsed.description ?? "",
        global: false,
        workspaces: [],
        missing: false,
      });
    }
    return metas;
  }

  private async createLink(targetDir: string, linkPath: string): Promise<void> {
    const existing = await lstat(linkPath).catch(() => null);
    if (existing !== null) {
      if (existing.isSymbolicLink()) return; // 已链：幂等
      throw new Error(`目标位置已有实体文件/文件夹，不覆盖：${linkPath}`);
    }
    await mkdir(dirname(linkPath), { recursive: true });
    // 绝对目标：junction（Windows 的目录链接，不要特权）只认绝对路径，
    // POSIX 一条 symlink 通吃——统一绝对路径，两平台一条代码路径
    await symlink(targetDir, linkPath, process.platform === "win32" ? "junction" : undefined);
  }

  /** 删一条链接。没链 = 幂等静默；**同名但不是 symlink 的条目拒绝删**（可能是用户实体）。 */
  private async removeLink(linkPath: string): Promise<void> {
    const info = await lstat(linkPath).catch(() => null);
    if (info === null) return;
    if (!info.isSymbolicLink()) {
      throw new Error(`这个位置不是链接而是实体，拒绝删除：${linkPath}`);
    }
    await unlink(linkPath);
  }
}

/**
 * 集合目录名（workspace id）必须是个单段文件名：它从 renderer 经 IPC 传进来，
 * 直接拼进路径的话，一个 `../` 就能删到 skill-links 之外（同 slug 白名单的理由）。
 */
function assertSetId(id: string): string {
  if (id === "" || id.includes("/") || id.includes("\\") || id.includes("..") || id === "." || id === GLOBAL_SET) {
    throw new Error(`非法集合 id：${id}`);
  }
  return id;
}

function assertSlug(slug: string): string {
  if (!isSkillSlug(slug)) throw new Error(`非法 skill slug：${slug}`);
  return slug;
}

async function exists(path: string): Promise<boolean> {
  return readFile(path)
    .then(() => true)
    .catch(() => false);
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

interface ParsedSkill {
  name: string | null;
  description: string | null;
  body: string;
}

/**
 * 拆开 SKILL.md。**不引 YAML 解析器**：我们只认 `key: value` 的单行标量，
 * 而这正是 skill frontmatter 的实际形状（pi 自己也只读这几个键）。
 * 认不出 frontmatter 就整篇当正文——那多半是用户还没写头。
 */
export function parseSkillMd(raw: string): ParsedSkill {
  const text = stripBom(raw);
  const match = FRONTMATTER.exec(text);
  if (match === null) return { name: null, description: null, body: text };
  return {
    name: readKey(match[1] ?? "", "name"),
    description: readKey(match[1] ?? "", "description"),
    body: match[2] ?? "",
  };
}

/**
 * 改写 SKILL.md，保留 frontmatter 里其它键。
 *
 * 没有 frontmatter 时按需补一个头：否则用户在详情页填的 name / description
 * 会静静地写不进去，而界面还显示保存成功。
 */
export function rebuildSkillMd(raw: string, patch: SkillPatch): string {
  const text = stripBom(raw);
  const match = FRONTMATTER.exec(text);
  const body = patch.body ?? (match === null ? text : match[2] ?? "");
  let block = match?.[1] ?? "";
  if (patch.name !== undefined) block = upsertKey(block, "name", patch.name);
  if (patch.description !== undefined) block = upsertKey(block, "description", patch.description);
  if (block.trim() === "") return body;
  return `---\n${block}\n---\n${body}`;
}

function readKey(block: string, key: string): string | null {
  for (const line of block.split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at === -1) continue;
    if (line.slice(0, at).trim() !== key) continue;
    return unquote(line.slice(at + 1).trim());
  }
  return null;
}

/** 值里的换行会破坏单行标量的 YAML 结构，折叠成空格。 */
function upsertKey(block: string, key: string, value: string): string {
  const inline = value.replace(/\s*\n\s*/g, " ").trim();
  const lines = block === "" ? [] : block.split(/\r?\n/);
  const at = lines.findIndex((line) => {
    const colon = line.indexOf(":");
    return colon !== -1 && line.slice(0, colon).trim() === key;
  });
  const rendered = `${key}: ${needsQuote(inline) ? JSON.stringify(inline) : inline}`;
  if (at === -1) return [...lines, rendered].join("\n");
  lines[at] = rendered;
  return lines.join("\n");
}

/** 会被 YAML 读成别的东西的值要加引号（`: ` 会拆成键值，`#` 起注释，前导符号有语义）。 */
function needsQuote(value: string): boolean {
  return value === "" || /^[-?:,[\]{}#&*!|>'"%@`]/.test(value) || value.includes(": ") || /:$/.test(value);
}

function unquote(value: string): string {
  if (value.length >= 2 && (value.startsWith('"') || value.startsWith("'"))) {
    const quote = value[0] ?? '"';
    if (value.endsWith(quote)) {
      const inner = value.slice(1, -1);
      return quote === '"' ? inner.replace(/\\"/g, '"').replace(/\\\\/g, "\\") : inner;
    }
  }
  return value;
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}
