/**
 * browser_wait_for 的纯逻辑：夹取、命中判定、探针脚本、正文排版。
 * 等待本身在主进程（main/browser/agent-requests.ts），这里只测不用起浏览器的部分。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  clampWaitTimeout,
  describeWaitTarget,
  formatWaitResult,
  parseWaitSample,
  parseWaitSpec,
  waitProbeScript,
  waitSampleHit,
  waitUntilHit,
  WAIT_DEFAULT_TIMEOUT_MS,
  WAIT_MAX_TIMEOUT_MS,
  WAIT_MIN_TIMEOUT_MS,
  WAIT_POLL_MS,
} from "./browser-wait.ts";

describe("parseWaitSpec", () => {
  test("selector 与 text 至少给一个；都缺省（含只有空白）当场报错", () => {
    assert.deepEqual(parseWaitSpec({}), {
      ok: false,
      error: "Pass selector or text — at least one of them says what to wait for.",
    });
    assert.equal(parseWaitSpec({ selector: "   ", text: "\t\n" }).ok, false);
    assert.equal(parseWaitSpec({ selector: 3, text: null }).ok, false);
  });

  test("去掉首尾空白；只给一个时另一个不出现在 spec 里（缺席 = 不问这个条件）", () => {
    assert.deepEqual(parseWaitSpec({ selector: " #results " }), {
      ok: true,
      spec: { selector: "#results", visible: false, timeoutMs: WAIT_DEFAULT_TIMEOUT_MS },
      note: null,
    });
    assert.deepEqual(parseWaitSpec({ text: " 3 results " }), {
      ok: true,
      spec: { text: "3 results", visible: false, timeoutMs: WAIT_DEFAULT_TIMEOUT_MS },
      note: null,
    });
    assert.deepEqual(parseWaitSpec({ selector: "#r", text: "3 results", visible: true, timeoutMs: 1500 }), {
      ok: true,
      spec: { selector: "#r", text: "3 results", visible: true, timeoutMs: 1500 },
      note: null,
    });
  });

  test("visible 只在明确 true 时为真", () => {
    const spec = (visible: unknown) => {
      const parsed = parseWaitSpec({ selector: "#r", visible });
      return parsed.ok ? parsed.spec.visible : null;
    };
    assert.equal(spec(true), true);
    assert.equal(spec("true"), false);
    assert.equal(spec(1), false);
    assert.equal(spec(undefined), false);
  });
});

describe("clampWaitTimeout", () => {
  test("不给 / 认不出来 → 默认 8 秒", () => {
    for (const value of [undefined, null, "", "abc", NaN, Infinity, {}]) {
      assert.deepEqual(clampWaitTimeout(value), { timeoutMs: WAIT_DEFAULT_TIMEOUT_MS, note: null });
    }
  });

  test("超上限截断到 30 秒并说明；低于下限抬到 100ms；字符串数字照认", () => {
    assert.deepEqual(clampWaitTimeout(999_999), {
      timeoutMs: WAIT_MAX_TIMEOUT_MS,
      note: `timeoutMs was capped at ${WAIT_MAX_TIMEOUT_MS}`,
    });
    assert.equal(clampWaitTimeout(0).timeoutMs, WAIT_MIN_TIMEOUT_MS);
    assert.equal(clampWaitTimeout(-5).timeoutMs, WAIT_MIN_TIMEOUT_MS);
    assert.equal(clampWaitTimeout(0).note, `timeoutMs was raised to ${WAIT_MIN_TIMEOUT_MS}`);
    assert.deepEqual(clampWaitTimeout("5000"), { timeoutMs: 5000, note: null });
    assert.deepEqual(clampWaitTimeout(1500.4), { timeoutMs: 1500, note: null });
    assert.equal(clampWaitTimeout(WAIT_MAX_TIMEOUT_MS).note, null);
  });
});

describe("waitSampleHit", () => {
  test("给了哪个条件就按哪个判；两个都给了任一命中即为命中", () => {
    const both = parseWaitSpec({ selector: "#r", text: "3 results" });
    assert.ok(both.ok);
    assert.equal(waitSampleHit({ selector: true, text: false }, both.spec), true);
    assert.equal(waitSampleHit({ selector: false, text: true }, both.spec), true);
    assert.equal(waitSampleHit({ selector: false, text: false }, both.spec), false);
    assert.equal(waitSampleHit({ selector: true, text: true }, both.spec), true);
  });

  test("没问的条件即使页面上为真也不算命中", () => {
    const selectorOnly = parseWaitSpec({ selector: "#r" });
    const textOnly = parseWaitSpec({ text: "3 results" });
    assert.ok(selectorOnly.ok && textOnly.ok);
    assert.equal(waitSampleHit({ selector: false, text: true }, selectorOnly.spec), false);
    assert.equal(waitSampleHit({ selector: true, text: false }, textOnly.spec), false);
  });
});

describe("waitProbeScript", () => {
  const specOf = (input: Parameters<typeof parseWaitSpec>[0]) => {
    const parsed = parseWaitSpec(input);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.spec;
  };

  /**
   * 极小的假 DOM：探针脚本只用得上 querySelectorAll / getBoundingClientRect /
   * getComputedStyle / document.body.innerText。脚本是模板拼出来的，这里真跑一遍——
   * 只做字符串断言的话，页内那句拼错要到真浏览器验收才现形。
   */
  const runProbe = (
    input: Parameters<typeof parseWaitSpec>[0],
    page: { nodes?: { width: number; height: number; visibility?: string }[]; text?: string; badSelector?: boolean },
  ): unknown => {
    const nodes = (page.nodes ?? []).map((node) => ({
      ...node,
      getBoundingClientRect: () => ({ width: node.width, height: node.height }),
    }));
    const documentStub = {
      body: { innerText: page.text ?? "" },
      querySelectorAll: (): unknown => {
        if (page.badSelector === true) throw new Error("SyntaxError: invalid selector");
        return nodes;
      },
    };
    const styleOf = (node: { visibility?: string }): { visibility: string } => ({
      visibility: node.visibility ?? "visible",
    });
    const body = `return ${waitProbeScript(specOf(input))}`;
    return new Function("document", "getComputedStyle", body)(documentStub, styleOf) as unknown;
  };

  test("页内真跑：选择器存在即命中；没有匹配就是没到", () => {
    assert.deepEqual(runProbe({ selector: "#r" }, { nodes: [{ width: 10, height: 10 }] }), {
      selector: true,
      text: null,
    });
    assert.deepEqual(runProbe({ selector: "#r" }, { nodes: [] }), { selector: false, text: null });
  });

  test("页内真跑：visible 要求非零包围盒且不是 visibility:hidden；第一个匹配藏了就看下一个", () => {
    assert.deepEqual(runProbe({ selector: "#r", visible: true }, { nodes: [{ width: 0, height: 10 }] }), {
      selector: false,
      text: null,
    });
    assert.deepEqual(
      runProbe({ selector: "#r", visible: true }, { nodes: [{ width: 10, height: 10, visibility: "hidden" }] }),
      { selector: false, text: null },
    );
    assert.deepEqual(
      runProbe(
        { selector: "#r", visible: true },
        { nodes: [{ width: 0, height: 0 }, { width: 10, height: 10 }] },
      ),
      { selector: true, text: null },
    );
    // 不要 visible 时，第一个匹配藏不藏都算存在
    assert.deepEqual(runProbe({ selector: "#r" }, { nodes: [{ width: 0, height: 0 }] }), {
      selector: true,
      text: null,
    });
  });

  test("页内真跑：文字看正文；两个条件各自回答；选择器非法回错误码", () => {
    assert.deepEqual(runProbe({ text: "3 results" }, { text: "found 3 results here" }), {
      selector: null,
      text: true,
    });
    assert.deepEqual(runProbe({ text: "3 results" }, { text: "nothing" }), { selector: null, text: false });
    assert.deepEqual(runProbe({ selector: "#r", text: "3 results" }, { nodes: [], text: "3 results" }), {
      selector: false,
      text: true,
    });
    assert.deepEqual(runProbe({ selector: "#r" }, { badSelector: true }), { error: "invalid-selector" });
  });

  test("选择器与文字以 JSON 字面量嵌入——带引号的选择器不会串成代码", () => {
    const script = waitProbeScript(specOf({ selector: 'a[title="x"]', text: 'say "hi"' }));
    assert.ok(script.includes('const selector = "a[title=\\"x\\"]";'));
    assert.ok(script.includes('const text = "say \\"hi\\"";'));
    // 没问的条件是 null，页内不会去碰它
    const selectorOnly = waitProbeScript(specOf({ selector: "#r" }));
    assert.ok(selectorOnly.includes("const text = null;"));
  });

  test("visible 决定是否量包围盒；两个检查各自被条件守住（没问的条件不执行）", () => {
    assert.ok(waitProbeScript(specOf({ selector: "#r", visible: true })).includes("const needVisible = true;"));
    assert.ok(waitProbeScript(specOf({ selector: "#r" })).includes("const needVisible = false;"));
    const selectorOnly = waitProbeScript(specOf({ selector: "#r" }));
    assert.ok(selectorOnly.includes("if (selector !== null)"));
    assert.ok(selectorOnly.includes("if (text !== null) out.text"));
  });
});

