import assert from "node:assert/strict";
import test from "node:test";
import { allSessions, mobileChat, mobileList, MOBILE_PAGE } from "./fixture.ts";
import { parseMobileOptions } from "./options.ts";

test("没有 surface=mobile 就不是手机设计稿；写错的参数退回确定的画面", () => {
  assert.equal(parseMobileOptions("?scene=full"), null);
  const fallback = parseMobileOptions("?surface=mobile&screen=nope&scene=nope&device=nope&theme=graphite&lang=nope");
  assert.deepEqual(fallback, {
    screen: "list",
    sheetOf: "list",
    scene: "typical",
    pairState: "empty",
    chatState: "typical",
    device: "android",
    theme: "light",
    language: "zh",
    compare: false,
    tall: false,
  });
  const chat = parseMobileOptions("?surface=mobile&screen=chat&state=reply-running&device=ipad&theme=black&compare=desktop");
  assert.equal(chat?.chatState, "reply-running");
  assert.equal(chat?.device, "ipad");
  assert.equal(chat?.theme, "black");
  assert.equal(chat?.compare, true);
  assert.equal(parseMobileOptions("?surface=mobile&screen=pair&state=expired")?.pairState, "expired");
});

test("满载按真实量级：12 个工作区、1973 条根会话、orbita 一晚十几件在跑", () => {
  const full = mobileList("full");
  assert.equal(full.workspaces.length, 12);
  const total = full.workspaces.reduce((sum, ws) => sum + ws.total, 0) + full.looseTotal;
  assert.equal(total, 1973);
  const orbita = full.workspaces.find((ws) => ws.id === "ws-orbita");
  assert.ok((orbita?.sessions.filter((item) => item.state === "running").length ?? 0) >= 12);
  assert.ok(allSessions(full).some((item) => item.subRunning >= 40));
  // 每个工作区第一页至少一页，更早的靠「更早的 N 条」
  for (const ws of full.workspaces) assert.ok(ws.sessions.length >= MOBILE_PAGE && ws.total > ws.sessions.length);
  assert.deepEqual(mobileList("empty").workspaces, []);
});

test("对话稿：满载在跑、读尾部（总条数多于拉到的）；计划稿在等你", () => {
  const full = mobileChat("full");
  assert.equal(full.session.state, "running");
  assert.ok(full.total > full.entries.length);
  assert.equal(full.entries.at(-1)?.kind, "live");
  assert.equal(mobileChat("waiting").session.state, "waiting");
});
