/**
 * 工作区 —— agent 能看到的那些文件夹。
 *
 * 为什么必须显式：`cwd` 之前写死 `"."`，在打包后的应用里指向哪儿是不确定的，
 * 而工具（read / write / bash）全都相对它工作。**用户必须一眼看得见 agent 能碰哪里。**
 *
 * 一个可移植 JSON 装全部工作区，原子写。会话不存在这里——会话按 **workspace id**
 * 记在自己的 meta 里（`src/shared/workspace.ts` 讲了为什么不按路径）。
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeJsonAtomic } from "../atomic-write.ts";
import { isNotFound } from "../fs-errors.ts";
import {
  deriveWorkspaceName,
  normalizeWorkspaceName,
  parseWorkspace,
  type Workspace,
} from "../../shared/workspace.ts";

interface WorkspaceFile {
  version: 2;
  workspaces: Workspace[];
}

/** v1 的形状：只有一个工作区，存的是路径。 */
interface LegacyWorkspaceFile {
  version: 1;
  current: string;
}

export class WorkspaceStore {
  private readonly filePath: string;
  private readonly legacyPath: string;
  /** Orbita 全部工作区文件夹的根（Home 也在它下面）。注入点：测试给临时目录，生产是 ~/Orbita */
  private readonly rootDir: string;
  private cache: Workspace[] | null = null;

  constructor(dir: string, orbitaRoot?: string) {
    this.filePath = join(dir, "workspaces.json");
    this.legacyPath = join(dir, "workspace.json");
    this.rootDir = orbitaRoot ?? join(homedir(), "Orbita");
  }

  /** ~/Orbita：Orbita 建的每个工作区文件夹（含 Home）都在它下面，Finder 打开就是全部地盘 */
  orbitaRoot(): string {
    return this.rootDir;
  }

  /**
   * 没有选定工作区时 agent 落在哪儿。**只在这里定义一次**——
   * 渲染层显示给用户的那个「Home」必须是同一个值。
   *
   * 不再是 homedir 本身（2026-09-22 裁决）：那会让 agent 的文件直接散在 ~ 里，
   * 用户自己的家目录变成杂物堆。Home 与命名工作区一样，是 ~/Orbita 下的一个
   * 普通文件夹——同一个根，没有第二种工作区。
   */
  defaultPath(): string {
    return join(this.orbitaRoot(), "Home");
  }

  /**
   * 启动时把 Home 建出来（skills.ensureDirs 的同款先例：空目录就是说明书）。
   * 用户第一次打开 ~/Orbita 时它就该存在，而不是等 agent 第一次写文件才隐式出现。
   */
  async ensureHome(): Promise<void> {
    await mkdir(this.defaultPath(), { recursive: true });
  }

  async list(): Promise<Workspace[]> {
    if (this.cache !== null) return this.cache;
    this.cache = (await this.read()) ?? (await this.migrate());
    return this.cache;
  }

  /** 加一个文件夹。**同一个路径只会有一条**——重复加返回已有的那条。 */
  async add(path: string): Promise<Workspace> {
    const workspaces = await this.list();
    const existing = workspaces.find((w) => w.path === path);
    if (existing !== undefined) return existing;
    const workspace: Workspace = {
      id: randomUUID(),
      name: deriveWorkspaceName(path),
      path,
      createdAt: Date.now(),
      attachedDirs: [],
    };
    await this.save([...workspaces, workspace]);
    return workspace;
  }

  /**
   * 命名新建（2026-09-22 裁决：一个工作区就是一个用户能在 Finder 里打开的文件夹）：
   * 在 ~/Orbita/<name>/ 建文件夹并加为工作区。名字先过 normalize（与 rename 同一套
   * 规则：trim + 40 上限）——目录名就是工作区名，**一辈子不动**；之后改名只改列表里
   * 的显示名，不动文件夹。非法名（空、. / ..、含 / 或空字节）当场抛错，不上磁盘。
   * 同名文件夹已存在就直接加它：mkdir recursive 不炸、add 同路径幂等——不覆盖、不报错。
   */
  async create(name: string): Promise<Workspace> {
    const normalized = normalizeWorkspaceName(name, "");
    if (
      normalized === "" ||
      normalized === "." ||
      normalized === ".." ||
      normalized.includes("/") ||
      normalized.includes("\0")
    ) {
      throw new Error(
        `「${name}」不能用作工作区名字：不能为空，不能是 . 或 ..，也不能含 / 或空字节`,
      );
    }
    const path = join(this.orbitaRoot(), normalized);
    await mkdir(path, { recursive: true });
    // add 的默认名取路径末段，而这里的目录名就是 normalize 后的名字——恰好是用户给的
    return this.add(path);
  }

  /**
   * 导入落盘：扫描期铸好的 id 与名字，按它落（Proma pi 同构导入，importer.ts）。
   * 同路径已存在（扫描与执行之间用户手动加了）→ 并入已有，返回已有的那条。
   */
  async addImported(workspace: { id: string; name: string; path: string }): Promise<Workspace> {
    const workspaces = await this.list();
    const existing = workspaces.find((w) => w.path === workspace.path);
    if (existing !== undefined) return existing;
    const next: Workspace = {
      id: workspace.id,
      name: normalizeWorkspaceName(workspace.name, workspace.path),
      path: workspace.path,
      createdAt: Date.now(),
      attachedDirs: [],
    };
    await this.save([...workspaces, next]);
    return next;
  }

