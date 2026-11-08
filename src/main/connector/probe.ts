/**
 * 连接目录的实测：把「这家现在接没接好」从机器上量出来，**不看我们记没记过**。
 *
 * - 命令行类：在固定目录里找可执行文件（打包后的应用 PATH 很短，找不到 /opt/homebrew/bin 里的 gh
 *   是常态），找到就用 `execFile` 跑官方的状态命令（≤5 秒）。只跑目录里写明的只读状态命令，
 *   **不跑会打开浏览器标签页的命令**（Tabbit 没有已知的只读命令，所以只认命令与 skill 文件都在）。
 * - 远程 MCP 类：mcp.json 里有这条且没停用，就真连一次（probeRemoteMcp）；不是 url 型的
 *   （用户自己配了同名 stdio）改看运行时快照里的状态。
 *
 * IO 全部经 `ProbeDeps` 注入，推导是 shared 里的纯函数——这里只负责把事实收齐。
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import {
  deriveConnectorStatus,
  type CliRun,
  type ConnectorEntry,
  type ConnectorFacts,
  type ConnectorStatus,
  type McpProbeFacts,
} from "../../shared/connectors.ts";
import { isHttpServer, type McpHttpServer, type McpServer, type McpStatus } from "../../shared/mcp.ts";
import type { McpProbeResult } from "../../agent/mcp.ts";

/** 状态命令最多等这么久。官方 CLI 的 `auth status` 是本地读，几百毫秒；卡住就是出了事。 */
export const CLI_TIMEOUT_MS = 5000;
const OUTPUT_LIMIT = 4000;

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** 启动失败的 code / message（ENOENT 单独用 `notFound` 表示） */
  error: string | null;
  notFound: boolean;
}

export interface ProbeDeps {
  platform: NodeJS.Platform;
  home: string;
  env: Record<string, string | undefined>;
  exists: (path: string) => boolean;
  listDir: (path: string) => string[];
  exec: (file: string, args: readonly string[], options: { env: Record<string, string | undefined>; timeoutMs: number; shell: boolean }) => Promise<ExecResult>;
  readMcpConfig: () => Promise<Record<string, McpServer>>;
  /** 真连一次远程 MCP；`serverName` 用来在 OAuth 型时向凭据库要 token */
  probeMcp: (server: McpHttpServer, serverName: string) => Promise<McpProbeResult>;
  runtimeStatus: (name: string) => McpStatus | undefined;
  /** 这台 server 正在浏览器里登录（主进程记着）：卡片显示「登录中」 */
  loginInProgress: (serverName: string) => boolean;
}

