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
import { readFile } from "node:fs/promises";
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
  private cache: Workspace[] | null = null;

  constructor(dir: string) {
    this.filePath = join(dir, "workspaces.json");
    this.legacyPath = join(dir, "workspace.json");
  }

  /**
   * 没有选定工作区时 agent 落在哪儿。**只在这里定义一次**——
   * 渲染层显示给用户的那个「Home」必须是同一个值。
   */
  static defaultPath(): string {
    return homedir();
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
    };
    await this.save([...workspaces, workspace]);
    return workspace;
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
      },
    ];
    await this.save(workspaces);
    return workspaces;
  }
}