  /**
   * 挂一个附加目录（文件面板的根清单与开轮目录清单共同的数据源）。
   * 先 realpath + 确认是目录：挂的瞬间它就得是真的——挂一个不存在的路径只会让
   * 面板多一行 exists=false 的根，用户分不清是打错了还是目录被挪走了。
   * realpath 顺带归一：`/tmp` 链接与它的真身不会攒成两条（去重按归一后的比）。
   * 同一个目录重复挂不报错、不重复，返回更新后的工作区。
   */
  async attachDir(id: string, dir: string): Promise<Workspace> {
    let resolved: string;
    try {
      resolved = await realpath(dir);
    } catch {
      throw new Error(`附加目录不存在：${dir}`);
    }
    if (!(await stat(resolved)).isDirectory()) {
      throw new Error(`附加目录不是文件夹：${dir}`);
    }
    const workspaces = await this.list();
    const target = workspaces.find((w) => w.id === id);
    if (target === undefined) throw new Error(`工作区不存在：${id}`);
    if (target.attachedDirs.includes(resolved)) return target;
    const updated: Workspace = { ...target, attachedDirs: [...target.attachedDirs, resolved] };
    await this.save(workspaces.map((w) => (w.id === id ? updated : w)));
    return updated;
  }

  /**
   * 摘掉一个附加目录。**不在列表里不报错**（幂等）：面板上那条根可能来自旧快照，
   * 摘第二次不该炸。返回更新后的工作区。
   */
  async detachDir(id: string, dir: string): Promise<Workspace> {
    const workspaces = await this.list();
    const target = workspaces.find((w) => w.id === id);
    if (target === undefined) throw new Error(`工作区不存在：${id}`);
    const updated: Workspace = { ...target, attachedDirs: target.attachedDirs.filter((d) => d !== dir) };
    await this.save(workspaces.map((w) => (w.id === id ? updated : w)));
    return updated;
  }

  async rename(id: string, name: string): Promise<void> {
    const workspaces = await this.list();
    await this.save(
      workspaces.map((w) => (w.id === id ? { ...w, name: normalizeWorkspaceName(name, w.path) } : w)),
    );
  }

  /**
   * 移除一个工作区。**只是把它从列表里拿掉，不动磁盘上的文件夹，也不删它的会话**——
   * 那些会话的 `workspaceId` 会指向一个不存在的 id，届时落到 TASKS 下。
   * 「移出列表」和「删掉记录」是两件事，别让一次点击同时干两件。
   */
  async remove(id: string): Promise<void> {
    const workspaces = await this.list();
    await this.save(workspaces.filter((w) => w.id !== id));
  }

  private async save(workspaces: Workspace[]): Promise<void> {
    const payload: WorkspaceFile = { version: 2, workspaces };
    await writeJsonAtomic(this.filePath, payload);
    this.cache = workspaces;
  }

  /**
   * 读 v2 文件。`null` = 没有这份文件（该去试 v1 迁移），**不是「读失败」**。
   *
   * 读不出来必须抛。这里不只是显示对不对的问题：把一份读坏的文件当成「空列表」交出去，
   * 用户下一次 add 就会踩着 `save()` 把它**整个覆盖写掉**——
   * 本来只是文件损坏（还能手工救），变成真的没了。**读不懂的东西不能默默覆写。**
   *
   * 所以 `null` 只有一个来源：文件不存在。JSON 坏了、结构不对（比如未来的 v3 格式）
   * 都是「读不懂」，一律抛。
   */
  private async read(): Promise<Workspace[] | null> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (cause) {
      if (isNotFound(cause)) return null; // 还没写过 v2：去走迁移
      throw cause; // 权限 / IO 坏了
    }
    const parsed = JSON.parse(raw) as { workspaces?: unknown };
    if (!Array.isArray(parsed.workspaces)) {
      throw new Error(`workspaces.json 读不懂：没有 workspaces 数组（${this.filePath}）`);
    }
    // 坏掉的一条跳过，不让它挡住整张列表
    return parsed.workspaces
      .map(parseWorkspace)
      .filter((w): w is Workspace => w !== null);
  }

  /**
   * 从 v1 迁移：那时只有一个工作区、存的是路径。给它铸一个 id、取路径末段当名字。
   *
   * **不删旧文件。** 迁移当场就重写不回去了，留着那份 v1 是唯一能回头看的东西；
   * 它以后没人读，代价只是几十字节。
   */
  private async migrate(): Promise<Workspace[]> {
    let raw: string;
    try {
      raw = await readFile(this.legacyPath, "utf8");
    } catch (cause) {
      if (isNotFound(cause)) return []; // 全新安装：真的一个工作区都没有
      throw cause; // 权限 / IO 坏了
    }
    let legacy: LegacyWorkspaceFile;
    try {
      legacy = JSON.parse(raw) as LegacyWorkspaceFile;
    } catch {
      return []; // v1 文件损坏：它只是个迁移来源，不该拦住全新开始
    }
    if (typeof legacy.current !== "string" || legacy.current === "") return [];
    const workspaces: Workspace[] = [
      {
        id: randomUUID(),
        name: deriveWorkspaceName(legacy.current),
        path: legacy.current,
        createdAt: Date.now(),
        attachedDirs: [],
      },
    ];
    await this.save(workspaces);
    return workspaces;
  }
}
