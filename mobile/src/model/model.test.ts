import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { MobileSessionState, SessionSummary, TailEntry } from "../../../src/shared/mobile.ts";
import { applyReplyEvent, mergeLatest, mergeOlder, SENT_KEEP_MS, visibleReplies, type PendingReply } from "./chat.ts";
import { applySessionsChanged, buildList, effective, taskRows, TASK_PAGE } from "./list.ts";
import { ageLabel } from "./time.ts";

const NOW = new Date(2026, 10, 25, 23, 40).getTime();

let seq = 0;
function row(state: MobileSessionState, patch: Partial<SessionSummary> = {}): SessionSummary {
  seq += 1;
  return {
    id: `s${seq}`,
    title: `任务 ${seq}`,
    workspaceId: "ws-orbita",
    workspaceName: "orbita",
    state,
    lastLine: null,
    updatedAt: NOW - seq * 60_000,
    childrenRunning: 0,
    ...patch,
  };
}

const none = { viewed: new Set<string>(), selectedId: null };

describe("清单分组", () => {
  test("四组按 等你 → 在跑 → 跑完没看 → 出错 排；空闲不进组；组里按最近活动排", () => {
    const rows = [row("failed"), row("idle"), row("done"), row("running"), row("waiting"), row("running", { updatedAt: NOW })];
    const model = buildList(rows, none, false);
    assert.deepEqual(model.groups.map((group) => group.id), ["waiting", "running", "done", "failed"]);
    const running = model.groups.find((group) => group.id === "running");
    assert.equal(running?.rows[0]?.updatedAt, NOW);
    assert.deepEqual(model.groups.map((group) => group.cap), [4, 3, 3, 3]);
    assert.equal(model.empty, false);
  });

  test("小屏按屏高收紧上限", () => {
    const model = buildList([row("waiting"), row("running")], none, true);
    assert.deepEqual(model.groups.map((group) => group.cap), [3, 2]);
  });

  test("打开过的跑完没看：选中时不画饼、还在原组；切走后离组；在跑 / 等你不受影响", () => {
    const done = row("done");
    const waiting = row("waiting");
    const viewed = new Set([done.id, waiting.id]);
    assert.deepEqual(effective(done, { viewed, selectedId: done.id }), { pie: null, group: "done" });
    assert.deepEqual(effective(done, { viewed, selectedId: null }), { pie: null, group: null });
    assert.deepEqual(effective(waiting, { viewed, selectedId: null }), { pie: "waiting", group: "waiting" });
  });

  test("工作区按最近活动排；没有工作区的进「任务」组", () => {
    const old = row("idle", { workspaceId: "ws-a", workspaceName: "博士论文", updatedAt: NOW - 10 * 86_400_000 });
    const fresh = row("idle", { workspaceId: "ws-b", workspaceName: "orbita", updatedAt: NOW });
    const loose = row("idle", { workspaceId: null, workspaceName: null });
    const model = buildList([old, fresh, loose], none, false);
    assert.deepEqual(model.workspaces.map((ws) => ws.name), ["orbita", "博士论文"]);
    assert.deepEqual(model.loose.map((item) => item.id), [loose.id]);
    // 工作区名字没了：用 id 兜底
    assert.equal(buildList([row("idle", { workspaceId: "ws-x", workspaceName: null })], none, false).workspaces[0]?.name, "ws-x");
  });

  test("满载量级：200 条里 17 件亮着；工作区展开不重复顶上的，名额给空闲的，其余数成更早的", () => {
    const lit = [
      ...Array.from({ length: 12 }, () => row("running")),
      row("waiting"),
      row("failed"),
      ...Array.from({ length: 3 }, () => row("done")),
    ];
    const idle = Array.from({ length: 183 }, () => row("idle"));
    const model = buildList([...lit, ...idle], none, false);
    const orbita = model.workspaces[0];
    assert.ok(orbita);
    assert.equal(orbita.sessions.length, 200);
    const first = taskRows(orbita.sessions, none, 1);
    assert.deepEqual([first.above, first.rows.length, first.older], [17, TASK_PAGE, 183 - TASK_PAGE]);
    assert.ok(first.rows.every((item) => item.state === "idle"));
    const second = taskRows(orbita.sessions, none, 2);
    assert.equal(second.rows.length, TASK_PAGE * 2);
    // 在跑组 12 件，上限 3：画 3 件 + 「还有 9 件」
    const running = model.groups.find((group) => group.id === "running");
    assert.equal((running?.rows.length ?? 0) - (running?.cap ?? 0), 9);
  });

  test("sessions.changed：覆盖、新增、删除", () => {
    const a = row("idle");
    const b = row("idle");
    const next = applySessionsChanged(new Map([[a.id, a], [b.id, b]]), [{ ...a, state: "running" }, row("waiting")], [b.id]);
    assert.equal(next.size, 2);
    assert.equal(next.get(a.id)?.state, "running");
    assert.equal(next.has(b.id), false);
  });
});

