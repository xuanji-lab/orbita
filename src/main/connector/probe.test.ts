import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, test } from "node:test";
import { findConnector } from "../../shared/connectors.ts";
import type { McpServer, McpStatus } from "../../shared/mcp.ts";
import { execCommand, findExecutable, probeConnector, searchDirs, type ExecResult, type ProbeDeps } from "./probe.ts";

const ok = (over: Partial<ExecResult> = {}): ExecResult => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false, error: null, notFound: false, ...over });

interface Fake {
  deps: ProbeDeps;
  execCalls: { file: string; args: readonly string[]; env: Record<string, string | undefined>; shell: boolean; timeoutMs: number }[];
  probed: McpServer[];
  probedNames: string[];
}

function fake(over: {
  files?: string[];
  exec?: ExecResult;
  config?: Record<string, McpServer>;
  mcp?: Awaited<ReturnType<ProbeDeps["probeMcp"]>>;
  runtime?: McpStatus;
  loggingIn?: string[];
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  dirs?: Record<string, string[]>;
}): Fake {
  const files = new Set(over.files ?? []);
  const execCalls: Fake["execCalls"] = [];
  const probed: McpServer[] = [];
  const probedNames: string[] = [];
  const deps: ProbeDeps = {
    platform: over.platform ?? "darwin",
    home: "/h",
    env: over.env ?? { PATH: "/usr/bin" },
    exists: (path) => files.has(path),
    listDir: (path) => over.dirs?.[path] ?? [],
    exec: (file, args, options) => {
      execCalls.push({ file, args, env: options.env, shell: options.shell, timeoutMs: options.timeoutMs });
      return Promise.resolve(over.exec ?? ok());
    },
    readMcpConfig: () => Promise.resolve(over.config ?? {}),
    probeMcp: (server, serverName) => {
      probed.push(server);
      probedNames.push(serverName);
      return Promise.resolve(over.mcp ?? { ok: true, tools: 2 });
    },
    runtimeStatus: () => over.runtime,
    loginInProgress: (name) => over.loggingIn?.includes(name) === true,
  };
  return { deps, execCalls, probed, probedNames };
}

const entry = (id: string) => {
  const found = findConnector(id);
  assert.ok(found);
  return found;
};

describe("找可执行文件", () => {
  test("用户目录与 homebrew 在系统目录前；PATH 里的目录也找；nvm 各版本新的在前", () => {
    const dirs = searchDirs(fake({ env: { PATH: "/custom/bin:/usr/bin" }, dirs: { "/h/.nvm/versions/node": ["v20.1.0", "v22.0.0"] } }).deps);
    assert.equal(dirs[0], "/h/.local/bin");
    assert.ok(dirs.indexOf("/opt/homebrew/bin") < dirs.indexOf("/usr/bin"));
    assert.ok(dirs.includes("/h/.nvm/versions/node/v22.0.0/bin"));
    assert.ok(dirs.indexOf("/h/.nvm/versions/node/v22.0.0/bin") < dirs.indexOf("/h/.nvm/versions/node/v20.1.0/bin"));
    assert.ok(dirs.includes("/custom/bin"));
    assert.equal(new Set(dirs).size, dirs.length, "目录要去重");
  });

  test("按目录顺序取第一个命中的；都没有返回 null；Windows 试 .exe / .cmd", () => {
    const has = new Set(["/opt/homebrew/bin/gh", "/usr/bin/gh"]);
    assert.equal(findExecutable("gh", ["/h/.local/bin", "/opt/homebrew/bin", "/usr/bin"], "darwin", (p) => has.has(p)), "/opt/homebrew/bin/gh");
    assert.equal(findExecutable("nope", ["/usr/bin"], "darwin", () => false), null);
    const win = new Set([join("/w/npm", "lark-cli.cmd")]);
    assert.equal(findExecutable("lark-cli", ["/w/npm"], "win32", (p) => win.has(p)), join("/w/npm", "lark-cli.cmd"));
  });
});

