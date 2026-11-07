/**
 * OFM 链接 / 图片的目标解析（纯函数）：给一份工作区文件清单（相对工作区根的 `/` 路径），
 * 找 `[[双链]]`、`![[图.png]]`、`![](相对路径)` 指到哪个文件。
 *
 * 查找顺序（Obsidian 同口径）：
 * 1. 带目录的写法（`文件夹/名字`）按路径后缀匹配；`../` 相对写法先按当前文档所在目录解析；
 * 2. 不带目录：按文件名匹配——**同目录优先**，其次路径最浅的，再按字典序；
 * 3. 双链不写扩展名 = `.md`（也认 `.markdown` / `.txt`）；写了扩展名就要完全一致；
 * 4. 大小写不敏感。
 * 路径不许越出工作区根（`../../etc/passwd` 解析后越界一律 null）。
 */

/** 去掉 `./`、折叠 `a/../b`；越出根（`..` 多于已有层级）返回 null */
export function normalizeRel(path: string): string | null {
  const out: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(part);
  }
  return out.join("/");
}

function dirOf(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i === -1 ? "" : rel.slice(0, i);
}

function baseOf(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i === -1 ? rel : rel.slice(i + 1);
}

const DOC_EXT_ORDER = [".md", ".markdown", ".txt"] as const;

export type ResolveKind = "link" | "image";

/**
 * @param files 工作区内的文件（相对根，`/` 分隔）
 * @param fromDoc 当前文档（相对根）
 * @param target 目标写法（不含 `#小节` 与 `|别名`）
 * @returns 命中的文件（相对根）；没有 = null
 */
export function resolveOfmTarget(
  files: readonly string[],
  fromDoc: string,
  target: string,
  kind: ResolveKind,
): string | null {
  let raw = target.trim();
  if (raw === "" || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("/")) return null;
  try {
    raw = decodeURIComponent(raw);
  } catch {
    // 不是合法的百分号编码：按字面
  }
  const fromDir = dirOf(fromDoc);
  const lower = new Map<string, string[]>();
  for (const file of files) {
    const key = file.toLowerCase();
    const list = lower.get(key) ?? [];
    list.push(file);
    lower.set(key, list);
  }
  const exact = (rel: string | null): string | null => {
    if (rel === null) return null;
    const hit = lower.get(rel.toLowerCase());
    return hit === undefined ? null : (hit[0] as string);
  };
  const hasExt = /\.[A-Za-z0-9]{1,8}$/.test(baseOf(raw));
  const names = kind === "link" && !hasExt ? DOC_EXT_ORDER.map((ext) => raw + ext) : [raw];

  // 1) 显式相对 / 带目录：先按当前目录，再按根
  for (const name of names) {
    if (name.startsWith("./") || name.startsWith("../")) {
      const hit = exact(normalizeRel(fromDir === "" ? name : `${fromDir}/${name}`));
      if (hit !== null) return hit;
      continue;
    }
    const sameDir = exact(normalizeRel(fromDir === "" ? name : `${fromDir}/${name}`));
    if (sameDir !== null) return sameDir;
    const fromRoot = exact(normalizeRel(name));
    if (fromRoot !== null) return fromRoot;
  }
  if (raw.startsWith("./") || raw.startsWith("../")) {
    // 相对写法找不到：退回按文件名找（Obsidian 不这样，但图片挪了目录时这样更宽容；仍限于工作区内）
    raw = baseOf(raw);
  }

  // 2) 路径后缀 / 文件名匹配
  for (const name of kind === "link" && !hasExt ? DOC_EXT_ORDER.map((ext) => raw + ext) : [raw]) {
    const suffix = `/${name.toLowerCase()}`;
    const candidates = files.filter((file) => {
      const f = file.toLowerCase();
      return f === name.toLowerCase() || f.endsWith(suffix);
    });
    if (candidates.length === 0) continue;
    candidates.sort((a, b) => {
      const aSame = dirOf(a) === fromDir ? 0 : 1;
      const bSame = dirOf(b) === fromDir ? 0 : 1;
      if (aSame !== bSame) return aSame - bSame;
      const depth = a.split("/").length - b.split("/").length;
      return depth !== 0 ? depth : a.localeCompare(b);
    });
    return candidates[0] as string;
  }
  return null;
}
