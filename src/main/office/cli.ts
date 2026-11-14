/**
 * OfficeCLI 的定位与调用层 —— **纯模块**（不 import electron，可被 `node --test` 直接加载）。
 *
 * 定位顺序（先到先得，每一条都过 `--version` 验活，验不过就当下一条）：
 *   1. 设置里的显式路径（`settings.officeCliPath`）——装在非常规位置的人用；
 *   2. 环境变量 `ORBITA_OFFICECLI`（验收 / 排障时换一份二进制，不改设置）；
 *   3. 打包资源 `resources/bin/officecli[.exe]`（随包分发，scripts/fetch-officecli.mjs 取回）；
 *   4. 开发态 `build/bin/<platform>-<arch>/officecli[.exe]`；
 *   5. 常见安装目录（用户自己装的）。
 *
 * **不挂进 agent 的 PATH**（与 rg / fd 相反）：一旦挂上去，模型可以在 bash 里随手
 * `officecli open`（起 resident）、`officecli install`（自更新），绕过我们「只用 batch /
 * 15 秒超时 / 禁 resident」的约束。只经我们自己的工具用绝对路径调。
 *
 * 调用纪律：`spawn(bin, argv)` 不过 shell（参数里的路径 / 属性值不会被当成命令）；
 * 超时**杀整个进程树**（Windows 用 `taskkill /T /F`，POSIX 用进程组），否则 officecli
 * 拉起的子进程会漏在后台。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  OFFICE_BATCH_TIMEOUT_MS,
  OFFICE_PROBE_TIMEOUT_MS,
  OFFICE_READ_TIMEOUT_MS,
  OFFICE_RENDER_TIMEOUT_MS,
  type OfficeBinSource,
} from "../../shared/office.ts";

/** 一个候选：路径 + 来源（错误信息里要说清「试过哪儿」） */
export interface OfficeCandidate {
  path: string;
  source: OfficeBinSource;
}

/** 一次命令的结果（超时也走这里，`timedOut` 与 `code` 一起说明发生了什么） */
export interface OfficeRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
  timedOut: boolean;
}

/**
 * 子进程的环境：**必须加 `OFFICECLI_NO_AUTO_RESIDENT=1`**。
 *
 * 实测（1.0.158，Windows）：`view html` 与 `batch` 跑完都会留下一个
 * `officecli-win-x64.exe __resident-serve__ "<file>"` 常驻进程，它持有文件句柄——
 * 后果是「回退」的 rename 撞 EPERM、文件删不掉、进程越积越多。这正是红线里
 * 「禁 resident」要防的东西，而上游为此留了一个开关（help 里没写，二进制里有）。
 * 关掉之后 view / batch 跑完即退，不留进程、不占句柄。
 *
 * 注意：**不把 officecli 挂进 PATH**（与 rg / fd 相反），所以这里只给环境，
 * 不让模型在 bash 里直接调它。
 */
export function officeChildEnv(
  base: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  return { ...base, OFFICECLI_NO_AUTO_RESIDENT: "1" };
}

/** 注入点：测试用它换掉真的 spawn（生产用 runOfficeCli） */
export type OfficeRunner = (
  bin: string,
  args: readonly string[],
  options: { timeoutMs?: number; maxBytes?: number; stdin?: string },
) => Promise<OfficeRunResult>;

/** 可执行文件名（Windows 带 .exe） */
export function officeCliFileName(platform: string): string {
  return platform === "win32" ? "officecli.exe" : "officecli";
}

/**
 * 常见安装目录（用户自己装的兜底）。**只列几个确定的**，不做 PATH 探测：
 * GUI 应用的 PATH 往往不含用户 shell 里的目录，扫出来的是错的东西还很难解释。
 */
export function commonOfficeCliDirs(input: {
  platform: string;
  home?: string;
  env?: Record<string, string | undefined>;
}): string[] {
  const env = input.env ?? {};
  const home = input.home ?? homedir();
  const exe = officeCliFileName(input.platform);
  if (input.platform === "win32") {
    const localAppData = env["LOCALAPPDATA"] ?? join(home, "AppData", "Local");
    const programFiles = env["ProgramFiles"] ?? "C:\\Program Files";
    return [
      join(localAppData, "Programs", "officecli", exe),
      join(localAppData, "OfficeCLI", exe),
      join(programFiles, "OfficeCLI", exe),
    ];
  }
  if (input.platform === "darwin") {
    return [
      "/opt/homebrew/bin/officecli",
      "/usr/local/bin/officecli",
      join(home, ".local", "bin", "officecli"),
      join(home, "bin", "officecli"),
    ];
  }
  return [
    "/usr/local/bin/officecli",
    "/usr/bin/officecli",
    join(home, ".local", "bin", "officecli"),
    join(home, "bin", "officecli"),
  ];
}