/** 找可执行文件的目录：常见安装位置 + 进程 PATH。越靠前越优先（用户级目录在系统目录前面）。 */
export function searchDirs(deps: Pick<ProbeDeps, "platform" | "home" | "env" | "exists" | "listDir">): string[] {
  const { platform, home, env } = deps;
  const dirs: string[] = [join(home, ".local", "bin")];
  if (platform === "win32") {
    const appData = env["APPDATA"] ?? join(home, "AppData", "Roaming");
    const local = env["LOCALAPPDATA"] ?? join(home, "AppData", "Local");
    dirs.push(join(appData, "npm"), join(local, "Tabbit", "LocalAgent", "bin"), join(local, "Programs", "GitHub CLI"), join(env["ProgramFiles"] ?? "C:\\Program Files", "GitHub CLI"), join(home, ".bun", "bin"));
  } else {
    dirs.push("/opt/homebrew/bin", "/usr/local/bin", join(home, ".bun", "bin"), join(home, ".npm-global", "bin"), join(home, ".volta", "bin"), join(home, "go", "bin"), join(home, ".cargo", "bin"));
    // nvm 的各版本 bin（装在 nvm 下的 npm 全局包）
    const nvm = join(home, ".nvm", "versions", "node");
    for (const version of deps.listDir(nvm).sort().reverse()) dirs.push(join(nvm, version, "bin"));
    dirs.push("/usr/bin", "/bin");
  }
  const pathKey = platform === "win32" ? (Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH") : "PATH";
  for (const part of (env[pathKey] ?? "").split(delimiter)) if (part !== "") dirs.push(part);
  return [...new Set(dirs)];
}

/** 在目录里找命令；Windows 试 .exe / .cmd / .bat。返回绝对路径或 null。 */
export function findExecutable(command: string, dirs: readonly string[], platform: NodeJS.Platform, exists: (path: string) => boolean): string | null {
  const names = platform === "win32" ? [`${command}.exe`, `${command}.cmd`, `${command}.bat`] : [command];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

function trimOutput(text: string): string {
  return text.length > OUTPUT_LIMIT ? text.slice(0, OUTPUT_LIMIT) : text;
}

/** 跑一家的命令行探测，收成 CliRun。 */
export async function runCliProbe(entry: ConnectorEntry, deps: ProbeDeps): Promise<CliRun> {
  const cli = entry.cli;
  if (cli === undefined) return { found: false, exitCode: null, output: "", timedOut: false, spawnError: null };
  const dirs = searchDirs(deps);
  const path = findExecutable(cli.command, dirs, deps.platform, deps.exists);
  if (path === null) return { found: false, exitCode: null, output: "", timedOut: false, spawnError: null };
  // 没有状态命令（Tabbit）：找到就够了，不跑任何东西
  if (cli.statusArgs === undefined) return { found: true, exitCode: null, output: "", timedOut: false, spawnError: null };
  // 子进程的 PATH 也补上这些目录：npm 全局装的 CLI 多是 `#!/usr/bin/env node`，PATH 里没有 node 就起不来
  const pathKey = deps.platform === "win32" ? (Object.keys(deps.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH") : "PATH";
  const env = { ...deps.env, [pathKey]: dirs.join(delimiter) };
  const result = await deps.exec(path, cli.statusArgs, {
    env,
    timeoutMs: CLI_TIMEOUT_MS,
    // Windows 的 .cmd / .bat 不能直接 execFile；参数是目录里写死的常量，开 shell 不引入注入面
    shell: deps.platform === "win32" && /\.(cmd|bat)$/i.test(path),
  });
  if (result.notFound) return { found: false, exitCode: null, output: "", timedOut: false, spawnError: null };
  return {
    found: true,
    exitCode: result.exitCode,
    output: trimOutput(`${result.stdout}\n${result.stderr}`),
    timedOut: result.timedOut,
    spawnError: result.error,
  };
}

async function mcpFacts(entry: ConnectorEntry, deps: ProbeDeps): Promise<McpProbeFacts | undefined> {
  const mcp = entry.mcp;
  if (mcp === undefined) return undefined;
  const server = (await deps.readMcpConfig())[mcp.serverName];
  if (server === undefined) return { present: false, disabled: false, probe: null };
  if (server.disabled === true) return { present: true, disabled: true, probe: null };
  if (isHttpServer(server)) {
    const result = await deps.probeMcp(server, mcp.serverName);
    return { present: true, disabled: false, probe: result };
  }
  // 用户自己配的同名 stdio：我们不替它起子进程探，看运行时已有的连接状态
  const runtime = deps.runtimeStatus(mcp.serverName);
  if (runtime?.kind === "ready") return { present: true, disabled: false, probe: { ok: true, tools: runtime.tools.length } };
  if (runtime?.kind === "failed") return { present: true, disabled: false, probe: { ok: false, message: runtime.message } };
  return { present: true, disabled: false, probe: null };
}

/** 实测一家，给出状态。不抛：任何意外都收成 failed。 */
export async function probeConnector(entry: ConnectorEntry, deps: ProbeDeps): Promise<ConnectorStatus> {
  if (entry.mcp !== undefined && entry.kind === "mcp-oauth" && deps.loginInProgress(entry.mcp.serverName)) return { kind: "logging-in" };
  try {
    const facts: ConnectorFacts = {};
    if (entry.cli !== undefined) facts.cli = await runCliProbe(entry, deps);
    if (entry.localFiles !== undefined) facts.filesOk = entry.localFiles.every((file) => deps.exists(join(deps.home, ...file.split("/"))));
    const mcp = await mcpFacts(entry, deps);
    if (mcp !== undefined) facts.mcp = mcp;
    return deriveConnectorStatus(entry, facts);
  } catch (cause) {
    return { kind: "failed", code: "error", message: cause instanceof Error ? cause.message : String(cause) };
  }
}

/** 真实的 execFile：退出码、超时、ENOENT 都收成数据。stdin 立刻关掉，免得状态命令等输入。 */
export function execCommand(
  file: string,
  args: readonly string[],
  options: { env: Record<string, string | undefined>; timeoutMs: number; shell: boolean },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFile(
      file,
      [...args],
      { env: options.env, timeout: options.timeoutMs, killSignal: "SIGKILL", maxBuffer: 256 * 1024, windowsHide: true, shell: options.shell },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ exitCode: 0, stdout, stderr, timedOut: false, error: null, notFound: false });
          return;
        }
        const code: unknown = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          resolve({ exitCode: null, stdout, stderr, timedOut: false, error: null, notFound: true });
        } else if (typeof code === "number") {
          resolve({ exitCode: code, stdout, stderr, timedOut: false, error: null, notFound: false });
        } else if (error.killed === true) {
          resolve({ exitCode: null, stdout, stderr, timedOut: true, error: null, notFound: false });
        } else {
          resolve({ exitCode: null, stdout, stderr, timedOut: false, error: typeof code === "string" ? code : error.message, notFound: false });
        }
      },
    );
    child.stdin?.end();
  });
}

/** 生产环境的依赖（测试注入假的）。 */
export function realProbeDeps(parts: Pick<ProbeDeps, "readMcpConfig" | "probeMcp" | "runtimeStatus" | "loginInProgress">): ProbeDeps {
  return {
    platform: process.platform,
    home: homedir(),
    env: process.env,
    exists: (path) => existsSync(path),
    listDir: (path) => {
      try {
        return readdirSync(path);
      } catch {
        return [];
      }
    },
    exec: execCommand,
    ...parts,
  };
}