describe("parseWaitSample", () => {
  test("两个条件各自认成三态；错误码与垃圾回值分开处理", () => {
    assert.deepEqual(parseWaitSample({ selector: true, text: null }), { selector: true, text: null });
    assert.deepEqual(parseWaitSample({ selector: false, text: true }), { selector: false, text: true });
    assert.deepEqual(parseWaitSample({ error: "invalid-selector" }), { error: "invalid-selector" });
    assert.equal(parseWaitSample(null), null);
    assert.equal(parseWaitSample("nope"), null);
    assert.equal(parseWaitSample({}), null);
  });
});

describe("formatWaitResult", () => {
  const page = { url: "https://example.com/search", title: "Search" };

  test("等到：说清是什么、多久、在哪，并指向下一步", () => {
    const parsed = parseWaitSpec({ selector: "#results", visible: true, timeoutMs: 10_000 });
    assert.ok(parsed.ok);
    const text = formatWaitResult(page, parsed.spec, { hit: true, elapsedMs: 1240 });
    assert.match(text, /^#results \(visible\) appeared after 1\.2s on https:\/\/example\.com\/search — "Search"\./);
    assert.match(text, /browser_observe/);
  });

  test("没等到：不算错误，带上等了多久与可选的下一步；夹取说明附在末尾", () => {
    const parsed = parseWaitSpec({ text: "3 results", timeoutMs: 999_999 });
    assert.ok(parsed.ok);
    const text = formatWaitResult(page, parsed.spec, { hit: false, elapsedMs: 30_050 }, parsed.note);
    assert.match(text, /the text "3 results" did not appear within 30s on/);
    assert.match(text, /not an error/);
    assert.match(text, /timeoutMs was capped at 30000\.$/);
  });
});

describe("waitUntilHit", () => {
  const specOf = (input: Parameters<typeof parseWaitSpec>[0]) => {
    const parsed = parseWaitSpec(input);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.spec;
  };

  test("探针第一次就说到了：不等就返回（不先睡一个轮询间隔）", async () => {
    const outcome = await waitUntilHit(async () => ({ selector: true, text: null }), specOf({ selector: "#r" }));
    assert.ok(!("error" in outcome));
    assert.equal(outcome.hit, true);
    assert.ok(outcome.elapsedMs < WAIT_POLL_MS, `elapsed=${outcome.elapsedMs}`);
  });

  test("先没到、后到了：中间睡过轮询间隔，命中即返回", async () => {
    let calls = 0;
    const outcome = await waitUntilHit(async () => {
      calls += 1;
      return { selector: calls >= 3, text: null };
    }, specOf({ selector: "#r", timeoutMs: 5000 }));
    assert.ok(!("error" in outcome));
    assert.equal(outcome.hit, true);
    assert.equal(calls, 3);
    assert.ok(outcome.elapsedMs >= 2 * WAIT_POLL_MS - 20, `elapsed=${outcome.elapsedMs}`);
  });

  test("一直没到：到点返回未命中（不是错误），不再多探一轮", async () => {
    let calls = 0;
    const outcome = await waitUntilHit(async () => {
      calls += 1;
      return { selector: false, text: null };
    }, specOf({ selector: "#r", timeoutMs: WAIT_MIN_TIMEOUT_MS }));
    assert.ok(!("error" in outcome));
    assert.equal(outcome.hit, false);
    assert.ok(outcome.elapsedMs >= WAIT_MIN_TIMEOUT_MS, `elapsed=${outcome.elapsedMs}`);
    // 100ms 的等待只够一两轮探针：没有忙等
    assert.ok(calls <= 3, `calls=${calls}`);
  });

  test("探针没答上来（换文档 / 崩了）不算结果，下一轮接着探", async () => {
    let calls = 0;
    const outcome = await waitUntilHit(async () => {
      calls += 1;
      return calls === 1 ? null : { text: true, selector: null };
    }, specOf({ text: "3 results", timeoutMs: 5000 }));
    assert.ok(!("error" in outcome));
    assert.equal(outcome.hit, true);
    assert.equal(calls, 2);
  });

  test("选择器非法：立即返回错误，不等超时", async () => {
    const outcome = await waitUntilHit(async () => ({ error: "invalid-selector" }), specOf({ selector: "#r", timeoutMs: 30_000 }));
    assert.deepEqual(outcome, { error: "invalid-selector" });
  });
});

describe("describeWaitTarget", () => {
  test("两个条件用 or 连起来——两个都给了就是任一命中", () => {
    const parsed = parseWaitSpec({ selector: "#r", text: "3 results" });
    assert.ok(parsed.ok);
    assert.equal(describeWaitTarget(parsed.spec), '#r or the text "3 results"');
  });
});