/** 按定位顺序列出候选（重复路径只留第一个来源；空串当作没设） */
export function officeCliCandidates(input: {
  settingsPath?: string | undefined;
  env?: string | undefined;
  packaged: boolean;
  resourcesPath: string;
  appPath: string;
  platform: string;
  arch: string;
  home?: string;
  envVars?: Record<string, string | undefined>;
}): OfficeCandidate[] {
  const exe = officeCliFileName(input.platform);
  const seen = new Set<string>();
  const out: OfficeCandidate[] = [];
  const push = (path: string, source: OfficeBinSource): void => {
    const trimmed = path.trim();
    if (trimmed === "" || seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push({ path: trimmed, source });
  };
  if (typeof input.settingsPath === "string") push(input.settingsPath, "settings");
  if (typeof input.env === "string") push(input.env, "env");
  if (input.packaged) push(join(input.resourcesPath, "bin", exe), "packaged");
  push(join(input.appPath, "build", "bin", `${input.platform}-${input.arch}`, exe), "dev");
  for (const path of commonOfficeCliDirs({ platform: input.platform, home: input.home, env: input.envVars })) {
    push(path, "common");
  }
  return out;
}

/** `--version` 的输出里取版本号（"1.0.158" / "officecli 1.0.158" 都认）；认不出返回 null */
export function parseOfficeVersion(stdout: string): string | null {
  const match = /\b(\d+\.\d+\.\d+)\b/.exec(stdout);
  return match === null ? null : (match[1] as string);
}

/**
 * 跑一条 officecli 命令。超时分档（见 shared/office.ts 的四个常量：验活 15 s，
 * 读 / 渲染 / 批写各 60 s——实测同类命令能在 0.3–24 s 之间跳，15 s 会误杀正常调用），
 * 到点按进程树杀；stdout / stderr 各封顶 maxBytes（默认 32 MB，html 渲染用得上），
 * 超过就杀掉并按超时同样的方式报（一个把内存吃干的输出不该落进 IPC）。
 */
export function runOfficeCli(
  bin: string,
  args: readonly string[],
  options: { timeoutMs?: number; maxBytes?: number; stdin?: string } = {},
): Promise<OfficeRunResult> {
  const timeoutMs = options.timeoutMs ?? OFFICE_READ_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
  return new Promise<OfficeRunResult>((resolve) => {
    const started = Date.now();
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let settled = false;
    let timedOut = false;
    let overflow = false;
    /** 杀了还不退时的兜底计时器：close 事件没来也要兑现 promise，工具不能永远挂着 */
    let force: ReturnType<typeof setTimeout> | null = null;
    // POSIX 下独立进程组：杀的时候连带子进程；Windows 走 taskkill /T
    const child = spawn(bin, [...args], {
      windowsHide: true,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      env: officeChildEnv(),
    });
    const killTree = (): void => {
      const pid = child.pid;
      if (pid === undefined) return;
      if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, shell: false });
        killer.on("error", () => undefined);
      } else {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {
            // 进程已经没了
          }
        }
      }
    };
    const settle = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (force !== null) clearTimeout(force);
      resolve({ code, stdout, stderr, elapsedMs: Date.now() - started, timedOut: timedOut || overflow });
    };
    /** 超时 / 输出超限：先杀树，2 秒还没 close 就自己收尾（taskkill 也可能失败） */
    const abort = (): void => {
      killTree();
      if (force === null) force = setTimeout(() => settle(null), 2_000);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      abort();
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        overflow = true;
        abort();
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString("utf8");
    });
    child.on("error", (cause: Error) => {
      stderr = `${stderr}${cause.message}`;
      settle(null);
    });
    child.on("close", (code) => settle(code ?? null));
    if (options.stdin !== undefined) {
      child.stdin?.end(options.stdin, "utf8");
    } else {
      child.stdin?.end();
    }
  });
}

/**
 * 逐条验活，返回第一个 `--version` 跑得通的候选。
 * 全部失败时回一句人话（列出试过哪儿），不抛异常——「没装」是正常状态。
 */
