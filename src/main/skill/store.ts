/**
 * Skills 落盘 —— 两个目录，一个 skill 一个文件夹：
 *
 *   skills/<slug>/SKILL.md            启用
 *   skills-inactive/<slug>/SKILL.md   停用
 *
 * **启停就是在两个目录之间 rename。** 不写开关位、不维护启用清单——磁盘布局就是
 * 全部状态，不会出现「清单说启用了但文件早删了」这种两份真相对不上的情况。
 */
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isNotFound } from "../fs-errors.ts";
import { isSkillSlug, type SkillContent, type SkillMeta, type SkillPatch } from "../../shared/skill.ts";

/** 启用中的 skills。pi 只看这一个目录。 */
export const SKILLS_DIR = "skills";
/** 停用的 skills。仅供存放，不交给 pi。 */
export const SKILLS_INACTIVE_DIR = "skills-inactive";

const SKILL_FILE = "SKILL.md";

export class SkillStore {
  private readonly activeDir: string;
  private readonly inactiveDir: string;

  constructor(configDir: string) {
    this.activeDir = join(configDir, SKILLS_DIR);
    this.inactiveDir = join(configDir, SKILLS_INACTIVE_DIR);
  }

  /** 启用中的那个目录——主进程要把它交给 agent 进程（`AgentCommand.skillsDir`）。 */
  enabledDir(): string {
    return this.activeDir;
  }

  /** 两个目录都建出来。空目录并排摆着就是「怎么启停」的说明书。 */
  async ensureDirs(): Promise<void> {
    await mkdir(this.activeDir, { recursive: true });
    await mkdir(this.inactiveDir, { recursive: true });
  }

  /**
   * 两个目录一起列。
   *
   * **按 slug 排序，不用 readdir 的顺序。** 这不是为了好看：skill 的索引进 system
   * prompt，而 prompt 是 provider 端缓存的第一个断点。顺序一抖，内容明明没变，
   * 整条 prefix 缓存也会作废——pi 自己不排序（它按 readdir 返回，实测是创建顺序），
   * 所以这道保险得我们来上。
   */
  async list(): Promise<SkillMeta[]> {
    const [active, inactive] = await Promise.all([
      this.scan(this.activeDir, true),
      this.scan(this.inactiveDir, false),
    ]);
    return [...active, ...inactive].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  }

  /**
   * 启用 / 停用一条：在两个目录之间搬。
   *
   * 目标已存在就拒绝，**不覆盖**——两个目录里有同名 skill 时，一次 rename 会
   * 悄悄吃掉一份用户文件。宁可报错让用户自己处理。
   */
  async setEnabled(slug: string, enabled: boolean): Promise<void> {
    const from = join(enabled ? this.inactiveDir : this.activeDir, assertSlug(slug));
    const to = join(enabled ? this.activeDir : this.inactiveDir, slug);
    if (await exists(join(to, SKILL_FILE))) {
      throw new Error(`目标目录已存在同名 skill：${slug}`);
    }
    await mkdir(enabled ? this.activeDir : this.inactiveDir, { recursive: true });
    await rename(from, to);
  }

  /** 读详情。不存在返回 null（用户可能刚在访达里删掉了它）。 */
  async read(slug: string): Promise<SkillContent | null> {
    const found = await this.locate(assertSlug(slug));
    if (found === null) return null;
    const raw = await readFile(found, "utf8");
    const parsed = parseSkillMd(raw);
    return { name: parsed.name ?? slug, description: parsed.description ?? "", body: parsed.body };
  }

  /**
   * 改详情。**只替换指定字段**，frontmatter 里其它键原样保留——
   * 用户手写的 `disable-model-invocation`、`allowed-tools` 之类不该因为我们
   * 不认识就被吃掉。
   */
  async write(slug: string, patch: SkillPatch): Promise<void> {
    const found = await this.locate(assertSlug(slug));
    if (found === null) throw new Error(`skill 不存在：${slug}`);
    const raw = await readFile(found, "utf8");
    await writeFile(found, rebuildSkillMd(raw, patch), "utf8");
  }

  /** 这条 skill 的目录在哪（给「在文件管理器中显示」用）；不存在返回 null。 */
  async locateDir(slug: string): Promise<string | null> {
    const file = await this.locate(assertSlug(slug));
    return file === null ? null : join(file, "..");
  }

  private async locate(slug: string): Promise<string | null> {
    for (const dir of [this.activeDir, this.inactiveDir]) {
      const file = join(dir, slug, SKILL_FILE);
      if (await exists(file)) return file;
    }
    return null;
  }

  /**
   * 扫一个目录。
   *
   * 目录不存在 = 一个都没装，返回空；**其它失败往上抛**（权限、IO）。
   * 这两件事必须分开：把「读不出来」说成「一个都没有」，用户会以为 skill 丢了
   * 而去重装——D-3 修的就是这个形状，Proma 的 scanSkillsInDir 到今天还在犯。
   *
   * 单条读坏则跳过那一条：一份坏 frontmatter 不该让整张列表打不开。
   */
  private async scan(dir: string, enabled: boolean): Promise<SkillMeta[]> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    const metas: SkillMeta[] = [];
    for (const slug of entries) {
      if (!isSkillSlug(slug)) continue;
      const raw = await readFile(join(dir, slug, SKILL_FILE), "utf8").catch(() => null);
      if (raw === null) continue;
      const parsed = parseSkillMd(raw);
      metas.push({
        slug,
        name: parsed.name ?? slug,
        description: parsed.description ?? "",
        enabled,
      });
    }
    return metas;
  }
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