describe("命令行类实测", () => {
  test("没装：不跑任何命令，未配置（没装）", async () => {
    const f = fake({});
    assert.deepEqual(await probeConnector(entry("feishu"), f.deps), { kind: "unset", reason: "cli-missing" });
    assert.equal(f.execCalls.length, 0);
  });

  test("装了且状态命令退出 0 → 已连接；跑的是目录里写明的只读命令，5 秒超时，PATH 补了安装目录", async () => {
    const f = fake({ files: ["/opt/homebrew/bin/lark-cli"], exec: ok({ stdout: "logged in as 张三" }) });
    assert.deepEqual(await probeConnector(entry("feishu"), f.deps), { kind: "connected", by: "cli" });
    assert.equal(f.execCalls.length, 1);
    assert.equal(f.execCalls[0]?.file, "/opt/homebrew/bin/lark-cli");
    assert.deepEqual(f.execCalls[0]?.args, ["auth", "status"]);
    assert.equal(f.execCalls[0]?.timeoutMs, 5000);
    assert.equal(f.execCalls[0]?.shell, false);
    assert.ok(f.execCalls[0]?.env["PATH"]?.split(delimiter).includes("/opt/homebrew/bin"));
  });

  test("退出非 0 → 未配置（没登录）；退出 0 但输出说未登录 → 同样不算；超时 → 检测失败", async () => {
    const files = ["/usr/local/bin/dws"];
    assert.deepEqual(await probeConnector(entry("dingtalk"), fake({ files, exec: ok({ exitCode: 1, stderr: "not logged in" }) }).deps), { kind: "unset", reason: "not-logged-in" });
    assert.deepEqual(await probeConnector(entry("dingtalk"), fake({ files, exec: ok({ stdout: "未登录" }) }).deps), { kind: "unset", reason: "not-logged-in" });
    assert.deepEqual(await probeConnector(entry("dingtalk"), fake({ files, exec: ok({ exitCode: null, timedOut: true }) }).deps), { kind: "failed", code: "timeout", message: "" });
  });

  test("找到后执行时 ENOENT（刚被卸载）按没装算；启动失败（没权限）报检测失败", async () => {
    const files = ["/usr/local/bin/wecom-cli"];
    assert.deepEqual(await probeConnector(entry("wecom"), fake({ files, exec: ok({ exitCode: null, notFound: true }) }).deps), { kind: "unset", reason: "cli-missing" });
    assert.deepEqual(await probeConnector(entry("wecom"), fake({ files, exec: ok({ exitCode: null, error: "EACCES" }) }).deps), { kind: "failed", code: "error", message: "EACCES" });
  });

  test("Windows 的 .cmd 走 shell，.exe 不走", async () => {
    // 路径用 join 拼：测试在 macOS 上跑，只验平台分支，不验盘符
    const cmd = fake({ platform: "win32", env: { APPDATA: "/w/Roaming", PATH: "" }, files: [join("/w/Roaming", "npm", "lark-cli.cmd")] });
    await probeConnector(entry("feishu"), cmd.deps);
    assert.equal(cmd.execCalls[0]?.shell, true);
    const exe = fake({ platform: "win32", env: { PATH: "/w/bin" }, files: [join("/w/bin", "gh.exe")] });
    await probeConnector(entry("github"), exe.deps);
    assert.equal(exe.execCalls[0]?.shell, false);
  });

  test("Tabbit：命令与 skill 文件都在才算接好，且什么命令都不跑（不会拉起浏览器）", async () => {
    const both = fake({ files: ["/h/.local/bin/tabbit-cli", "/h/.agents/skills/tabbit/SKILL.md"] });
    assert.deepEqual(await probeConnector(entry("tabbit"), both.deps), { kind: "connected", by: "local" });
    assert.equal(both.execCalls.length, 0);
    const noSkill = fake({ files: ["/h/.local/bin/tabbit-cli"] });
    assert.deepEqual(await probeConnector(entry("tabbit"), noSkill.deps), { kind: "unset", reason: "no-config" });
    const noCli = fake({ files: ["/h/.agents/skills/tabbit/SKILL.md"] });
    assert.deepEqual(await probeConnector(entry("tabbit"), noCli.deps), { kind: "unset", reason: "cli-missing" });
  });
});

