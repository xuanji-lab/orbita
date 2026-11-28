/**
 * OfficeCLI 的定位与调用层：候选顺序、`--version` 验活、超时杀进程、stdin 传 batch。
 *
 * 真 spawn 的用例只用 node 自己（`process.execPath`）跑一小段脚本——不依赖本机装了
 * OfficeCLI，CI / 别人的机器上也能过。OfficeCLI 的**行为**（HTML / batch 输出）不在
 * 这里测，它由 service.test.ts 用假 runner 钉住。
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  commonOfficeCliDirs,
  officeCliCandidates,
  officeChildEnv,
  officeCliFileName,
  parseOfficeVersion,
  resolveOfficeCli,
  runOfficeCli,
} from "./cli.ts";

let dir = "";
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-office-cli-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("候选顺序", () => {
  const base = {
    packaged: false,
    resourcesPath: "/res",
    appPath: "/app",
    platform: "win32",
    arch: "x64",
    home: "C:\\Users\\u",
    envVars: { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" },
  };

  test("设置 → 环境变量 → 打包资源 → 开发态 → 常见目录（每个布局新旧两条）", () => {
    const list = officeCliCandidates({ ...base, settingsPath: "C:\\tools\\officecli.exe", env: "D:\\x\\officecli.exe" });
    assert.deepEqual(
      list.map((entry) => entry.source),
      ["settings", "env", "dev", "dev", "common", "common", "common"],
    );
    assert.equal(list[0]?.path, "C:\\tools\\officecli.exe");
  });

  test("打包版：新布局（bin/officecli/）在先，旧布局（bin/）回退", () => {
    const list = officeCliCandidates({ ...base, packaged: true });
    assert.deepEqual(
      list.map((entry) => entry.source),
      ["packaged", "packaged", "dev", "dev", "common", "common", "common"],
    );
    assert.equal(list[0]?.path, join("/res", "bin", "officecli", "officecli.exe"));
    assert.equal(list[1]?.path, join("/res", "bin", "officecli.exe"));
  });

  test("开发态：新布局（build/bin/<p>-<a>/officecli/）在先，旧布局回退", () => {
    const list = officeCliCandidates({ ...base });
    assert.equal(list[0]?.path, join("/app", "build", "bin", "win32-x64", "officecli", "officecli.exe"));
    assert.equal(list[1]?.path, join("/app", "build", "bin", "win32-x64", "officecli.exe"));
  });

  test("重复路径只留第一个来源；空串当作没设", () => {
    const devPath = join(base.appPath, "build", "bin", "win32-x64", "officecli", "officecli.exe");
    const list = officeCliCandidates({ ...base, settingsPath: "  ", env: devPath, packaged: true });
    assert.equal(list[0]?.source, "env");
    assert.equal(list.filter((entry) => entry.path === devPath).length, 1);
  });

  test("平台决定可执行文件名与常见目录", () => {
    assert.equal(officeCliFileName("win32"), "officecli.exe");
    assert.equal(officeCliFileName("darwin"), "officecli");
    assert.ok(commonOfficeCliDirs({ platform: "darwin", home: "/Users/u" }).includes("/opt/homebrew/bin/officecli"));
    assert.ok(commonOfficeCliDirs({ platform: "linux", home: "/home/u" }).includes("/usr/local/bin/officecli"));
  });
});

describe("officeChildEnv", () => {
  test("关掉自动 resident（view / batch 跑完会在后台留一个 holding 文件的常驻进程）", () => {
    const env = officeChildEnv({ PATH: "/bin", FOO: "bar" });
    assert.equal(env["OFFICECLI_NO_AUTO_RESIDENT"], "1");
    assert.equal(env["PATH"], "/bin");
    assert.equal(env["FOO"], "bar");
  });
});

describe("officeChildEnv 禁自更新", () => {
  test("SKIP_UPDATE / NO_AUTO_INSTALL 恒为 1，调用方的同名变量盖不掉", () => {
    const env = officeChildEnv({ OFFICECLI_SKIP_UPDATE: "0", OFFICECLI_NO_AUTO_INSTALL: "0" });
    assert.equal(env["OFFICECLI_SKIP_UPDATE"], "1");
    assert.equal(env["OFFICECLI_NO_AUTO_INSTALL"], "1");
  });
});

describe("parseOfficeVersion", () => {
  test("从 --version 的输出里取三段号", () => {
    assert.equal(parseOfficeVersion("1.0.158\n"), "1.0.158");
    assert.equal(parseOfficeVersion("officecli 1.2.3"), "1.2.3");
    assert.equal(parseOfficeVersion("nope"), null);
  });
});

describe("resolveOfficeCli", () => {
  test("跳过不存在的候选；第一条 --version 通过的就是它", async () => {
    const good = join(dir, "good.exe");
    await writeFile(good, "");
    const tried: string[] = [];
    const result = await resolveOfficeCli(
      [
        { path: join(dir, "missing.exe"), source: "settings" },
        { path: good, source: "env" },
      ],
      async (bin) => {
        tried.push(bin);
        return { code: 0, stdout: "1.0.158", stderr: "", elapsedMs: 5, timedOut: false };
      },
    );
    assert.equal(result.ok, true);
    assert.ok(result.ok);
    assert.equal(result.version, "1.0.158");
    assert.deepEqual(tried, [good]);
  });

  test("新布局存在用新的；只有旧布局回退旧的；都没有则不可用（跨 PR 路径约定）", async () => {
    const resources = join(dir, "layout-resources");
    const appPath = join(dir, "layout-app");
    const fresh = join(resources, "bin", "officecli", "officecli.exe");
    const legacy = join(resources, "bin", "officecli.exe");
    const candidates = () =>
      officeCliCandidates({ packaged: true, resourcesPath: resources, appPath, platform: "win32", arch: "x64", envVars: {} });
    const okRunner = async (): Promise<{ code: number; stdout: string; stderr: string; elapsedMs: number; timedOut: boolean }> => ({
      code: 0,
      stdout: "1.0.158",
      stderr: "",
      elapsedMs: 5,
      timedOut: false,
    });

    // 新旧都在：用新的（独立子目录，不挂在 resources/bin 的 PATH 上）
    await mkdir(dirname(fresh), { recursive: true });
    await writeFile(fresh, "");
    await writeFile(legacy, "");
    let result = await resolveOfficeCli(candidates(), okRunner);
    assert.ok(result.ok);
    assert.equal(result.candidate.path, fresh);

    // 去掉新路径：回退旧的（用户机器上已有旧安装 / 旧构建）
    await rm(fresh);
    result = await resolveOfficeCli(candidates(), okRunner);
    assert.ok(result.ok);
    assert.equal(result.candidate.path, legacy);

    // 都没有：不可用（不是「随便找个路径就算」）
    await rm(legacy);
    result = await resolveOfficeCli(candidates(), okRunner);
    assert.equal(result.ok, false);
  });

  test("全部失败：说清试过哪儿、为什么不认，不抛异常", async () => {
    const bad = join(dir, "bad.exe");
    await writeFile(bad, "");
    const result = await resolveOfficeCli([{ path: bad, source: "settings" }], async () => ({
      code: 1,
      stdout: "",
      stderr: "boom",
      elapsedMs: 5,
      timedOut: false,
    }));
    assert.equal(result.ok, false);
    assert.ok(!result.ok);
    assert.match(result.detail, /未找到可用的 OfficeCLI/);
    assert.match(result.detail, /exit 1/);
  });
});

describe("runOfficeCli（真 spawn node）", () => {
  test("跑通：stdout 收齐、退出码 0、stdin 能写进去", async () => {
    const result = await runOfficeCli(
      process.execPath,
      ["-e", "let s='';process.stdin.on('data',(c)=>s+=c).on('end',()=>console.log('got:'+s))"],
      { stdin: "hello", timeoutMs: 10_000 },
    );
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), "got:hello");
    assert.equal(result.timedOut, false);
  });

  test("超时：15s 上限可注入更短值，被杀且报 timedOut", async () => {
    const started = Date.now();
    const result = await runOfficeCli(process.execPath, ["-e", "setTimeout(()=>{},8000)"], { timeoutMs: 300 });
    assert.equal(result.timedOut, true);
    assert.ok(Date.now() - started < 4000, "超时后应立刻返回，不等子进程自己退出");
  });

  test("输出超上限：杀掉并按超时同样报（不把几十 MB 塞进 IPC）", async () => {
    const result = await runOfficeCli(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(200000));setTimeout(()=>{},8000)"],
      { timeoutMs: 10_000, maxBytes: 1024 },
    );
    assert.equal(result.timedOut, true);
  });
});
