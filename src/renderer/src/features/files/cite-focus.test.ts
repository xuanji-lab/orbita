import { deepStrictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { decideCiteFocus, type CiteFocusRequest } from "./cite-focus.ts";
import type { FileRoot } from "@shared/files";

/**
 * citeFocus 请求的消费裁决（cite-focus.ts）。重点覆盖 2026-10-18 修的跨会话误报：
 * A 会话点开的引用 PDF，切到 B 后（面板重挂、consumedCiteRef 归零）不得对 B 的根
 * 报 citeOutside；而「在当前会话里点了一个确实在外面的 PDF」必须照常提示。
 */

const root = (path: string, exists = true): FileRoot => ({
  kind: "workspace",
  label: path,
  path,
  exists,
});

const request = (session: string | null, path: string, token = 1): CiteFocusRequest => ({
  session,
  token,
  citation: { id: "c001", path, page: 1, start: 0, end: 10, text: "…" },
});

describe("decideCiteFocus：跨会话隔离（修复主路径）", () => {
  it("A 会话的请求在 B 会话下判作废：不报错、不打开、消费掉", () => {
    const outcome = decideCiteFocus({
      request: request("session-a", "/outside/Lan-2020.pdf"),
      consumedToken: null,
      session: "session-b",
      roots: [root("/Users/x/ws")],
      attachmentsRoot: null,
      rootsLoading: false,
    });
    deepStrictEqual(outcome, { kind: "drop" });
  });

  it("会话戳为 null 的请求（还没有会话时点的）在打开会话后同样作废", () => {
    const outcome = decideCiteFocus({
      request: request(null, "/Users/x/ws/a.pdf"),
      consumedToken: null,
      session: "session-b",
      roots: [root("/Users/x/ws")],
      attachmentsRoot: null,
      rootsLoading: false,
    });
    deepStrictEqual(outcome, { kind: "drop" });
  });

  it("drop 也算消费：同一条请求不会再被重放（回到 A 也不重开标签）", () => {
    const req = request("session-a", "/outside/Lan-2020.pdf");
    const base = {
      consumedToken: null,
      session: "session-b",
      roots: [root("/Users/x/ws")],
      attachmentsRoot: null,
      rootsLoading: false,
    } as const;
    deepStrictEqual(decideCiteFocus({ request: req, ...base }), { kind: "drop" });
    // 调用方在 drop 时记下 token；下一轮（比如换回 A、面板重挂）拿已消费的 token 再问
    deepStrictEqual(
      decideCiteFocus({ request: req, ...base, consumedToken: req.token, session: "session-a" }),
      { kind: "idle" },
    );
  });
});

describe("decideCiteFocus：当前会话里的正常路径", () => {
  it("路径落在当前会话的根内：开标签并给出宿主根", () => {
    const outcome = decideCiteFocus({
      request: request("session-a", "/Users/x/ws/papers/Lan-2020.pdf"),
      consumedToken: null,
      session: "session-a",
      roots: [root("/tmp/workbench"), root("/Users/x/ws")],
      attachmentsRoot: null,
      rootsLoading: false,
    });
    deepStrictEqual(outcome, { kind: "open", root: "/Users/x/ws" });
  });

  it("不进树的附件副本根也是合法宿主", () => {
    const outcome = decideCiteFocus({
      request: request("session-a", "/attachments/Lan-2020.pdf"),
      consumedToken: null,
      session: "session-a",
      roots: [root("/Users/x/ws")],
      attachmentsRoot: root("/attachments"),
      rootsLoading: false,
    });
    deepStrictEqual(outcome, { kind: "open", root: "/attachments" });
  });

  it("在当前会话点了一个确实在外面的 PDF：照常报 citeOutside", () => {
    const outcome = decideCiteFocus({
      request: request("session-b", "/Users/elsewhere/Lan-2020.pdf"),
      consumedToken: null,
      session: "session-b",
      roots: [root("/Users/x/ws")],
      attachmentsRoot: null,
      rootsLoading: false,
    });
    deepStrictEqual(outcome, { kind: "outside" });
  });

  it("路径只做了前缀碰瓷（/ws-2 不是 /ws 之内）不算命中", () => {
    const outcome = decideCiteFocus({
      request: request("session-b", "/ws-2/Lan-2020.pdf"),
      consumedToken: null,
      session: "session-b",
      roots: [root("/ws")],
      attachmentsRoot: null,
      rootsLoading: false,
    });
    deepStrictEqual(outcome, { kind: "outside" });
  });

  it("盘上已不在（exists=false）的根不收留任何路径", () => {
    const outcome = decideCiteFocus({
      request: request("session-b", "/gone/Lan-2020.pdf"),
      consumedToken: null,
      session: "session-b",
      roots: [root("/gone", false), root("/Users/x/ws")],
      attachmentsRoot: null,
      rootsLoading: false,
    });
    deepStrictEqual(outcome, { kind: "outside" });
  });

  it("根清单还在加载：先不定论（wait，不消费）", () => {
    const outcome = decideCiteFocus({
      request: request("session-b", "/Users/elsewhere/Lan-2020.pdf"),
      consumedToken: null,
      session: "session-b",
      roots: [],
      attachmentsRoot: null,
      rootsLoading: true,
    });
    deepStrictEqual(outcome, { kind: "wait" });
    // 同一条请求等根回来后（token 未消费）再判，仍能落到 outside / open
    deepStrictEqual(
      decideCiteFocus({
        request: request("session-b", "/Users/elsewhere/Lan-2020.pdf"),
        consumedToken: null,
        session: "session-b",
        roots: [root("/Users/x/ws")],
        attachmentsRoot: null,
        rootsLoading: false,
      }),
      { kind: "outside" },
    );
  });
});

describe("decideCiteFocus：与右栏按会话记忆的配合", () => {
  it("A 点开引用后切走，B 恢复文件面板：旧请求（戳 A）在 B 下作废，不开标签也不报错", () => {
    deepStrictEqual(
      decideCiteFocus({
        request: request("session-a", "/Users/x/ws/Lan-2020.pdf"),
        consumedToken: null,
        session: "session-b",
        roots: [root("/Users/x/ws")],
        attachmentsRoot: null,
        rootsLoading: false,
      }),
      { kind: "drop" },
    );
  });

  it("回到 A 恢复文件面板：请求已随面板关闭被 App 清掉（request=null）→ idle，不重放跳转", () => {
    deepStrictEqual(
      decideCiteFocus({
        request: null,
        consumedToken: null,
        session: "session-a",
        roots: [root("/Users/x/ws")],
        attachmentsRoot: null,
        rootsLoading: false,
      }),
      { kind: "idle" },
    );
  });
});

describe("decideCiteFocus：一次性请求的基本守卫", () => {
  it("没有请求：idle", () => {
    deepStrictEqual(
      decideCiteFocus({
        request: null,
        consumedToken: null,
        session: "session-a",
        roots: [root("/Users/x/ws")],
        attachmentsRoot: null,
        rootsLoading: false,
      }),
      { kind: "idle" },
    );
  });

  it("token 已消费（连点同一条后重挂重放）：idle，不重开标签", () => {
    const req = request("session-a", "/Users/x/ws/a.pdf", 7);
    deepStrictEqual(
      decideCiteFocus({
        request: req,
        consumedToken: 7,
        session: "session-a",
        roots: [root("/Users/x/ws")],
        attachmentsRoot: null,
        rootsLoading: false,
      }),
      { kind: "idle" },
    );
  });
});