describe("远程 MCP 类实测", () => {
  const tokenServer: McpServer = { transport: "http", url: "https://docs.qq.com/openapi/mcp", headers: { Authorization: "tok" } };

  test("mcp.json 没有这条 → 未配置，不连接", async () => {
    const f = fake({});
    assert.deepEqual(await probeConnector(entry("tencent-docs"), f.deps), { kind: "unset", reason: "no-config" });
    assert.equal(f.probed.length, 0);
  });

  test("停用的条目 → 未配置（已停用），不连接", async () => {
    const f = fake({ config: { "tencent-docs": { ...tokenServer, disabled: true } } });
    assert.deepEqual(await probeConnector(entry("tencent-docs"), f.deps), { kind: "unset", reason: "disabled" });
    assert.equal(f.probed.length, 0);
  });

  test("有条目就真连一次：通 → 已连接（带工具数）；不通 → 检测失败（带原因）", async () => {
    const good = fake({ config: { "tencent-docs": tokenServer }, mcp: { ok: true, tools: 9 } });
    assert.deepEqual(await probeConnector(entry("tencent-docs"), good.deps), { kind: "connected", by: "mcp", tools: 9 });
    assert.deepEqual(good.probed, [tokenServer]);
    const bad = fake({ config: { "tencent-docs": tokenServer }, mcp: { ok: false, message: "SSE error: Non-200 status code (401)" } });
    assert.deepEqual(await probeConnector(entry("tencent-docs"), bad.deps), { kind: "failed", code: "mcp", message: "SSE error: Non-200 status code (401)" });
  });

  test("探测自己抛了（意外）也收成检测失败，不冒泡", async () => {
    const f = fake({ config: { "tencent-docs": tokenServer } });
    f.deps.probeMcp = () => Promise.reject(new Error("boom"));
    assert.deepEqual(await probeConnector(entry("tencent-docs"), f.deps), { kind: "failed", code: "error", message: "boom" });
  });

  test("用户自己配了同名 stdio：不替它起子进程，看运行时已有状态", async () => {
    const stdio: McpServer = { transport: "stdio", command: "gh-mcp" };
    const ready = fake({ config: { github: stdio }, runtime: { kind: "ready", tools: ["a", "b"] }, files: [] });
    ready.deps.exec = () => Promise.resolve(ok({ exitCode: null, notFound: true }));
    assert.deepEqual(await probeConnector(entry("github"), ready.deps), { kind: "connected", by: "mcp", tools: 2 });
    assert.equal(ready.probed.length, 0);
    const idle = fake({ config: { github: stdio } });
    assert.deepEqual(await probeConnector(entry("github"), idle.deps), { kind: "unset", reason: "cli-missing" });
  });

  test("GitHub：没装 gh、但 mcp.json 里的 github 远程 MCP 实测通 → 已连接", async () => {
    const f = fake({ config: { github: { transport: "http", url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: "Bearer x" } } } });
    assert.deepEqual(await probeConnector(entry("github"), f.deps), { kind: "connected", by: "mcp", tools: 2 });
  });

  test("OAuth 型：mcp.json 里没有 → 未配置，不探测", async () => {
    const f = fake({});
    assert.deepEqual(await probeConnector(entry("notion"), f.deps), { kind: "unset", reason: "no-config" });
    assert.equal(f.probed.length, 0);
  });

  test("OAuth 型：有条目就真连一次（带上 server 名，主进程凭它去凭据库要 token）；通 → 已连接并数出工具", async () => {
    const f = fake({ config: { pangram: { transport: "http", url: "https://www.pangram.com/mcp", auth: "oauth" } }, mcp: { ok: true, tools: 6 } });
    assert.deepEqual(await probeConnector(entry("pangram"), f.deps), { kind: "connected", by: "mcp", tools: 6 });
    assert.deepEqual(f.probedNames, ["pangram"]);
  });

  test("OAuth 型：实测说要登录 → failed + login；别的失败 → failed + mcp", async () => {
    const config = { notion: { transport: "http" as const, url: "https://mcp.notion.com/mcp", auth: "oauth" as const } };
    const needs = fake({ config, mcp: { ok: false, message: "notion 还没有登录", needsLogin: true } });
    assert.deepEqual(await probeConnector(entry("notion"), needs.deps), { kind: "failed", code: "login", message: "notion 还没有登录" });
    const broken = fake({ config, mcp: { ok: false, message: "ECONNREFUSED" } });
    assert.deepEqual(await probeConnector(entry("notion"), broken.deps), { kind: "failed", code: "mcp", message: "ECONNREFUSED" });
  });

  test("OAuth 型：浏览器登录进行中 → logging-in，不去探测（切页签、窗口聚焦重探都能看到）；别家不受影响", async () => {
    const f = fake({ loggingIn: ["notion"], config: { notion: { transport: "http", url: "https://mcp.notion.com/mcp", auth: "oauth" } } });
    assert.deepEqual(await probeConnector(entry("notion"), f.deps), { kind: "logging-in" });
    assert.equal(f.probed.length, 0);
    assert.deepEqual(await probeConnector(entry("supabase"), f.deps), { kind: "unset", reason: "no-config" });
  });

  test("引导型（携程）没有可测通路：未配置，什么都不跑", async () => {
    const f = fake({});
    assert.deepEqual(await probeConnector(entry("ctrip"), f.deps), { kind: "unset", reason: "no-config" });
    assert.equal(f.execCalls.length + f.probed.length, 0);
  });
});

