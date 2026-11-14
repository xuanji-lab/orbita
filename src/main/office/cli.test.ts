/**
 * OfficeCLI 的定位与调用层：候选顺序、`--version` 验活、超时杀进程、stdin 传 batch。
 *
 * 真 spawn 的用例只用 node 自己（`process.execPath`）跑一小段脚本——不依赖本机装了
 * OfficeCLI，CI / 别人的机器上也能过。OfficeCLI 的**行为**（HTML / batch 输出）不在
 * 这里测，它由 service.test.ts 用假 runner 钉住。
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  test("设置 → 环境变量 → 打包资源 → 开发态 → 常见目录", () => {
    const list = officeCliCandidates({ ...base, settingsPath: "C:\\tools\\officecli.exe", env: "D:\\x\\officecli.exe" });
    assert.deepEqual(
      list.map((entry) => entry.source),
      ["settings", "env", "dev", "common", "common", "common"],
    );
    assert.equal(list[0]?.path, "C:\\tools\\officecli.exe");
  });

  test("打包版插在开发态之前，路径指向 resources/bin", () => {
    const list = officeCliCandidates({ ...base, packaged: true });
    assert.equal(list[0]?.source, "packaged");
    assert.equal(list[0]?.path, join("/res", "bin", "officecli.exe"));
    assert.equal(list[1]?.source, "dev");
  });

  test("重复路径只留第一个来源；空串当作没设", () => {
    const devPath = join(base.appPath, "build", "bin", "win32-x64", "officecli.exe");
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
