import type { FileEntry, FileEntryKind, FileRoot } from "@shared/files";
// 只要类型：IconName 是纯类型别名，`node --test` 的原生剥离会把整条 import 连同
// 这一行一起删掉，不会真的去加载 Icon.tsx（那份文件带 JSX，Node 的类型剥离不认）。
import type { IconName } from "../../shell/Icon.tsx";

/**
 * 文件面板的**纯视图函数**（排序 / 过滤 / 判定 / footer 文案 / 图标与机器事实格式化）。
 *
 * 独立成模块而不是住进 useFileTree.ts，同主进程 roots.ts / list.ts 与 ipc.ts 分离
 * 的先例：useFileTree.ts 顶层 import api（renderer 的 IPC 入口），而它模块加载时
 * 就摸 `window`——`node --test` 的进程里没有 window，纯函数住那儿就没法直接测。
 */

/**
 * 面板对一层的排序：主进程已按「目录在前、同类按名字」排好，这里只加一条 dotfile
 * 规则——`.` 开头的一律照列（**不做 `.orbita` 这类特殊豁免**：例外名单只会越养
 * 越长），但排在同层最后：它们是机器的文件，不是用户每天找的东西。
 */
export function orderEntries(entries: readonly FileEntry[]): FileEntry[] {
  return [
    ...entries.filter((entry) => !entry.name.startsWith(".")),
    ...entries.filter((entry) => entry.name.startsWith(".")),
  ];
}

/** 本地过滤：只裁剪已加载的条目名，不递归拉取。大小写不敏感；空白词 = 不过滤。 */
export function filterEntries(entries: readonly FileEntry[], query: string): FileEntry[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...entries];
  return entries.filter((entry) => entry.name.toLowerCase().includes(q));
}

/**
 * workspace 根第一层有没有 AGENTS.md。精确名匹配：agent 与所有模板写的都是这个
 * 大小写；「看起来有」的误报比漏报更糟——提示行是「在 Proma 里找不到规则文件」
 * 这个痛点的落点，不能错报。
 */
export function hasAgentsMd(entries: readonly FileEntry[]): boolean {
  return entries.some((entry) => entry.name === "AGENTS.md");
}

/** footer 文案：`N roots`；attached 根在盘上缺席时追 `· N missing`（如实标出，不静默）。 */
export function footerSummary(groupCount: number, missingAttached: number): string {
  const roots = `${groupCount} root${groupCount === 1 ? "" : "s"}`;
  return missingAttached > 0 ? `${roots} · ${missingAttached} missing` : roots;
}

/** 按扩展名归到「代码」形状的图标（file-code-2）。 */
const CODE_EXTS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt", "swift",
  "c", "h", "cc", "cpp", "hpp", "cs", "sh", "bash", "zsh", "fish", "css", "scss", "less",
  "html", "vue", "svelte", "sql", "lua", "php", "r", "dart",
]);

/** 按扩展名归到「配置」形状的图标（file-json-2）。 */
const CONFIG_EXTS = new Set(["json", "jsonc", "json5", "yaml", "yml", "toml", "ini", "xml", "plist", "conf", "cfg", "lock"]);

/** 没有「正常」扩展名、但仍是配置文件的点文件 / 保留名（大小写不敏感）。 */
const CONFIG_DOTFILES = new Set([".gitignore", ".gitattributes", ".editorconfig", ".npmrc", ".nvmrc", ".env"]);
const CONFIG_NAMED_FILES = new Set(["dockerfile", "makefile"]);

/** 按扩展名归到「图片」形状的图标（image）。 */
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "avif", "heic", "tiff"]);

/** 按扩展名归到「文本」形状的图标（file-text）。 */
const TEXT_EXTS = new Set(["md", "mdx", "markdown", "txt", "rst", "log", "csv", "tsv", "adoc", "org"]);

/**
 * 名字里「扩展名」那一段：取最后一个 `.` 之后的部分，小写。开头就是 `.` 的点文件
 * （`.gitignore`）没有「扩展名」这个概念，这里按约定返回空串，交给
 * `isConfigDotfile` 用整段名字另行判断。
 */
function extOf(name: string): string {
  const idx = name.lastIndexOf(".");
  if (idx <= 0) return "";
  return name.slice(idx + 1).toLowerCase();
}

