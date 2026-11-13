import { deepStrictEqual } from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { PanelUsageStore } from "./store.ts";

const dirs: string[] = [];
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "panel-usage-"));
  dirs.push(dir);
  return join(dir, "panel-usage.json");
}
after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("PanelUsageStore", () => {
  it("文件不在：从现在开始数；连着记两次不丢账，落盘的就是那份", async () => {
    const file = await scratch();
    const store = new PanelUsageStore(file, () => 42);
    deepStrictEqual(await store.get(), { since: 42, counts: {} });
    await Promise.all([store.bump("task"), store.bump("task"), store.bump("review")]);
    deepStrictEqual(await store.get(), { since: 42, counts: { task: 2, review: 1 } });
    deepStrictEqual(JSON.parse(await readFile(file, "utf8")), { since: 42, counts: { task: 2, review: 1 } });
  });

  it("重启后接着数（新实例读盘）", async () => {
    const file = await scratch();
    await new PanelUsageStore(file, () => 7).bump("terminal");
    const again = new PanelUsageStore(file, () => 99);
    await again.bump("terminal");
    deepStrictEqual(await again.get(), { since: 7, counts: { terminal: 2 } });
  });

  it("坏文件：从现在重新数，下一次记账把它覆盖掉", async () => {
    const file = await scratch();
    await writeFile(file, "{ not json", "utf8");
    const store = new PanelUsageStore(file, () => 5);
    await store.bump("bell");
    deepStrictEqual(JSON.parse(await readFile(file, "utf8")), { since: 5, counts: { bell: 1 } });
  });
});