export async function resolveOfficeCli(
  candidates: readonly OfficeCandidate[],
  run: OfficeRunner,
): Promise<{ ok: true; candidate: OfficeCandidate; version: string } | { ok: false; detail: string }> {
  const tried: string[] = [];
  for (const candidate of candidates) {
    if (!existsSync(candidate.path)) {
      tried.push(`${candidate.path}（不存在）`);
      continue;
    }
    const result = await run(candidate.path, ["--version"], { timeoutMs: OFFICE_PROBE_TIMEOUT_MS });
    const version = parseOfficeVersion(result.stdout);
    if (result.code === 0 && version !== null) return { ok: true, candidate, version };
    tried.push(`${candidate.path}（--version 失败：${result.timedOut ? "超时" : `exit ${String(result.code)}`}）`);
  }
  return {
    ok: false,
    detail: `未找到可用的 OfficeCLI。试过：${tried.length === 0 ? "没有候选路径" : tried.join("；")}`,
  };
}

/**
 * `view <file> html` → HTML 字符串。**只认 html 模式**（screenshot / pdf 都不走这里：
 * 前者要外部浏览器，后者是给人看的成品）。失败按可读的一句话回，交给面板降级。
 *
 * **不加 `--json`**：实测 html 模式直接把文档写到 stdout，而 `--json` 会把整份 HTML
 * 再转义一遍（体积翻倍、还要多解一层）。
 */
export async function renderOfficeHtml(
  bin: string,
  file: string,
  run: OfficeRunner,
): Promise<{ ok: true; html: string; elapsedMs: number } | { ok: false; detail: string }> {
  const result = await run(bin, ["view", file, "html"], { timeoutMs: OFFICE_RENDER_TIMEOUT_MS });
  if (result.timedOut) {
    return { ok: false, detail: `OfficeCLI 渲染超时（${Math.round(OFFICE_RENDER_TIMEOUT_MS / 1000)} 秒）` };
  }
  const html = result.stdout;
  if (result.code !== 0) {
    return {
      ok: false,
      detail: `OfficeCLI 渲染失败（exit ${String(result.code)}）：${(result.stderr || result.stdout).trim().slice(0, 300)}`,
    };
  }
  if (!/^\s*<(!doctype|html)/i.test(html)) {
    return { ok: false, detail: `OfficeCLI 没有输出 HTML（前 120 字：${html.slice(0, 120)}）` };
  }
  return { ok: true, html, elapsedMs: result.elapsedMs };
}

/** `get <file> <path> --depth <n>` → 纯文本（agent 的 read_office 用） */
export async function getOfficeText(
  bin: string,
  file: string,
  path: string,
  depth: number,
  run: OfficeRunner,
): Promise<{ ok: true; text: string } | { ok: false; detail: string }> {
  const result = await run(bin, ["get", file, path, "--depth", String(depth)], { timeoutMs: OFFICE_READ_TIMEOUT_MS });
  if (result.timedOut) return { ok: false, detail: `OfficeCLI 读取超时（${Math.round(OFFICE_READ_TIMEOUT_MS / 1000)} 秒）` };
  if (result.code !== 0) {
    return { ok: false, detail: `OfficeCLI 读取失败（exit ${String(result.code)}）：${(result.stderr || result.stdout).trim().slice(0, 300)}` };
  }
  return { ok: true, text: result.stdout };
}

/**
 * `batch <file> --json --commands <json>`（standalone = 一次 open/save）。
 * `bestEffort` 只给「读旧值」那条用：读不改盘，一项读失败不该把整批回滚掉；
 * 真正的写批次用默认 atomic。
 */
export async function runOfficeBatch(
  bin: string,
  file: string,
  items: readonly unknown[],
  run: OfficeRunner,
  options: { bestEffort?: boolean } = {},
): Promise<OfficeRunResult & { argv: string[] }> {
  const argv = [
    "batch",
    file,
    "--json",
    // 命令走 stdin 而不是 argv：Windows 的 argv 长度上限（32K）+ 中文属性值转义都更安全
    "--input",
    "-",
    ...(options.bestEffort === true ? ["--best-effort"] : []),
  ];
  const result = await run(bin, argv, {
    timeoutMs: OFFICE_BATCH_TIMEOUT_MS,
    stdin: JSON.stringify(items),
  });
  return { ...result, argv };
}

