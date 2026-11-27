/**
 * 会话授权的 IPC 通路（四层里的 1 → 2 → 3）：共享通道常量、主进程 handler、preload 面
 * 三处用的是同一个常量，且 handler 的洗白规则真的生效。
 *
 * `ipc.ts` 静态引 electron，node --test 里只能把它换成替身（只记下每个 handler 与 preload
 * 发出的 invoke）——quota-ipc.test.ts 同款做法。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import { computerUseChannels } from "../../shared/computer-use.ts";
import { ipcChannels } from "../../shared/agent-ipc.ts";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const invoked: Array<{ channel: string; args: unknown[] }> = [];
mock.module("electron", {
  namedExports: {
    ipcMain: {
      handle: (channel: string, handler: (...args: unknown[]) => unknown) => void handlers.set(channel, handler),
      on: () => undefined,
    },
    ipcRenderer: {
      invoke: async (channel: string, ...args: unknown[]) => {
        invoked.push({ channel, args });
        return undefined;
      },
      on: () => undefined,
      removeListener: () => undefined,
    },
    // 依赖链在加载时要见到这些名字；本用例用不到它们的行为
    shell: {},
    app: {},
    utilityProcess: {},
    BrowserWindow: {},
    dialog: {},
  },
});

const { registerComputerUseIpc } = await import("./ipc.ts");
const { registerSessionIpc } = await import("../session/ipc.ts");
const { sessionApi } = await import("../../preload/api/session.ts");
const { computerUseApi } = await import("../../preload/api/computer-use.ts");

const controller = {
  probe: async () => ({}) as never,
  status: () => ({ state: "off" }) as never,
  start: async () => ({ ok: true }) as never,
  stop: async () => ({ ok: true }) as never,
  screenshot: async () => ({ ok: true }) as never,
};

/** 一套最小依赖：本文件只碰「授权」那两个 handler，别的路径不会被调用 */
function registerSessionMinimal(): { writes: Array<[string, string]> } {
  const writes: Array<[string, string]> = [];
  const store = {
    setComputerUseConsent: async (id: string, consent: string) => {
      writes.push([id, consent]);
    },
  };
  registerSessionIpc(
    store as never,
    undefined,
    {} as never,
    {} as never,
    async () => ({ ok: false, reason: "unused" }) as never,
    async () => ({ moved: [], skipped: [] }) as never,
    { digests: async () => ({}) } as never,
  );
  return { writes };
}

test("回答通道：allowed / denied 转给挂起表；坏载荷与陈旧号一律丢弃", () => {
  const answered: Array<[string, boolean]> = [];
  registerComputerUseIpc(controller as never, {}, undefined, undefined, {
    answer: (requestId, decision) => {
      answered.push([requestId, decision === "allowed"]);
      return requestId === "s1:consent:1";
    },
  });
  const handler = handlers.get(computerUseChannels.computerUseConsentAnswer);
  assert.ok(handler !== undefined, "主进程注册了 computer-use:consent-answer");

  handler(undefined, "s1:consent:1", "allowed");
  handler(undefined, "s1:consent:2", "denied");
  // 坏载荷：不是两个字符串之一 → 不转交（绝不能被当成「允许」）
  handler(undefined, "s1:consent:3", "ALLOW");
  handler(undefined, "s1:consent:3", true);
  handler(undefined, "", "allowed");
  handler(undefined, 42, "allowed");
  assert.deepEqual(answered, [
    ["s1:consent:1", true],
    ["s1:consent:2", false],
  ]);
});

test("会话字段通道：只写 unset（撤销），落盘后 handler 正常返回", async () => {
  const { writes } = registerSessionMinimal();
  const handler = handlers.get(ipcChannels.sessionSetComputerUseConsent);
  assert.ok(handler !== undefined, "主进程注册了 session:set-computer-use-consent");
  // 就算 renderer 传了别的值，也只会落 unset——这条通路不能把字段调成 allowed
  await handler(undefined, "s1", "allowed");
  await handler(undefined, "s1", "whatever");
  assert.deepEqual(writes, [
    ["s1", "unset"],
    ["s1", "unset"],
  ]);
});

test("preload 面：撤销与回答都走共享通道常量（第 3 层与第 1 层对得上）", async () => {
  await sessionApi.setComputerUseConsent("s1");
  await computerUseApi.answerConsent("s1:consent:1", "allowed");
  assert.deepEqual(invoked, [
    { channel: ipcChannels.sessionSetComputerUseConsent, args: ["s1", "unset"] },
    { channel: computerUseChannels.computerUseConsentAnswer, args: ["s1:consent:1", "allowed"] },
  ]);
});