describe("对话尾部", () => {
  const entry = (id: string): TailEntry => ({ id, at: 1, kind: "assistant", text: id });

  test("最新一页替换旧尾巴；往上翻过的更早几页留着", () => {
    const loaded = { entries: ["a", "b", "c", "d"].map(entry), hasMore: true, rev: 1 };
    const latest = { entries: ["c", "d", "e"].map(entry), hasMore: true, rev: 2 };
    assert.deepEqual(mergeLatest(loaded, latest).entries.map((item) => item.id), ["a", "b", "c", "d", "e"]);
    // 接不上：只留最新页
    const far = { entries: ["x", "y"].map(entry), hasMore: true, rev: 3 };
    assert.deepEqual(mergeLatest(loaded, far).entries.map((item) => item.id), ["x", "y"]);
    assert.deepEqual(mergeLatest(null, far), far);
  });

  test("更早一页接在前面、去重，hasMore 跟着新页", () => {
    const current = { entries: ["c", "d"].map(entry), hasMore: true, rev: 1 };
    const older = { entries: ["a", "b", "c"].map(entry), hasMore: false, rev: 1 };
    const merged = mergeOlder(current, older);
    assert.deepEqual(merged.entries.map((item) => item.id), ["a", "b", "c", "d"]);
    assert.equal(merged.hasMore, false);
  });
});

describe("回一句的排队条", () => {
  const base: PendingReply = { requestId: "r1", sessionId: "s", text: "先别动 README", at: NOW, status: "sending" };

  test("排上了留灰条；直接发了收起；sent 之后迟到的 failed 照样变红", () => {
    const queued = applyReplyEvent([base], { kind: "accepted", requestId: "r1", queued: true }, NOW);
    assert.equal(queued[0]?.status, "queued");
    assert.equal(visibleReplies(queued, "s").length, 1);
    const sent = applyReplyEvent(queued, { kind: "sent", requestId: "r1" }, NOW);
    assert.equal(visibleReplies(sent, "s").length, 0);
    const late = applyReplyEvent(sent, { kind: "failed", requestId: "r1", error: { code: "internal", message: "这一轮没跑成" } }, NOW + 1000);
    assert.equal(visibleReplies(late, "s")[0]?.status, "failed");
    // 失败之后再来的 sent 不盖掉失败
    assert.equal(applyReplyEvent(late, { kind: "sent", requestId: "r1" }, NOW)[0]?.status, "failed");
    assert.deepEqual(applyReplyEvent(late, { kind: "dismiss", requestId: "r1" }, NOW), []);
  });

  test("直接发了的那条留 10 分钟等迟到的失败，过了就清掉", () => {
    const sent = applyReplyEvent([base], { kind: "accepted", requestId: "r1", queued: false }, NOW);
    assert.equal(sent.length, 1);
    assert.equal(applyReplyEvent(sent, { kind: "dismiss", requestId: "other" }, NOW + SENT_KEEP_MS).length, 0);
  });
});

test("行尾时间与桌面同一口径", () => {
  assert.equal(ageLabel(NOW - 30_000, NOW), "刚刚");
  assert.equal(ageLabel(NOW - 48 * 60_000, NOW), "48 分钟");
  assert.equal(ageLabel(NOW - 3 * 3_600_000, NOW), "3 小时");
  assert.equal(ageLabel(new Date(2026, 10, 24, 23, 0).getTime(), NOW), "昨天");
  assert.equal(ageLabel(new Date(2026, 10, 20, 9, 0).getTime(), NOW), "5 天");
  assert.equal(ageLabel(new Date(2026, 9, 1, 9, 0).getTime(), NOW), "10-01");
  assert.equal(ageLabel(new Date(2025, 9, 1, 9, 0).getTime(), NOW), "2025-10-01");
});
