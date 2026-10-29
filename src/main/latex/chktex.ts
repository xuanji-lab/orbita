/**
 * ChkTeX 行内检查（`latex:lint`）—— **探测到才启用**，没有就当这个功能不存在。
 *
 * 为什么不在共享契约里再加一堆配置项：chktex 是 TeX Live / MiKTeX 的可选组件，
 * 装了的人希望它在编辑器里给波浪线，没装的人不该看到任何「缺少工具」的提示。所以
 * 探测结果只有 `available: true/false` 两态，界面在 false 时完全不出现这条通道的任何痕迹。
 *
 * 与编译问题共用一份 `LatexIssue` 形状（file / line / message / kind）：渲染层的
 * 行内标记映射（latex-diagnostics.ts）不需要知道这条是编译来的还是 chktex 来的。
 *
 * 输出格式固定为 `-f%f:%l:%c:%d:%k:%n:%m\n`（与 LaTeX-Workshop 一致）：
 *   `file:line:col:length:Warning|Error:code:message`
 * 列号不做字节 / Tab 换算（那是 chktex 的已知坑，而我们只画到行）；长度也不用。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { LatexIssue } from "../../shared/latex.ts";

/** 一次 chktex 的墙钟上限：正常文件几十毫秒，15 秒还没完就是卡住了 */
const CHKTEX_TIMEOUT_MS = 15_000;

/** 探测命令的超时：`--version` 只打印两行 */
const PROBE_TIMEOUT_MS = 5000;

/** 输出格式（`\n` 由 chktex 自己解释成换行） */
const CHKTEX_FORMAT = "-f%f:%l:%c:%d:%k:%n:%m\n";

/** 探测缓存：同一个 latexmk（= 同一个 TeX 树）只探一次；`null` 也缓存（没装别反复起进程） */
const probed = new Map<string, string | null>();

/** 在 latexmk 同目录找 chktex，否则交给 PATH */
function candidates(latexmk: string | null): string[] {
  const out: string[] = [];
  if (latexmk !== null && (latexmk.includes("/") || latexmk.includes("\\"))) {
    const dir = dirname(latexmk);
    for (const name of ["chktex.exe", "chktex"]) out.push(join(dir, name));
  }
  out.push("chktex");
  return out;
}

/** 起一次子进程，返回 stdout / 是否超时。**不抛**：探测失败就是「没有」 */
function run(binary: string, args: string[], timeoutMs: number): Promise<{ stdout: string; timedOut: boolean; failed: boolean }> {
  return new Promise((done) => {
    let stdout = "";
    let timedOut = false;
    let settled = false;
    const child = spawn(binary, args, { windowsHide: true });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < 512 * 1024) stdout += chunk.toString("utf8");
    });
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done({ stdout, timedOut, failed: true });
    });
    child.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done({ stdout, timedOut, failed: false });
    });
  });
}

/** 本机有没有 chktex（按 latexmk 的目录 + PATH）；没有时 null，且只探一次 */
export async function probeChktex(latexmk: string | null): Promise<string | null> {
  const key = latexmk ?? "";
  const cached = probed.get(key);
  if (cached !== undefined) return cached;
  for (const binary of candidates(latexmk)) {
    if (binary !== "chktex" && !existsSync(binary)) continue;
    const result = await run(binary, ["--version"], PROBE_TIMEOUT_MS);
    if (!result.failed && !result.timedOut && /chktex/i.test(result.stdout)) {
      probed.set(key, binary);
      return binary;
    }
  }
  probed.set(key, null);
  return null;
}

/** 日志里的文件名 → 相对项目目录、正斜杠（与 LatexIssue.file 同一口径） */
function toProjectRelative(projectDir: string, file: string): string {
  const trimmed = file.trim().replace(/^\.\//, "");
  const absolute = isAbsolute(trimmed) ? resolve(trimmed) : resolve(projectDir, trimmed);
  const rel = relative(resolve(projectDir), absolute);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    // 项目外（chktex 可能把 `-l` 的路径写进来）：如实给绝对路径，界面按「不在本文件」忽略
    return absolute.split(sep).join("/");
  }
  return rel.split(sep).join("/");
}

/** chktex 的输出 → 结构化问题（纯函数，`node --test` 覆盖） */
export function parseChktexOutput(stdout: string, projectDir: string): LatexIssue[] {
  const pattern = /^(.*?):(\d+):(\d+):(\d+):([^:]*):(\d+):(.*)$/gm;
  const issues: LatexIssue[] = [];
  const seen = new Set<string>();
  for (const match of stdout.matchAll(pattern)) {
    const file = toProjectRelative(projectDir, match[1] ?? "");
    const line = Number.parseInt(match[2] ?? "", 10);
    if (!Number.isFinite(line) || line < 1) continue;
    const severity = (match[5] ?? "").trim().toLowerCase();
    const code = match[6] ?? "";
    const text = (match[7] ?? "").trim();
    if (text === "") continue;
    const key = `${file}:${line}:${code}:${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push({
      file,
      line,
      kind: severity === "error" ? "error" : "warning",
      message: `chktex ${code}: ${text}`,
    });
  }
  return issues;
}

/**
 * 对一个文件跑一次 chktex。**只接受 .tex**：对 .bib / .sty 跑 chktex 是把别的语法
 * 当 TeX 解析，结果全是噪音。超时 / 非零退出都只返回已解析到的部分（chktex 的退出码
 * 2 就是「有警告」，不是失败）。
 */
export async function lintWithChktex(input: {
  binary: string;
  file: string;
  projectDir: string;
}): Promise<{ ok: boolean; issues: LatexIssue[] }> {
  const result = await run(input.binary, [CHKTEX_FORMAT, "-q", input.file], CHKTEX_TIMEOUT_MS);
  if (result.failed || result.timedOut) return { ok: false, issues: [] };
  return { ok: true, issues: parseChktexOutput(result.stdout, input.projectDir) };
}
