/**
 * OfficeService 的账：批改 → 备份 → 改动清单 → 整批回退，全用假 runner 走（不依赖
 * 本机装没装 OfficeCLI）。真二进制的行为由真机验收盖，这里钉的是我们自己的纪律：
 *   - 这一批的第一次编辑才备份，同批后续编辑不覆盖它；
 *   - 读旧值与写分开（读失败不影响写，写失败整批不落盘、清单不记）；
 *   - 回退是整份文件还原，回退后清单清空、界面收到通知。
 */
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OfficeRunResult } from "./cli.ts";
import type { OfficeRunner } from "./cli.ts";
import { OfficeService } from "./service.ts";

let dir = "";
let bin = "";
let file = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-office-svc-"));
  bin = join(dir, "officecli.exe");
  await writeFile(bin, "");
  file = join(dir, "book.xlsx");
  await writeFile(file, "ORIGINAL");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Call {
  argv: readonly string[];
  stdin: string | undefined;
}

/** 假 officecli：--version / view html / batch（读与写都按 stdin 的 JSON 答） */
function fakeRunner(options: { failWrite?: boolean; timeoutWrite?: boolean; versionOk?: boolean } = {}): {
  run: OfficeRunner;
  calls: Call[];
} {
  const calls: Call[] = [];
  const run: OfficeRunner = async (_bin, argv, opts): Promise<OfficeRunResult> => {
    calls.push({ argv, stdin: opts.stdin });
    const done = (code: number, stdout: string): OfficeRunResult => ({
      code,
      stdout,
      stderr: code === 0 ? "" : "failed",
      elapsedMs: 7,
      timedOut: false,
    });
    if (argv[0] === "--version") return done(options.versionOk === false ? 1 : 0, options.versionOk === false ? "" : "1.0.158\n");
    if (argv[0] === "view") return done(0, "<!DOCTYPE html><html><body><div data-path=\"/Sheet1/B2\">42</div></body></html>");
    if (argv[0] === "get") return done(0, "/Sheet1\n/Sheet1/B2 (cell) \"42\"\n");
    if (argv[0] === "batch") {
      if (options.timeoutWrite === true) {
        return { code: null, stdout: "", stderr: "", elapsedMs: 15_000, timedOut: true };
      }
      const items = JSON.parse(opts.stdin ?? "[]") as { command: string; path?: string; parent?: string; type?: string; props?: Record<string, string> }[];
      if (items.every((item) => item.command === "get")) {
        return done(0, JSON.stringify({
          success: true,
          data: { results: items.map((item, index) => ({ index, success: true, output: { results: [{ path: item.path, text: "42" }] } })) },
        }));
      }
      if (options.failWrite === true) {
        return done(1, JSON.stringify({
          success: false,
          data: { results: items.map((item, index) => ({ index, success: false, error: "Element not found", code: "not_found" })) },
        }));
      }
      await writeFile(file, `AFTER:${JSON.stringify(items)}`);
      return done(0, JSON.stringify({
        success: true,
        data: {
          results: items.map((item, index) => ({
            index,
            success: true,
            output: item.command === "add" ? `Added ${item.type ?? "element"} at /slide[1]/shape[@id=7]` : `Updated ${item.path}: value=99`,
          })),
        },
      }));
    }
    return done(2, "");
  };
  return { run, calls };
}

function service(run: OfficeRunner, configured?: string): OfficeService {
  return new OfficeService({
    configuredPath: async () => configured,
    candidatesFor: () => [{ path: bin, source: "settings" }],
    backupDir: async () => join(dir, "backups"),
    run,
    now: () => 1_700_000_000_000,
  });
}