describe("真实 execFile", () => {
  test("退出码、超时、不存在的文件、stdin 被关闭都收成数据", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-conn-"));
    try {
      const env = { ...process.env };
      const base = { env, shell: false };
      const exit3 = await execCommand(process.execPath, ["-e", "process.stderr.write('no'); process.exit(3)"], { ...base, timeoutMs: 5000 });
      assert.equal(exit3.exitCode, 3);
      assert.equal(exit3.stderr, "no");
      const pass = await execCommand(process.execPath, ["-e", "console.log('hi')"], { ...base, timeoutMs: 5000 });
      assert.deepEqual([pass.exitCode, pass.stdout.trim()], [0, "hi"]);
      const slow = await execCommand(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { ...base, timeoutMs: 300 });
      assert.equal(slow.timedOut, true);
      assert.equal(slow.exitCode, null);
      const missing = await execCommand(join(dir, "nope"), [], { ...base, timeoutMs: 1000 });
      assert.equal(missing.notFound, true);
      // 等 stdin 输入的命令：stdin 一关就读到 EOF 正常退出，不会被挂到超时
      const readsStdin = await execCommand(process.execPath, ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.exit(0))"], { ...base, timeoutMs: 3000 });
      assert.equal(readsStdin.exitCode, 0);
      assert.equal(readsStdin.timedOut, false);
      // 没有执行权限 → 启动失败，不是「没装」
      if (process.platform !== "win32") {
        const noExec = join(dir, "noexec");
        await mkdir(dir, { recursive: true });
        await writeFile(noExec, "#!/bin/sh\nexit 0\n");
        await chmod(noExec, 0o644);
        const denied = await execCommand(noExec, [], { ...base, timeoutMs: 1000 });
        assert.equal(denied.notFound, false);
        assert.equal(denied.error, "EACCES");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
