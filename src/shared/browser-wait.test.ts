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
  probeTimeoutMs,
  waitProbeScript,
  waitSampleHit,
  waitSelectorInvalidFallback,
  waitUntilHit,
  WAIT_DEFAULT_TIMEOUT_MS,
  WAIT_MAX_TIMEOUT_MS,
  WAIT_MIN_TIMEOUT_MS,
  WAIT_POLL_MS,
  WAIT_PROBE_TIMEOUT_FLOOR_MS,
  WAIT_PROBE_TIMEOUT_MS,
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

  test("只给 text 时 visible 没有作用对象：note 里说明忽略，不静默吞掉", () => {
    const parsed = parseWaitSpec({ text: "3 results", visible: true });
    assert.ok(parsed.ok);
    assert.equal(parsed.note, "visible applies to selector only — the text condition already matches visible text");
    // 已有夹取说明时拼在同一条 note 里，顺序：先说的在前
    const capped = parseWaitSpec({ text: "3 results", visible: true, timeoutMs: 999_999 });
    assert.ok(capped.ok);
    assert.equal(
      capped.note,
      "timeoutMs was capped at 30000; visible applies to selector only — the text condition already matches visible text",
    );
    // 有 selector 时 visible 正常生效，不产生 note
    const withSelector = parseWaitSpec({ selector: "#r", visible: true });
    assert.ok(withSelector.ok);
    assert.equal(withSelector.note, null);
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

describe("probeTimeoutMs：每轮探针夹到剩余时间（broker 余量对得上）", () => {
  const now = 1_000_000;

  test("剩余充足时用单命令上限", () => {
    assert.equal(probeTimeoutMs(now + 20_000, now), WAIT_PROBE_TIMEOUT_MS);
    assert.equal(probeTimeoutMs(now + WAIT_PROBE_TIMEOUT_MS, now), WAIT_PROBE_TIMEOUT_MS);
  });

  test("剩余不足时用剩余时间", () => {
    assert.equal(probeTimeoutMs(now + 1_500, now), 1_500);
    assert.equal(probeTimeoutMs(now + WAIT_PROBE_TIMEOUT_FLOOR_MS, now), WAIT_PROBE_TIMEOUT_FLOOR_MS);
  });

  test("deadline 已过也给一个下限，不留 0ms 超时", () => {
    assert.equal(probeTimeoutMs(now - 5_000, now), WAIT_PROBE_TIMEOUT_FLOOR_MS);
    assert.equal(probeTimeoutMs(now, now), WAIT_PROBE_TIMEOUT_FLOOR_MS);
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
    page: {
      nodes?: { width: number; height: number; visibility?: string }[];
      /** innerText 看到的可见正文 */
      text?: string;
      /** textContent 看到的全部文本（默认与 text 一致；给不同值可模拟「藏在 CSS 里」） */
      textContent?: string;
      /** 让读 innerText 直接抛错：用来证明「候选都没命中时不会碰 innerText」 */
      innerTextThrows?: boolean;
      badSelector?: boolean;
    },
  ): unknown => {
    const nodes = (page.nodes ?? []).map((node) => ({
      ...node,
      getBoundingClientRect: () => ({ width: node.width, height: node.height }),
    }));
    const bodyStub =
      page.innerTextThrows === true
        ? {
            textContent: page.textContent ?? page.text ?? "",
            get innerText(): string {
              throw new Error("layout forced");
            },
          }
        : { innerText: page.text ?? "", textContent: page.textContent ?? page.text ?? "" };
    const documentStub = {
      body: bodyStub,
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

  test("文字探针先看 textContent 排除：候选没出现时不读 innerText（不强制 layout）", () => {
    assert.deepEqual(
      runProbe({ text: "3 results" }, { textContent: "nothing here", innerTextThrows: true }),
      { selector: null, text: false },
      "textContent 里没有就不该碰 innerText",
    );
    // 候选出现在 textContent 后仍以 innerText 为准：CSS 隐藏的内容不算「可见文字」
    assert.deepEqual(runProbe({ text: "secret" }, { text: "", textContent: "secret hidden" }), {
      selector: null,
      text: false,
    });
    assert.deepEqual(runProbe({ text: "secret" }, { text: "secret visible", textContent: "secret visible" }), {
      selector: null,
      text: true,
    });
  });

  test("预筛两边都归一化再比：源码换行缩进与 text-transform 不再被筛掉（评审表格前两行）", () => {
    // `<p>Loading⏎      complete</p>`：textContent 带源码里的换行与缩进，innerText 是合并后的可见文本
    assert.deepEqual(
      runProbe({ text: "Loading complete" }, { textContent: "Loading\n      complete", text: "Loading complete" }),
      { selector: null, text: true },
      "textContent 的换行缩进不该把 innerText 能命中的文字筛掉",
    );
    // `<p style="text-transform:uppercase">sign in</p>`：textContent 是源码里的原文，innerText 应用了变换
    assert.deepEqual(
      runProbe({ text: "SIGN IN" }, { textContent: "sign in", text: "SIGN IN" }),
      { selector: null, text: true },
      "text-transform 只改渲染文字，不该被预筛当成没出现",
    );
    // 预筛放宽了，确认仍是精确的：页面上没有这段可见文字就不算命中
    assert.deepEqual(
      runProbe({ text: "Loading complete" }, { textContent: "Loading\n complete", text: "still stalled" }),
      { selector: null, text: false },
    );
    // 归一化只多放过、不会漏读：归一化后也对不上时仍不碰 innerText（不强制 layout）
    assert.deepEqual(
      runProbe({ text: "Loading complete" }, { textContent: "loading\n  stalled", innerTextThrows: true }),
      { selector: null, text: false },
    );
  });

  test("选择器与文字以 JSON 字面量嵌入——带引号的选择器不会串成代码", () => {
    const script = waitProbeScript(specOf({ selector: 'a[title="x"]', text: 'say "hi"' }));
    assert.ok(script.includes('const selector = "a[title=\\"x\\"]";'));
    assert.ok(script.includes('const text = "say \\"hi\\"";'));
    // 预筛的针是 Node 侧算好的归一化结果：段内多空格 / 换行合成一个空格、转小写
    assert.ok(waitProbeScript(specOf({ text: "SIGN   IN" })).includes('const needle = "sign in";'));
    // 没问的条件是 null，页内不会去碰它
    const selectorOnly = waitProbeScript(specOf({ selector: "#r" }));
    assert.ok(selectorOnly.includes("const text = null;"));
  });

  test("visible 决定是否量包围盒；两个检查各自被条件守住（没问的条件不执行）", () => {
    assert.ok(waitProbeScript(specOf({ selector: "#r", visible: true })).includes("const needVisible = true;"));
    assert.ok(waitProbeScript(specOf({ selector: "#r" })).includes("const needVisible = false;"));
    const selectorOnly = waitProbeScript(specOf({ selector: "#r" }));
    assert.ok(selectorOnly.includes("if (selector !== null)"));
    assert.ok(selectorOnly.includes("if (text !== null)"));
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

  test("不足一秒的命中用毫秒：不说 0s（那是在掩盖探一次就命中）", () => {
    const parsed = parseWaitSpec({ selector: "#results" });
    assert.ok(parsed.ok);
    assert.match(formatWaitResult(page, parsed.spec, { hit: true, elapsedMs: 8 }), /^#results appeared after 8ms on/);
    assert.match(formatWaitResult(page, parsed.spec, { hit: true, elapsedMs: 420 }), /^#results appeared after 420ms on/);
    // 一秒整起还是一位小数的秒
    assert.match(formatWaitResult(page, parsed.spec, { hit: true, elapsedMs: 1000 }), /^#results appeared after 1s on/);
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

describe("waitSelectorInvalidFallback", () => {
  const specOf = (input: Parameters<typeof parseWaitSpec>[0]) => {
    const parsed = parseWaitSpec(input);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.spec;
  };

  test("还有 text 条件：丢掉 selector 只等 text，note 说明；已有 note 拼在后面", () => {
    const fallback = waitSelectorInvalidFallback(
      specOf({ selector: "##bad[", text: "3 results", timeoutMs: 5000 }),
      "timeoutMs was capped at 30000",
    );
    assert.ok(fallback.ok);
    assert.deepEqual(fallback.spec, { text: "3 results", visible: false, timeoutMs: 5000 });
    assert.equal(
      fallback.note,
      'selector "##bad[" is not valid CSS — ignored, waited on the text only; timeoutMs was capped at 30000',
    );
    const bare = waitSelectorInvalidFallback(specOf({ selector: "##bad[", text: "x" }), null);
    assert.ok(bare.ok);
    assert.equal(bare.note, 'selector "##bad[" is not valid CSS — ignored, waited on the text only');
  });

  test("只有 selector：没得降级，当场报错", () => {
    const fallback = waitSelectorInvalidFallback(specOf({ selector: "##bad[" }), null);
    assert.deepEqual(fallback, { ok: false, error: '"##bad[" is not a valid CSS selector.' });
  });
});

describe("describeWaitTarget", () => {
  test("两个条件用 or 连起来——两个都给了就是任一命中", () => {
    const parsed = parseWaitSpec({ selector: "#r", text: "3 results" });
    assert.ok(parsed.ok);
    assert.equal(describeWaitTarget(parsed.spec), '#r or the text "3 results"');
  });
});