function isConfigDotfile(lowerName: string): boolean {
  return (
    CONFIG_DOTFILES.has(lowerName) || CONFIG_NAMED_FILES.has(lowerName) || lowerName.startsWith(".env.")
  );
}

/**
 * 条目的类型图标——**只分形状、不分颜色**（设计稿「待裁决」章节：彩色图标库不引，
 * 单色 lucide 按扩展名分形状已够扫读）。目录与 AGENTS.md 优先于扩展名判定；
 * symlink 契约里没有目标路径、也不知道目标是文件还是目录，一律给中性的 `file`——
 * 角标另画（TreeRow 里叠加，不在这个函数管）。
 *
 * @param open 目录的展开态；只对 `kind === "directory"` 有意义。
 */
export function fileIcon(name: string, kind: FileEntryKind, open = false): IconName {
  if (kind === "directory") return open ? "folder-open" : "folder";
  if (name === "AGENTS.md") return "book";
  if (kind === "symlink") return "file";
  const lower = name.toLowerCase();
  if (isConfigDotfile(lower)) return "file-json-2";
  const ext = extOf(name);
  if (CODE_EXTS.has(ext)) return "file-code-2";
  if (CONFIG_EXTS.has(ext)) return "file-json-2";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (TEXT_EXTS.has(ext)) return "file-text";
  return "file";
}

/**
 * 字节数 → 人读文案（1024 进制）：`0 B` / `812 B` / `48 KB`（取整）/
 * `1.9 MB`、`2.3 GB`（一位小数，去掉多余的 `.0`）。
 */
export function formatSize(bytes: number): string {
  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;
  if (bytes < KB) return `${bytes} B`;
  if (bytes < MB) return `${Math.round(bytes / KB)} KB`;
  const fixed1 = (value: number): string => {
    const s = value.toFixed(1);
    return s.endsWith(".0") ? s.slice(0, -2) : s;
  };
  if (bytes < GB) return `${fixed1(bytes / MB)} MB`;
  return `${fixed1(bytes / GB)} GB`;
}

/**
 * mtime → 相对「多久以前」的短文案：`now` / `12m` / `1h` / `3d` / `5w` / `8mo` / `2y`。
 * 纯函数，`now` 由调用方传（面板传 `Date.now()`，测试传固定值好控边界）。未来的
 * 时间戳（`modifiedAt > now`，主进程与本机时钟不同步时会发生）与 1 分钟以内一样
 * 显示 `now`——diff 是负数时天然落进 `< 60` 分支，不用单独分支处理。
 */
export function formatAge(modifiedAt: number, now: number): string {
  const diffSec = Math.floor((now - modifiedAt) / 1000);
  if (diffSec < 60) return "now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) return `${diffDay}d`;
  if (diffDay < 60) return `${Math.floor(diffDay / 7)}w`;
  if (diffDay < 365) return `${Math.floor(diffDay / 30)}mo`;
  return `${Math.floor(diffDay / 365)}y`;
}

/** 过滤行右侧的计数文案：不过滤时只报总数，过滤时报「命中 / 总数」。 */
export function filterCountText(shown: number, loaded: number, filtering: boolean): string {
  return filtering ? `${shown} / ${loaded}` : `${loaded}`;
}

/**
 * 过滤计数的分子：跨所有根、**只数当前实际会渲染的行**——父目录没展开，它的
 * 子树哪怕已经缓存过也不算「shown」，与 FilesPanel 的 `rowsOf` 递归同一条规则
 * （不展开就不进 DOM，过滤计数不能比树多算）。
 */
export function countVisibleEntries(
  roots: readonly FileRoot[],
  dirs: ReadonlyMap<string, readonly FileEntry[]>,
  expanded: ReadonlySet<string>,
  query: string,
): number {
  let total = 0;
  const walk = (dir: string): void => {
    const entries = dirs.get(dir);
    if (entries === undefined) return;
    const shown = filterEntries(orderEntries(entries), query);
    total += shown.length;
    for (const entry of shown) {
      if (entry.kind !== "directory") continue;
      const child = `${dir}/${entry.name}`;
      if (expanded.has(child)) walk(child);
    }
  };
  for (const root of roots) {
    if (root.exists) walk(root.path);
  }
  return total;
}

/** 过滤计数的分母：已加载目录里的条目总数（跨全部目录，不管此刻是否仍展开）。 */
export function countLoadedEntries(dirs: ReadonlyMap<string, readonly FileEntry[]>): number {
  let total = 0;
  for (const entries of dirs.values()) total += entries.length;
  return total;
}