describe("status / render / read", () => {
  test("验活成功 → 版本与来源；render 回 HTML；不可用时 status 带人话", async () => {
    const { run } = fakeRunner();
    const office = service(run);
    const status = await office.status();
    assert.equal(status.available, true);
    assert.equal(status.version, "1.0.158");
    assert.equal(status.source, "settings");

    const rendered = await office.render(file);
    assert.equal(rendered.kind, "html");
    assert.ok(rendered.kind === "html");
    assert.match(rendered.html, /data-path/);

    const read = await office.read(file, "/Sheet1", 2);
    assert.equal(read.ok, true);
    assert.ok(read.ok);
    assert.match(read.text, /B2/);
  });

  test("二进制验活失败 → 所有入口都回 unavailable / error，不抛", async () => {
    const { run } = fakeRunner({ versionOk: false });
    const office = service(run);
    const status = await office.status();
    assert.equal(status.available, false);
    assert.match(status.detail ?? "", /OfficeCLI/);
    const rendered = await office.render(file);
    assert.equal(rendered.kind, "unavailable");
  });
});

describe("edit → 清单 → 回退", () => {
  test("先备份再写；读旧值走单独的读批次；清单有前值与后值", async () => {
    const { run, calls } = fakeRunner();
    const office = service(run);
    const outcome = await office.edit("s1", file, [{ op: "set", path: "/Sheet1/B2", props: { value: 99 } }]);
    assert.equal(outcome.ok, true);
    assert.ok(outcome.ok && outcome.kind === "edit");
    assert.equal(outcome.items.length, 1);
    assert.equal(outcome.items[0]?.before, "42");
    assert.equal(outcome.items[0]?.after, "99");
    assert.equal(outcome.canRevert, true);

    // 备份里有原文件（同目录还有一份清单 .json）
    const backups = await readdir(join(dir, "backups"));
    assert.equal(backups.filter((name) => !name.endsWith(".json")).length, 1);
    const backupName = backups.find((name) => !name.endsWith(".json")) as string;
    assert.equal(await readFile(join(dir, "backups", backupName), "utf8"), "ORIGINAL");

    // 读批次用了 --best-effort，写批次没有
    const batches = calls.filter((call) => call.argv[0] === "batch");
    assert.equal(batches.length, 2);
    assert.ok(batches[0]?.argv.includes("--best-effort"));
    assert.equal(batches[1]?.argv.includes("--best-effort"), false);

    const changes = await office.changesOf("s1", file);
    assert.equal(changes.items.length, 1);
    assert.equal(changes.backup, join(dir, "backups", backupName));
  });

  test("同一批的第二次编辑追加到同一份清单，不覆盖备份", async () => {
    const { run } = fakeRunner();
    const office = service(run);
    await office.edit("s1", file, [{ op: "set", path: "/Sheet1/B2", props: { value: 99 } }]);
    await office.edit("s1", file, [{ op: "add", path: "/slide[1]", type: "shape", props: { text: "Hi" } }]);
    const changes = await office.changesOf("s1", file);
    assert.equal(changes.items.length, 2);
    assert.equal(changes.items[1]?.path, "/slide[1]/shape[@id=7]");
    assert.equal((await readdir(join(dir, "backups"))).filter((name) => !name.endsWith(".json")).length, 1);
  });

  test("整批回退：文件逐字节还原、清单清空、界面收到通知", async () => {
    const { run } = fakeRunner();
    const office = service(run);
    const notices: string[] = [];
    const withNotify = new OfficeService({
      configuredPath: async () => undefined,
      candidatesFor: () => [{ path: bin, source: "settings" }],
      backupDir: async () => join(dir, "backups"),
      run,
      now: () => 1,
      notify: (path) => notices.push(path),
    });
    await withNotify.edit("s1", file, [{ op: "set", path: "/Sheet1/B2", props: { value: 99 } }]);
    assert.match(await readFile(file, "utf8"), /^AFTER:/);
    const reverted = await withNotify.revert("s1", file);
    assert.equal(reverted.ok, true);
    assert.equal(reverted.restored, 1);
    assert.equal(await readFile(file, "utf8"), "ORIGINAL");
    assert.equal((await withNotify.changesOf("s1", file)).items.length, 0);
    assert.deepEqual(notices, [file, file]);
    // 没有改动可退
    assert.equal((await office.revert("s1", file)).ok, false);
  });

  test("重启后清单从备份旁的 .json 认领，回退仍然可用（备份与清单一起删）", async () => {
    const { run } = fakeRunner();
    const first = service(run);
    await first.edit("s1", file, [{ op: "set", path: "/Sheet1/B2", props: { value: 99 } }]);
    const backups = await readdir(join(dir, "backups"));
    assert.equal(backups.filter((name) => name.endsWith(".json")).length, 1);

    // 新进程（内存里的清单没了）：从盘上认领
    const second = service(run);
    const changes = await second.changesOf("s1", file);
    assert.equal(changes.items.length, 1);
    assert.equal(changes.items[0]?.path, "/Sheet1/B2");
    assert.equal(changes.backup, join(dir, "backups", (backups.find((name) => name.endsWith(".json")) as string).slice(0, -5)));

    const reverted = await second.revert("s1", file);
    assert.equal(reverted.ok, true);
    assert.equal(await readFile(file, "utf8"), "ORIGINAL");
    assert.deepEqual(await readdir(join(dir, "backups")), []);
  });

  test("写批次原子失败：不回 ok、不记清单、盘上文件一个字节没动（备份也不留）", async () => {
    const { run } = fakeRunner({ failWrite: true });
    const office = service(run);
    const outcome = await office.edit("s1", file, [{ op: "set", path: "/Sheet1/B2", props: { value: 99 } }]);
    assert.equal(outcome.ok, false);
    assert.ok(!outcome.ok);
    assert.match(outcome.error, /nothing was written/i);
    assert.equal(await readFile(file, "utf8"), "ORIGINAL");
    assert.equal((await office.changesOf("s1", file)).items.length, 0);
    // 备份在建了之后才发现整批失败：删掉，不留没人认领的孤儿
    assert.deepEqual(await readdir(join(dir, "backups")), []);
  });

  test("写批次超时：回 ok:false 并说明备份位置，不把超时当成功", async () => {
    const { run } = fakeRunner({ timeoutWrite: true });
    const office = service(run);
    const outcome = await office.edit("s1", file, [{ op: "set", path: "/Sheet1/B2", props: { value: 99 } }]);
    assert.equal(outcome.ok, false);
    assert.ok(!outcome.ok);
    assert.match(outcome.error, /timed out/);
  });

  test("坏操作（全是不合法路径）→ 直接报错，不 spawn 写批次", async () => {
    const { run, calls } = fakeRunner();
    const office = service(run);
    const outcome = await office.edit("s1", file, [{ op: "set", path: "Sheet1/B2", props: { value: 1 } }]);
    assert.equal(outcome.ok, false);
    assert.equal(calls.filter((call) => call.argv[0] === "batch").length, 0);
  });

  test("同一份文件的两次编辑排队（不会交叉写）", async () => {
    const { run } = fakeRunner();
    const office = service(run);
    const order: string[] = [];
    const slow: OfficeRunner = async (b, argv, opts) => {
      if (argv[0] === "batch" && opts.stdin?.includes('"set"') === true) {
        order.push("start");
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push("end");
      }
      return run(b, argv, opts);
    };
    const queued = new OfficeService({
      configuredPath: async () => undefined,
      candidatesFor: () => [{ path: bin, source: "settings" }],
      backupDir: async () => join(dir, "backups"),
      run: slow,
      now: () => 1,
    });
    await Promise.all([
      queued.edit("s1", file, [{ op: "set", path: "/Sheet1/B2", props: { value: 1 } }]),
      queued.edit("s1", file, [{ op: "set", path: "/Sheet1/B3", props: { value: 2 } }]),
    ]);
    assert.deepEqual(order, ["start", "end", "start", "end"]);
    assert.equal((await queued.changesOf("s1", file)).items.length, 2);
  });
});
