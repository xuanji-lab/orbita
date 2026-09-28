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
import { looksLikeWindowsPath } from "../../shared/path.ts";
import {
  deriveWorkspaceName,
  looksLikePathDerivedName,
  normalizeWorkspaceName,
  parseWorkspace,
  type Workspace,
} from "../../shared/workspace.ts";

/** 落盘格式版本。v3 = 工作区名那一列从「机器从路径铸的」治过一遍（见 healNames） */
const WORKSPACE_FILE_VERSION = 3;

/** 文件里的两块内容：工作区列表 + Home 的附加目录。内存缓存（cache）也是这个形状 */
interface WorkspaceState {
  workspaces: Workspace[];
  homeAttachedDirs: string[];
}

/** migrate 的「真的什么都没有」空态（v1 缺席 / 损坏 / 空路径） */
const EMPTY_STATE: WorkspaceState = { workspaces: [], homeAttachedDirs: [] };

interface WorkspaceFile {
  /**
   * **只抬版本号，字段形状一个没动。**升级前的版本读得懂 v3 文件（它的 read 只校验
   * workspaces 是数组、不认 version），所以这个迁移没有「降级打不开」这条路。
   */
  version: number;
  workspaces: Workspace[];
  /**
   * Home（归属 id 为 null 的会话）挂的附加目录。放顶层而不是造一条 Home 记录进列表：
   * 「列表里没有 Home、null 缺席即 Home」的纪律不动——那条纪律保证 Home 永远兜底、
   * 不可移除，不该被列表的增删逻辑碰。缺席 = 空数组，旧文件不迁移（attach 才落字段）。
   */
  homeAttachedDirs?: string[];
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
  /** 同一份文件里的两块一起读一起缓存；改哪块都整份写回，不会互相踩掉 */
  private cache: WorkspaceState | null = null;

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
    return (await this.load()).workspaces;
  }

  /** 读一次并缓存（list / attachedDirsOf / attach / detach 共用同一个内存态）。旧版本在这里升级一次 */
  private async load(): Promise<WorkspaceState> {
    if (this.cache !== null) return this.cache;
    const read = await this.read();
    this.cache =
      read === null
        ? await this.migrate() // 没有 v2 文件（全新安装 / 只有 v1）：走 v1 迁移
        : read.version >= WORKSPACE_FILE_VERSION
          ? read.state
          : await this.healNames(read.state); // v2 → v3
    return this.cache;
  }

  /**
   * v2 → v3：把「名字是机器从路径铸的」那些记录治一次，**整份写回**（版本抬到 3）。
   *
   * 为什么是一次性迁移而不是每次读都判一遍指纹：指纹要判准就得判全（只认一种形态就会漏掉
   * 另一种，真实老数据两种都有），而「每次读都改一个用户可见字段」本身是隐藏的数据变更——
   * 磁盘永远脏，降级回旧版本又看见旧名字。治完一次，磁盘与内存一致，读路径退回纯解析。
   *
   * **写盘失败不拦启动**（只读挂载 / 磁盘满）：内存态已经治好，本次照常用，下次再试。
   * 与 `read()` 那条「读不懂不能默默覆写」不矛盾——这里写的正是刚读出来的东西。
   */
  private async healNames(state: WorkspaceState): Promise<WorkspaceState> {
    const workspaces = state.workspaces.map((w) =>
      looksLikePathDerivedName(w.name, w.path) ? { ...w, name: deriveWorkspaceName(w.path) } : w,
    );
    try {
      await this.persist(workspaces, state.homeAttachedDirs);
    } catch (cause) {
      console.error(`工作区名迁移（v${WORKSPACE_FILE_VERSION}）写盘失败，本次先用内存态`, cause);
    }
    return { workspaces, homeAttachedDirs: state.homeAttachedDirs };
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
   * 规则：trim + 空白回退）——目录名就是工作区名，**一辈子不动**；之后改名只改列表里
   * 的显示名，不动文件夹。非法名（空、. / ..、像路径或空字节；Windows 上还含 `\`）
   * 当场抛错，不上磁盘。同名文件夹已存在就直接加它：mkdir recursive 不炸、add 同路径
   * 幂等——不覆盖、不报错。
   */
  async create(name: string): Promise<Workspace> {
    const normalized = normalizeWorkspaceName(name, "");
    if (normalized === "") {
      throw new Error(`「${name}」不能用作工作区名字：不能为空`);
    }
    // 守卫查的就是真正当目录名的这份——查截断/规整前的输入会漏（老代码在这吃了亏：
    // 检查的对象和落盘的对象不是同一个字符串）
    assertLegalName(normalized);
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
   * id null = Home——Home 也是一个工作区（2026-09-22 裁决「只是不可移除」），同样能挂。
   * 先 realpath + 确认是目录：挂的瞬间它就得是真的——挂一个不存在的路径只会让
   * 面板多一行 exists=false 的根，用户分不清是打错了还是目录被挪走了。
   * realpath 顺带归一：`/tmp` 链接与它的真身不会攒成两条（去重按归一后的比）。
   * 同一个目录重复挂不报错、不重复。返回更新后的 attachedDirs——Home 在列表里没有
   * 记录，给不了 Workspace，两个归属就都返回清单（renderer 拿它刷新，不需要整条记录）。
   */
  async attachDir(id: string | null, dir: string): Promise<string[]> {
    let resolved: string;
    try {
      resolved = await realpath(dir);
    } catch {
      throw new Error(`附加目录不存在：${dir}`);
    }
    if (!(await stat(resolved)).isDirectory()) {
      throw new Error(`附加目录不是文件夹：${dir}`);
    }
    const { workspaces, homeAttachedDirs } = await this.load();
    if (id === null) {
      if (homeAttachedDirs.includes(resolved)) return homeAttachedDirs;
      const next = [...homeAttachedDirs, resolved];
      await this.persist(workspaces, next);
      return next;
    }
    const target = workspaces.find((w) => w.id === id);
    if (target === undefined) throw new Error(`工作区不存在：${id}`);
    if (target.attachedDirs.includes(resolved)) return target.attachedDirs;
    const next = [...target.attachedDirs, resolved];
    await this.persist(
      workspaces.map((w) => (w.id === id ? { ...w, attachedDirs: next } : w)),
      homeAttachedDirs,
    );
    return next;
  }

  /**
   * 摘掉一个附加目录。**不在列表里不报错**（幂等）：面板上那条根可能来自旧快照，
   * 摘第二次不该炸。id null = Home（同 attachDir）。返回更新后的 attachedDirs。
   */
  async detachDir(id: string | null, dir: string): Promise<string[]> {
    const { workspaces, homeAttachedDirs } = await this.load();
    if (id === null) {
      const next = homeAttachedDirs.filter((d) => d !== dir);
      await this.persist(workspaces, next);
      return next;
    }
    const target = workspaces.find((w) => w.id === id);
    if (target === undefined) throw new Error(`工作区不存在：${id}`);
    const next = target.attachedDirs.filter((d) => d !== dir);
    await this.persist(
      workspaces.map((w) => (w.id === id ? { ...w, attachedDirs: next } : w)),
      homeAttachedDirs,
    );
    return next;
  }

  /**
   * 某个归属当前的附加目录清单（根清单与开轮目录清单共同的数据入口，别再各自 find）：
   * id null → Home 的顶层清单；工作区不存在（meta 指着已删的 id）→ []——会话落到
   * TASKS 是既有语义，不该带着已经无处归属的附加目录。
   */
  async attachedDirsOf(id: string | null): Promise<string[]> {
    const { workspaces, homeAttachedDirs } = await this.load();
    if (id === null) return homeAttachedDirs;
    return workspaces.find((w) => w.id === id)?.attachedDirs ?? [];
  }

  /**
   * 改显示名（不动磁盘上的文件夹）。显示名是**自由文本**（wafo 裁决）：含 `/` 的
   * `PhD/Year1`、Mac 的 `a\b` 都合法——显示层原样显示，不再截尾，所以也不需要守卫。
   * 空白名退回路径末段是既有裁决；不存在的 id 静默无操作（既有语义）。
   */
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

  /** 存列表：Home 的附加目录不在这张列表里，照抄当前缓存（migrate 时缓存为空 → 空） */
  private async save(workspaces: Workspace[]): Promise<void> {
    const homeAttachedDirs = this.cache?.homeAttachedDirs ?? [];
    await this.persist(workspaces, homeAttachedDirs);
  }

  /** 整份写回（原子写）。Home 清单为空就不落字段：没用过 Home 挂目录的文件保持原有形状 */
  private async persist(workspaces: Workspace[], homeAttachedDirs: string[]): Promise<void> {
    const payload: WorkspaceFile = {
      version: WORKSPACE_FILE_VERSION,
      workspaces,
      ...(homeAttachedDirs.length > 0 ? { homeAttachedDirs } : {}),
    };
    await writeJsonAtomic(this.filePath, payload);
    this.cache = { workspaces, homeAttachedDirs };
  }

  /**
   * 读文件。`null` = 没有这份文件（该去试 v1 迁移），**不是「读失败」**。
   *
   * 读不出来必须抛。这里不只是显示对不对的问题：把一份读坏的文件当成「空列表」交出去，
   * 用户下一次 add 就会踩着 `save()` 把它**整个覆盖写掉**——
   * 本来只是文件损坏（还能手工救），变成真的没了。**读不懂的东西不能默默覆写。**
   *
   * 所以 `null` 只有一个来源：文件不存在。JSON 坏了、形状不对（没有 workspaces 数组）
   * 都是「读不懂」，一律抛。**version 不在此列**：它只决定要不要跑一次数据迁移
   * （见 load），认不出来（字段缺了、被人手改）就当最老的算——迁移是幂等的，多跑一次
   * 没有代价；反过来把高版本当读不懂拦下来，才是真的把用户挡在门外。
   */
  private async read(): Promise<{ state: WorkspaceState; version: number } | null> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (cause) {
      if (isNotFound(cause)) return null; // 还没写过：去走迁移
      throw cause; // 权限 / IO 坏了
    }
    const parsed = JSON.parse(raw) as {
      version?: unknown;
      workspaces?: unknown;
      homeAttachedDirs?: unknown;
    };
    if (!Array.isArray(parsed.workspaces)) {
      throw new Error(`workspaces.json 读不懂：没有 workspaces 数组（${this.filePath}）`);
    }
    return {
      // 坏掉的一条跳过，不让它挡住整张列表
      state: {
        workspaces: parsed.workspaces.map(parseWorkspace).filter((w): w is Workspace => w !== null),
        homeAttachedDirs: parseHomeAttachedDirs(parsed.homeAttachedDirs),
      },
      version: typeof parsed.version === "number" ? parsed.version : 0,
    };
  }

  /**
   * 从 v1 迁移：那时只有一个工作区、存的是路径。给它铸一个 id、取路径末段当名字。
   *
   * **不删旧文件。** 迁移当场就重写不回去了，留着那份 v1 是唯一能回头看的东西；
   * 它以后没人读，代价只是几十字节。
   */
  private async migrate(): Promise<WorkspaceState> {
    let raw: string;
    try {
      raw = await readFile(this.legacyPath, "utf8");
    } catch (cause) {
      if (isNotFound(cause)) return EMPTY_STATE; // 全新安装：真的一个工作区都没有
      throw cause; // 权限 / IO 坏了
    }
    let legacy: LegacyWorkspaceFile;
    try {
      legacy = JSON.parse(raw) as LegacyWorkspaceFile;
    } catch {
      return EMPTY_STATE; // v1 文件损坏：它只是个迁移来源，不该拦住全新开始
    }
    if (typeof legacy.current !== "string" || legacy.current === "") return EMPTY_STATE;
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
    return { workspaces, homeAttachedDirs: [] };
  }
}

/** Windows 保留的设备名（不分大小写，带扩展名也算：`CON.txt` 同样是设备） */
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/**
 * **create 的目录名守卫**（只管 create：那里名字会真的变成磁盘上的一个目录）。
 *
 * 为什么要拒在门口：`mkdir` 的报错是原始 errno（`阶段一: 重构` →
 * `ENOENT: ... mkdir '…\阶段一: 重构'`），用户看不懂；而比报错更坏的是**不报错但建出来的
 * 不是那个名字**——Windows 保留名（CON / NUL / COM1）与以 `.` 结尾的名字都能建出来，
 * 但资源管理器按 Win32 语义解析同一个字符串会落到另一个目录上（实测：
 * `Test-Path '…\proj.'` 为真、解析到 `…\proj`）。create 的契约是「一个用户能在
 * 资源管理器里打开的文件夹」，建一个他打不开的东西不算兑现。
 *
 * `/`、`.` / `..`、空字节、盘符 / UNC 起头在任何 OS 都拒——那是「名字被当成路径」
 * 这一个病。`\`、`<>:"|?*`、结尾的 `.`、保留名**只在 Windows 拒**：POSIX 里它们都是
 * 文件名的合法字符（Mac / Linux 上 `a\b` 是正常的目录名），一刀切会拒掉 Mac 用户正常
 * 起的名（2026-09-28 那一轮踩过）。
 *
 * rename 不走这个守卫：显示名是自由文本，不落到磁盘上。
 * platform 可注入是为了测试能把三个 OS 都验到。
 */
export function assertLegalName(name: string, platform: NodeJS.Platform = process.platform): void {
  const reason = illegalNameReason(name, platform);
  if (reason !== null) throw new Error(`「${name}」不能用作工作区名字：${reason}`);
}

/** 名字不能当目录名的理由（null = 可以）。抽出来是为了报错说人话，也让测试能断言具体哪一条 */
function illegalNameReason(name: string, platform: NodeJS.Platform): string | null {
  if (name === "") return "不能为空";
  if (name === "." || name === "..") return "不能是 . 或 ..";
  if (name.includes("/")) return "不能含 /（会建出嵌套目录）";
  if (name.includes("\0")) return "不能含空字节";
  if (looksLikeWindowsPath(name)) return "不能像路径（盘符起头或反斜杠起头）";
  if (platform !== "win32") return null;
  if (name.includes("\\")) return "Windows 上不能含 \\（会建出嵌套目录）";
  const invalid = /[<>:"|?*]/.exec(name);
  if (invalid !== null) return `Windows 上不能含 ${invalid[0]}`;
  if (/[\u0001-\u001f]/.test(name)) return "不能含控制字符";
  if (/[. ]$/.test(name)) return "不能以 . 或空格结尾（Windows 会把它吃掉，建出来的目录与名字对不上）";
  if (WINDOWS_RESERVED_NAME.test(name)) return "不能是 Windows 保留的设备名（CON / NUL / COM1 这类）";
  return null;
}

/**
 * 顶层 homeAttachedDirs 的解析：与 shared/workspace.ts 的 parseAttachedDirs 同一套规则
 * （那个函数没导出，这里照抄一份）——不是数组当空、非空字符串才算一条、重复只留第一条。
 */
function parseHomeAttachedDirs(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const dirs: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || item === "" || dirs.includes(item)) continue;
    dirs.push(item);
  }
  return dirs;
}