/** `dir` 是不是 `ancestor` 本身或其子孙（按路径段判，`/ws/a` 不算 `/ws/ab` 的祖先）。 */
function isWithin(ancestor: string, dir: string): boolean {
  return dir === ancestor || dir.startsWith(`${ancestor}/`);
}

/** 刷新要重拉的一个目录：`root` 是它所属根的路径（`fs:list` 白名单要它）。 */
export interface RefreshTarget {
  root: string;
  dir: string;
}

/**
 * 刷新要重拉哪些目录：每个在盘上的根 + 每个仍落在某个在盘上的根之内的展开目录。
 * **祖先收起的展开目录也拉**——祖先再展开时它直接以展开态出现，得有新数据可画，
 * 而那时没有人会再为它单独触发加载。落不进任何在盘根的展开目录（根被摘 / 挪走）
 * 不拉，交给 mergeRefresh 剪掉。根可能互相嵌套（附加目录挂在工作区里面），按目录去重。
 */
export function refreshTargets(roots: readonly FileRoot[], expanded: ReadonlySet<string>): RefreshTarget[] {
  const live = roots.filter((root) => root.exists);
  const seen = new Set<string>();
  const targets: RefreshTarget[] = [];
  for (const root of live) {
    if (seen.has(root.path)) continue;
    seen.add(root.path);
    targets.push({ root: root.path, dir: root.path });
  }
  for (const dir of expanded) {
    if (seen.has(dir)) continue;
    const owner = live.find((root) => isWithin(root.path, dir));
    if (owner === undefined) continue;
    seen.add(dir);
    targets.push({ root: owner.path, dir });
  }
  return targets;
}

/** 树的可变半边：目录快照缓存 + 展开态。刷新并回时两者一起算，免得一半新一半旧。 */
export interface TreeSnapshot {
  dirs: ReadonlyMap<string, readonly FileEntry[]>;
  expanded: ReadonlySet<string>;
}

/**
 * 把一轮刷新的结果并回树。`current` 取**并回那一刻**的缓存与展开态，不是发起刷新时的：
 * 刷新在途时用户新点开的目录已由懒加载拉好，不能被这里冲掉。
 *
 * - 拉成功（`results` 里是数组）：换成新快照
 * - 拉失败（`null`）的非根目录：多半是被删 / 被挪走（agent 的 `rm -rf`、`mv` 是常态）
 *   ——连同子孙一起丢缓存、剪出展开态；父目录的新快照里它已经不在，面板上自然消失。
 *   根拉失败保留旧快照（读失败 ≠ 空，报错由调用方负责）
 * - 不在任何在盘根之内的（根被摘 / 挪走）：丢缓存、剪展开态
 * - 没在这轮结果里、也没展开的缓存（收起的目录）：丢——下次展开缓存未命中自然重拉；
 *   「收起再展开还是旧列表」就出在这类缓存上
 * - 没在这轮结果里但展开着的（刷新在途时新点开的）：原样保留
 */
export function mergeRefresh(
  current: TreeSnapshot,
  liveRoots: readonly string[],
  results: ReadonlyMap<string, readonly FileEntry[] | null>,
): TreeSnapshot {
  const gone: string[] = [];
  for (const [dir, entries] of results) {
    if (entries === null && !liveRoots.includes(dir)) gone.push(dir);
  }
  const keepPath = (dir: string): boolean =>
    liveRoots.some((root) => isWithin(root, dir)) && !gone.some((g) => isWithin(g, dir));

  const dirs = new Map<string, readonly FileEntry[]>();
  for (const [dir, entries] of current.dirs) {
    if (!keepPath(dir)) continue;
    const fresh = results.get(dir);
    if (fresh !== undefined && fresh !== null) dirs.set(dir, fresh);
    // fresh === null 走到这里只可能是根（非根的失败已在 gone 里）：保留旧快照
    else if (fresh === null || current.expanded.has(dir) || liveRoots.includes(dir)) dirs.set(dir, entries);
  }
  // 之前没有缓存的（工作台首次写入后刚出现的 session 根、祖先收起时失败过的展开目录）
  for (const [dir, entries] of results) {
    if (entries !== null && !dirs.has(dir) && keepPath(dir)) dirs.set(dir, entries);
  }
  const expanded = new Set([...current.expanded].filter(keepPath));
  return { dirs, expanded };
}
