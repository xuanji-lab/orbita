/**
 * 轮尾网页产物的归属（2026-11-17）：只认本会话自己的工具在跑时落盘的文件。
 * 复现用户 11-16 的截图：子会话把示意图网页写进父会话的工作台，父会话这一轮那时没在跑工具（在等、在写回答），
 * 旧逻辑按「mtime ≥ 开轮时刻」把它算成父会话「生成了 2 个网页」。
 */
import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AgentEvent } from "../shared/agent-ipc.ts";
import { TurnFileTracker } from "./file-tracker.ts";
import { reportFileTurn } from "./turn-files.ts";
import { ToolWindows, type ScanRoot } from "./web-artifacts.ts";

async function writeAt(path: string, atMs: number): Promise<void> {
  await writeFile(path, "<html></html>");
  await utimes(path, atMs / 1000, atMs / 1000);
}

describe("ToolWindows：工具在跑的时段", () => {
  it("落在某段里（两头留 2 秒余量）才算；还没结束的调用算到 now", () => {
    const windows = new ToolWindows();
    windows.start("a", 10_000);
    windows.end("a", 20_000);
    windows.start("b", 50_000);
    strictEqual(windows.covers(9_000, 60_000), true);
    strictEqual(windows.covers(21_500, 60_000), true);
    strictEqual(windows.covers(30_000, 60_000), false);
    strictEqual(windows.covers(55_000, 60_000), true);
    strictEqual(new ToolWindows().covers(1, 2), false);
  });
});

describe("reportFileTurn：旁路网页只算本会话自己产的", () => {
  it("子会话在父会话没跑工具时写进父会话工作台的网页，不再挂到父会话；父会话自己脚本生成的照算", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-webown-"));
    try {
      const workbench = join(dir, "workbench");
      await mkdir(join(workbench, "mock-bgstrip"), { recursive: true });
      const turnStart = Date.now() - 600_000;
      // 父会话这一轮：只在 +60s～+70s 跑过一次命令
      const windows = new ToolWindows();
      windows.start("bash-1", turnStart + 60_000);
      windows.end("bash-1", turnStart + 70_000);
      // 子会话在 +240s 写的两张示意图（父会话那时在等）；父会话自己的脚本在 +65s 写的一张
      await writeAt(join(workbench, "mock-bgstrip", "7-firstperson.html"), turnStart + 240_000);
      await writeAt(join(workbench, "mock-bgstrip", "7-subs-after.html"), turnStart + 241_000);
      await writeAt(join(workbench, "own.html"), turnStart + 65_000);
      const roots: ScanRoot[] = [{ root: workbench, maxEntries: 1000 }];
      const events: AgentEvent[] = [];
      await reportFileTurn("s1", new TurnFileTracker(dir), { roots, startedAt: turnStart, windows }, (event) => events.push(event));
      strictEqual(events.length, 1);
      const event = events[0];
      deepStrictEqual(event?.type === "fileTurn" ? event.webArtifacts : null, [join(workbench, "own.html")]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("这一轮一个工具都没跑：工作台里冒出来的网页一个都不算，也不发空的文件账", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-webown-"));
    try {
      const turnStart = Date.now() - 60_000;
      await writeAt(join(dir, "child.html"), turnStart + 10_000);
      const events: AgentEvent[] = [];
      await reportFileTurn("s1", new TurnFileTracker(dir), { roots: [{ root: dir, maxEntries: 100 }], startedAt: turnStart, windows: new ToolWindows() }, (event) => events.push(event));
      strictEqual(events.length, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
