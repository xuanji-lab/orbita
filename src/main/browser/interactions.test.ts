import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { describeScroll, typingFailure, type ScrollState } from "./interactions.ts";

const state = (top: number, extra: Partial<ScrollState> = {}): ScrollState => ({
  top,
  left: 0,
  height: 5000,
  width: 1100,
  viewHeight: 1000,
  viewWidth: 1100,
  page: true,
  label: "",
  ...extra,
});

describe("describeScroll", () => {
  test("报位置与百分比；到底时说到底了", () => {
    assert.equal(describeScroll(state(0), state(800), "down"), "Scrolled the page down: now 20% down (800 of 4000 px).");
    assert.equal(describeScroll(state(3500), state(4000), "down"), "Scrolled the page down: now 100% down (4000 of 4000 px) — reached the bottom.");
    assert.equal(describeScroll(state(800), state(0), "up"), "Scrolled the page up: now 0% down (0 of 4000 px) — back at the start.");
  });

  test("没动：说明可能已在尽头，或者要滚的是另一个面板", () => {
    const text = describeScroll(state(4000), state(4000), "down");
    assert.match(text, /^Nothing moved: the page is already at the bottom/);
    assert.match(text, /pass ref or x\/y/);
  });

  test("面板：带上面板的描述", () => {
    const panel = { page: false, label: '<div#results> "Results"', height: 3000, viewHeight: 600 };
    assert.equal(
      describeScroll(state(0, panel), state(480, panel), "down"),
      'Scrolled the panel <div#results> "Results" down: now 20% down (480 of 2400 px).',
    );
  });

  test("横向：按宽度算", () => {
    const wide = { width: 3100, viewWidth: 1100 };
    assert.equal(
      describeScroll(state(0, { ...wide, left: 0 }), state(0, { ...wide, left: 1000 }), "right"),
      "Scrolled the page right: now 50% across (1000 of 2000 px).",
    );
  });
});

describe("typingFailure", () => {
  test("成功回 null", () => {
    assert.equal(typingFailure({ kind: "field", label: "<input>" }, "e3"), null);
  });

  test("密码框：指给模型 request_user_action，绝不自己输凭据", () => {
    const text = typingFailure({ error: "password", label: '<input[type=password]> "Password"' }, "e7");
    assert.match(String(text), /^e7 <input\[type=password\]> "Password" is a password field/);
    assert.match(String(text), /request_user_action/);
  });

  test("其它失败各有能指导下一步的说法", () => {
    assert.match(String(typingFailure({ error: "nothing" }, "the focused element")), /click the field first/);
    assert.match(String(typingFailure({ error: "not-editable", label: "<div>" }, "e2")), /not a text field/);
    assert.match(String(typingFailure({ error: "readonly" }, "e2")), /read-only/);
    assert.match(String(typingFailure({ error: "gone" }, "e2")), /browser_observe again/);
  });
});
