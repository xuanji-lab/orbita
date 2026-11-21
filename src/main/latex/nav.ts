/**
 * 多文件导航（`latex:nav`）—— 一条包含图 + 每个文件的章节，一次给 renderer。
 *
 * **为什么由主进程算**：跨文件大纲要读「当前文件之外的几十份 .tex」，renderer 没有
 * 那套授权，也不该为了画一个大纲自己读盘；而 `\input` 的路径解析（root 目录 → 包含者
 * 目录 → 项目目录）必须与编译 / 闭包看到的同一份结论，不能另写一套。
 *
 * 分工：
 * - 本模块产出「事实」：`file → includes[]`、反向 `owners[]`、它属于哪些 root、
 *   每个文件的章节（行号与绝对层级）。
 * - **拼接顺序在 renderer**（`latex-outline.ts` 的 `outlineView`）：当前文件的那一段要用
 *   编辑器里的活文本重算（刚敲的标题不该等 4 秒后的轮询），而「包含命令出现在第几行」
 *   与「章节出现在第几行」的合并只有拼的人才看得见全部原料。
 *
 * 不走缓存：一次请求读的是闭包里的几十份小文件（与 `latex:index` 同量级），缓存失效
 * 的代价比读盘高。renderer 按项目 mtime 轮询，见 `useLatexNav`。
 */
import { basename, relative, resolve } from "node:path";
import type { LatexNav, LatexNavFile } from "../../shared/latex.ts";
import { extractSections } from "./index.ts";
import {
  buildIncludeGraph,
  includeKey,
  readSourceText,
  realIncludeDeps,
  type IncludeDeps,
} from "./includes.ts";

export interface LatexNavOptions {
  /** 当前打开的文件（绝对路径）：据此算「它属于哪些 root」与聚合用的 `root` */
  file?: string | null;
}

/** 绝对路径 → 相对项目目录、正斜杠（界面与测试都按这一种形状断言） */
function displayOf(dir: string, path: string): string {
  const rel = relative(dir, path);
  return rel === "" ? basename(path) : rel.replace(/\\/g, "/");
}

/**
 * 项目目录 + 一组 root → 导航载荷。
 *
 * `roots` 是绝对路径（由 `describeLatexProject` 的 `roots[].path` 拼出来）；一个都
 * 不存在 / 一个都没给时返回空图 + `root: null`——调用方据此退回「只看当前文件」的
 * 旧大纲，**不报错**：没有可编译根的 .tex 目录是日常。
 */
export function buildLatexNav(
  projectDir: string,
  roots: readonly string[],
  options: LatexNavOptions = {},
  deps: IncludeDeps = realIncludeDeps,
): LatexNav {
  const dir = resolve(projectDir);
  const graph = buildIncludeGraph(dir, roots, deps);

  const files: LatexNavFile[] = [];
  for (const node of graph.nodes.values()) {
    const text = readSourceText(deps, node.path);
    files.push({
      path: node.path,
      display: displayOf(dir, node.path),
      owners: node.owners,
      roots: node.roots.map((root) => displayOf(dir, root)),
      includes: node.includes,
      sections: text === null ? [] : extractSections(text),
    });
  }

  const focus =
    options.file === null || options.file === undefined
      ? undefined
      : graph.nodes.get(includeKey(options.file));
  const focusRoots = (focus?.roots ?? []).map((root) => displayOf(dir, root));
  const rootPath = focus?.roots[0] ?? null;

  return {
    dir,
    root: rootPath === null ? null : displayOf(dir, rootPath),
    rootPath,
    focusRoots,
    files,
    truncated: graph.truncated,
    limits: graph.limits,
  };
}
