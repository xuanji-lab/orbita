/**
 * 星云气泡状态机的测试（focus-say.ts）。
 */
import { readFileSync } from "node:fs";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { cardPopsAtDone, focusSayOf } from "./focus-say.ts";
import type { FocusStatus, FocusSummary } from "./use-focus.ts";
import type { FocusRun } from "./focus-timer.ts";

const run: FocusRun = { workspaceId: "ws", startedAt: 0, totalMs: 1, endsAt: 1 };
const status = (kind: FocusStatus["kind"]): FocusStatus => ({ kind, run }) as FocusStatus;
const summary = (state: FocusSummary["state"]): FocusSummary =>
  state === "idle"
    ? { state }
    : state === "running"
      ? { state }
      : state === "ready"
        ? { state, bullets: ["a", "b"], sessionsRead: 2, modelLabel: "p/m" }
        : state === "failed"
          ? { state, message: "boom" }
          : { state, reason: "no-activity" };

describe("focusSayOf", () => {
  test("run + idle（还没到 T-5）：不显示", () => {
    assert.deepEqual(focusSayOf(status("run"), summary("idle"), false), { kind: "hidden" });
  });
  test("run + running：转圈那句", () => {
    assert.deepEqual(focusSayOf(status("run"), summary("running"), false), { kind: "running" });
  });
  test("落定各态的句子选择", () => {
    assert.deepEqual(focusSayOf(status("run"), summary("ready"), false), { kind: "settled", line: "ready" });
    assert.deepEqual(focusSayOf(status("run"), summary("failed"), false), { kind: "settled", line: "failed" });
    assert.deepEqual(focusSayOf(status("run"), { state: "none", reason: "no-model" }, false), {
      kind: "settled",
      line: "no-model",
    });
    assert.deepEqual(focusSayOf(status("run"), { state: "none", reason: "no-activity" }, false), {
      kind: "settled",
      line: "no-activity",
    });
  });
  test("点了 x：落定也隐藏；没点不隐藏", () => {
    assert.deepEqual(focusSayOf(status("run"), summary("ready"), true), { kind: "hidden" });
    assert.deepEqual(focusSayOf(status("run"), summary("running"), true), { kind: "hidden" });
  });
  test("ending / done / off 不出这颗气泡（ending 是问询，done 出卡）", () => {
    for (const kind of ["ending", "done", "off"] as const) {
      assert.deepEqual(focusSayOf(status(kind), summary("ready"), false), { kind: "hidden" });
    }
  });
});

describe("cardPopsAtDone", () => {
  test("只在 done 弹；卡自己的关闭键压住；气泡被点掉不影响", () => {
    assert.equal(cardPopsAtDone(status("done"), false), true);
    assert.equal(cardPopsAtDone(status("done"), true), false);
    assert.equal(cardPopsAtDone(status("run"), false), false);
    assert.equal(cardPopsAtDone(status("ending"), false), false);
  });
});

test("气泡里的键要能点：.usage-pet 关了 pointer-events，气泡里的按钮必须开回来", () => {
  const css = readFileSync(new URL("./focus.css", import.meta.url), "utf8");
  assert.match(css, /\.usage-say \.usage-say-act,\s*\.usage-say \.usage-say-x\s*\{\s*pointer-events:\s*auto/);
});

test("工作区选项是 button：必须清掉默认边框，名字单行省略", () => {
  const css = readFileSync(new URL("./focus.css", import.meta.url), "utf8");
  assert.match(css, /\.focus-wsopt \{[^}]*border:\s*0/s);
  assert.match(css, /\.focus-wsopt \.focus-wsopt-name \{[^}]*white-space:\s*nowrap[^}]*text-overflow:\s*ellipsis/s);
});

test("工作区会话行：清默认边框，选中不加描边（只认淡底）", () => {
  const css = readFileSync(new URL("./focus.css", import.meta.url), "utf8");
  assert.match(css, /\.focus-wsrow \{\s*border:\s*0/);
  assert.doesNotMatch(css, /\.focus-wsrow\[data-active[^{]*\{[^}]*outline/);
});

test("左栏文件行复用右栏 .file-row：不许内联 background（会压过悬停与选中）", () => {
  const tsx = readFileSync(new URL("./WorkspaceFiles.tsx", import.meta.url), "utf8");
  assert.equal((tsx.match(/className="file-row focus-frow"/g) ?? []).length, 2, "目录行与文件行都要挂 .file-row");
  assert.equal((tsx.match(/className="file-hover-host"/g) ?? []).length, 2, "两种行都要包 .file-hover-host（悬停底在它的 :hover 上）");
  assert.match(tsx, /aria-selected=\{props\.selected\}/, "选中态走 aria-selected，与右栏同一条规则");
  assert.doesNotMatch(tsx, /background: "transparent"/, "内联 background 会压过 :hover 与选中");
  assert.doesNotMatch(tsx, /import\("@shared/, "禁 inline import");
});

test("胶囊浮层的结束行：标签与动作同一个判据（done || ending → onEnd）", () => {
  const tsx = readFileSync(new URL("./FocusControl.tsx", import.meta.url), "utf8");
  assert.match(tsx, /\{done \|\| ending \? t\.focus\.endFocus : t\.focus\.endEarly\}/);
  assert.match(tsx, /if \(done \|\| ending\) props\.onEnd\(\);\s*else props\.onEarlyEnd\(\);/, "ending 相位显示「结束专注」却调 onEarlyEnd = 空转，退不出专注");
});
