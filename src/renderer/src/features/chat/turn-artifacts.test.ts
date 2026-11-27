/** 产物「点名才算」：主会话结尾摞（foldSegment）与 turnArtifacts 的账；读不了的路径（isReadablePath）。 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { TranscriptItem } from "@earendil-works/pi-protocol";
import { flattenRenderUnits, groupToolUnits, groupTurnsByTurn, indexToolResults, type TurnViewEntry } from "./tool-results.ts";
import { turnArtifacts } from "./turn-artifacts.ts";
import { isReadablePath } from "./chat-paths.ts";
import type { FileRoot } from "../../../../shared/files.ts";

const user = (id: string, timestamp: number): TranscriptItem => ({ id, role: "user", content: [{ type: "text", text: "做点事" }], timestamp }) as TranscriptItem;
const assistant = (id: string, timestamp: number, blocks: unknown[]): TranscriptItem => ({ id, role: "assistant", content: blocks, timestamp }) as TranscriptItem;
const tool = (toolCallId: string, toolName: string, timestamp: number, extra: object = {}): TranscriptItem =>
  ({ id: `item-${toolCallId}`, role: "tool", toolCallId, toolName, input: {}, content: [], timestamp, status: "complete", isError: false, ...extra }) as TranscriptItem;
const call = (id: string, toolName: string, input: unknown = {}) => ({ type: "toolCall", toolCallId: id, toolName, input });
const ledger = (extra: object): TranscriptItem => ({ role: "file-turn", id: "ft1", timestamp: 9, changes: [], ...extra }) as unknown as TranscriptItem;

function outputsOf(records: TranscriptItem[]) {
  const v: TurnViewEntry[] = groupTurnsByTurn(groupToolUnits(flattenRenderUnits(records)), false, indexToolResults(records));
  const out = v.find((e) => e.kind === "turnOutputs");
  return out !== undefined && out.kind === "turnOutputs" ? out : null;
}

const SKILL = "/Users/u/Library/Application Support/orbita/skills/abc/SKILL.md";

describe("8068a0 的形态：顺手 edit 了 SKILL.md，回答里只提「那个 skill」", () => {
  const turn = (answer: string, changes: unknown[] = [{ path: SKILL, added: 2, removed: 1 }]) => [
    user("u1", 1),
    assistant("a1", 2, [call("e1", "edit", { path: SKILL })]),
    tool("e1", "edit", 3),
    assistant("a2", 4, [{ type: "text", text: answer }]),
    ledger({ changes }),
  ];
  test("没点文件名：不出卡", () => {
    assert.equal(outputsOf(turn("我顺手把那个 skill 的说明改了一下。")), null);
  });
  test("点了文件名：出卡", () => {
    const out = outputsOf(turn("我改了 SKILL.md 的说明。"));
    assert.deepEqual(out?.docs, [SKILL]);
  });
});

describe("网页：只留最终回答点了名的", () => {
  const turn = (answer: string, ledgerExtra: object) => [
    user("u1", 1),
    assistant("a1", 2, [call("b1", "bash", { command: "node gen.js" })]),
    tool("b1", "bash", 3),
    assistant("a2", 4, [{ type: "text", text: answer }]),
    ledger(ledgerExtra),
  ];
  test("回答点名了旁路网页 → 出卡", () => {
    assert.deepEqual(outputsOf(turn("页面做好了：proto.html", { webArtifacts: ["/w/out/proto.html"] }))?.web, ["/w/out/proto.html"]);
  });
  test("别的会话同时写的网页没被点名 → 不出卡", () => {
    assert.equal(outputsOf(turn("页面做好了：proto.html", { webArtifacts: ["/w/other-session/demo/index.html"] })), null);
  });
  test("write 写的 html 与 md：点名才出，没点名的不出", () => {
    const out = outputsOf(turn("页面是 a.html。", { changes: [{ path: "/w/a.html", added: 1, removed: 0 }, { path: "/w/b.html", added: 1, removed: 0 }, { path: "/w/n.md", added: 1, removed: 0 }] }));
    assert.deepEqual(out?.web, ["/w/a.html"]);
    assert.deepEqual(out?.docs, []);
  });
  test("过程里的旁白点了名不算（只看最终回答）", () => {
    const records = [
      user("u1", 1),
      assistant("a1", 2, [{ type: "text", text: "先写 draft.md。" }, call("w1", "write", { path: "/w/draft.md" })]),
      tool("w1", "write", 3),
      assistant("a2", 4, [{ type: "text", text: "做完了。" }]),
      ledger({ changes: [{ path: "/w/draft.md", added: 3, removed: 0 }] }),
    ];
    assert.equal(outputsOf(records), null);
  });
});

describe("工具声明的产物照旧全收（不用点名）", () => {
  test("slides_create 的演示文稿没在回答里点名也出卡", () => {
    const records = [
      user("u1", 1),
      assistant("a1", 2, [call("s1", "slides_create", { title: "汇报" })]),
      tool("s1", "slides_create", 3, { details: { card: { kind: "slides", path: "/w/汇报.slides.json", title: "汇报" } } }),
      assistant("a2", 4, [{ type: "text", text: "好了。" }]),
    ];
    assert.ok(outputsOf(records) !== null);
  });
});

describe("turnArtifacts：每条文件账只看它之前那段回答", () => {
  test("两轮各自点名，不串", () => {
    const units = flattenRenderUnits([
      user("u1", 1),
      assistant("a1", 2, [{ type: "text", text: "第一轮出了 one.html。" }]),
      { role: "file-turn", id: "f1", timestamp: 3, changes: [], webArtifacts: ["/w/one.html", "/w/two.html"] } as unknown as TranscriptItem,
      user("u2", 4),
      assistant("a2", 5, [{ type: "text", text: "第二轮出了 two.html。" }]),
      { role: "file-turn", id: "f2", timestamp: 6, changes: [], webArtifacts: ["/w/two.html", "/w/three.html"] } as unknown as TranscriptItem,
    ]);
    const result = turnArtifacts(units);
    assert.deepEqual(result.web, ["/w/one.html", "/w/two.html"]);
    assert.deepEqual(result.edited, []);
  });
});

describe("isReadablePath：读不了的路径不出卡（根清单与文件面板同一套）", () => {
  const roots: FileRoot[] = [
    { kind: "session", label: "s", path: "/wb/s1", exists: true },
    { kind: "workspace", label: "Home", path: "/Users/u/Orbita/Home", exists: true },
    { kind: "attached", label: "gone", path: "/mnt/gone", exists: false },
  ];
  test("在根里 → 可读", () => {
    assert.equal(isReadablePath("/Users/u/Orbita/Home/out/a.html", roots), true);
    assert.equal(isReadablePath("/wb/s1/deck.slides.json", roots), true);
  });
  test("可读根外的文件（被点名也一样）→ 不出卡", () => {
    assert.equal(isReadablePath(SKILL, roots), false);
    assert.equal(isReadablePath("/Users/u/Orbita/Home-evil/a.html", roots), false);
  });
  test("根已不在盘上 → 不出卡；根清单还没取回来 → 先放行", () => {
    assert.equal(isReadablePath("/mnt/gone/a.html", roots), false);
    assert.equal(isReadablePath(SKILL, null), true);
  });
  test("Windows 反斜杠路径也对得上", () => {
    assert.equal(isReadablePath("C:\\Users\\u\\Home\\a.html", [{ kind: "workspace", label: "Home", path: "C:\\Users\\u\\Home", exists: true }]), true);
  });
});
