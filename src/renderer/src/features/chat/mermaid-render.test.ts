import { test } from "node:test";
import assert from "node:assert/strict";
import { render, PeleError } from "pele";
import {
  MERMAID_OPTIONS,
  PELE_THEME_VARS,
  endsInsideFence,
  failureReason,
  isMermaidLang,
  svgViolation,
} from "./mermaid-render.ts";

test("isMermaidLang：只认整词 mermaid，大小写不敏感", () => {
  assert.equal(isMermaidLang("mermaid"), true);
  assert.equal(isMermaidLang("Mermaid"), true);
  assert.equal(isMermaidLang("mermaidx"), false);
  assert.equal(isMermaidLang("ts"), false);
  assert.equal(isMermaidLang(undefined), false);
});

test("endsInsideFence：流式半截围栏判未闭合，闭合后判已闭合", () => {
  assert.equal(endsInsideFence("```mermaid"), true);
  assert.equal(endsInsideFence("```mermaid\nflowchart LR\n  A --> B"), true);
  assert.equal(endsInsideFence("```mermaid\nflowchart LR\n  A --> B\n``"), true);
  assert.equal(endsInsideFence("```mermaid\nflowchart LR\n  A --> B\n```"), false);
  assert.equal(endsInsideFence("```mermaid\nA --> B\n```\n"), false);
  // 波浪线围栏、更长的围栏
  assert.equal(endsInsideFence("~~~mermaid\nA --> B\n~~~"), false);
  assert.equal(endsInsideFence("````mermaid\nA\n```\nstill inside"), true);
  assert.equal(endsInsideFence("````mermaid\nA\n````"), false);
  // 没有围栏 / 行内 code
  assert.equal(endsInsideFence("普通段落 ```行内``` 文字"), false);
  assert.equal(endsInsideFence(""), false);
});

/** 一个 token 引用（用 \x2d 写连字符：设计令牌的「死 token」扫描会把源码里字面的 var 加两个连字符当成真引用） */
const VAR_REF = /var\(\x2d\x2d[a-z-]+\)/g;

test("PELE_THEME_VARS：只映射到设计系统 token，无裸色值", () => {
  const names = Object.keys(PELE_THEME_VARS);
  for (const v of ["bg", "fg", "muted", "line", "surface", "surface-alt", "border", "accent", "font", "radius"]) {
    assert.ok(names.includes(`--pele-${v}`), `缺 --pele-${v}`);
  }
  for (let i = 1; i <= 8; i += 1) assert.ok(names.includes(`--pele-series-${i}`));
  for (const [name, value] of Object.entries(PELE_THEME_VARS)) {
    // 允许单个 token 引用，或 color-mix 套 token 引用，其余一律不行
    const stripped = value.replace(VAR_REF, "").replace(/color-mix\(in srgb,|[\s,()%\d]/g, "");
    assert.equal(stripped, "", `${name} 只能由 token 引用组成：${value}`);
    assert.match(value, VAR_REF);
    assert.doesNotMatch(value, /#|rgb\(|hsl/i);
  }
});

test("failureReason：取位置 + 期望两行并截断，不带源码 snippet，空串兜底", () => {
  assert.equal(failureReason(new Error("Parse error on line 2:\n  A -->\n----^")), "Parse error on line 2:");
  assert.equal(
    failureReason(new Error("Parse error on line 2:\n  <script>x\n------^\nExpecting 'NODE_STRING', got 'EOF'")),
    "Parse error on line 2: Expecting 'NODE_STRING', got 'EOF'",
  );
  assert.equal(failureReason(new Error("x".repeat(300))).length, 121);
  assert.equal(failureReason(new Error("")), "未知错误");
  assert.equal(failureReason("boom"), "boom");
});

test("svgViolation：干净的 pele 输出放行，注入一律拦下", () => {
  const clean = render("flowchart LR\n  A --> B", MERMAID_OPTIONS).svg;
  assert.equal(svgViolation(clean), null);
  assert.notEqual(svgViolation("<div></div>"), null);
  assert.notEqual(svgViolation('<svg><script>alert(1)</script></svg>'), null);
  assert.notEqual(svgViolation('<svg onload="x()"></svg>'), null);
  assert.notEqual(svgViolation('<svg><a href="javascript:alert(1)"><text>x</text></a></svg>'), null);
  assert.notEqual(svgViolation('<svg><a xlink:href="https://evil.example"><text>x</text></a></svg>'), null);
  assert.notEqual(svgViolation('<svg><image href="https://evil.example/x.png"/></svg>'), null);
  assert.notEqual(svgViolation('<svg><foreignObject><div/></foreignObject></svg>'), null);
  assert.notEqual(svgViolation('<svg><rect style="fill:url(https://evil.example/a)"/></svg>'), null);
  assert.equal(svgViolation('<svg><rect fill="url(#g1)"/></svg>'), null);
  // 属性值里的 > 不能让标签提前结束而漏检
  assert.notEqual(svgViolation('<svg><rect title=">" onload="x()"/></svg>'), null);
  // 文字里转义过的 onload= 不算违规
  assert.equal(svgViolation('<svg><text>&lt;svg onload=alert(1)&gt;</text></svg>'), null);
});

/** 渲染恶意输入：要么抛 PeleError（组件会退回代码块），要么输出能过 svgViolation 且不含载荷 */
function drawOrReject(source: string): string | null {
  try {
    return render(source, MERMAID_OPTIONS).svg;
  } catch (error) {
    assert.ok(error instanceof PeleError, `非预期的异常类型：${String(error)}`);
    return null;
  }
}

test("恶意 mermaid：script 标签、javascript: 链接、click 回调、事件属性", () => {
  const hostile = [
    'flowchart LR\n  A["<script>alert(1)</script>"] --> B',
    'flowchart LR\n  A --> B\n  click A "javascript:alert(1)"',
    "flowchart LR\n  A --> B\n  click A call evil()",
    'flowchart LR\n  A --> B\n  click B "https://evil.example/steal"',
    'flowchart LR\n  A["<img src=x onerror=alert(1)>"] --> B',
    'flowchart LR\n  A["<a href=\'javascript:alert(1)\'>x</a>"] --> B',
    'flowchart LR\n  A --> B\n  style A fill:url(https://evil.example/a)',
    'sequenceDiagram\n  A->>B: <script>alert(1)</script>\n  Note over A: <svg onload=alert(1)>',
    "---\nconfig:\n  securityLevel: loose\n---\nflowchart LR\n  A --> B",
    '%%{init: {"securityLevel":"loose","htmlLabels":true}}%%\nflowchart LR\n  A[<b onmouseover=alert(1)>x</b>] --> B',
  ];
  for (const source of hostile) {
    const svg = drawOrReject(source);
    if (svg === null) continue;
    assert.equal(svgViolation(svg), null, `SVG 复核未过：${source}`);
    assert.doesNotMatch(svg, /<script|<[^>]*\son[a-z]+=|<a\s|href=|evil\.example/i, source);
  }
});

test("超长输入：源码超限被拒（limit），不会卡住", () => {
  const huge = `flowchart LR\n${"  A --> B\n".repeat(5000)}`;
  assert.ok(huge.length > MERMAID_OPTIONS.limit!);
  assert.throws(() => render(huge, MERMAID_OPTIONS), (error: unknown) => {
    return error instanceof PeleError && error.code === "limit";
  });
});

test("语法错与未知图类型：抛 PeleError，原因取第一行", () => {
  for (const bad of ["flowchart LR\n A -->", "hello world"]) {
    assert.throws(() => render(bad, MERMAID_OPTIONS), (error: unknown) => {
      assert.ok(error instanceof PeleError);
      assert.doesNotMatch(failureReason(error), /\n/);
      return true;
    });
  }
});

test("覆盖常见图表：流程 / 时序 / 甘特 / 类 / 状态 / 饼图的输出都过复核", () => {
  const samples = [
    "flowchart TD\n  A[开始] --> B{判断}\n  B -->|是| C[做]\n  B -->|否| D[停]",
    "sequenceDiagram\n  participant U as 用户\n  U->>S: 请求\n  S-->>U: 响应",
    "gantt\n  title 计划\n  dateFormat YYYY-MM-DD\n  section 一\n  任务 :a1, 2026-11-01, 5d\n  任务二 :after a1, 3d",
    "classDiagram\n  class A {\n    +int x\n    +run()\n  }\n  A <|-- B",
    "stateDiagram-v2\n  [*] --> Idle\n  Idle --> Busy\n  Busy --> [*]",
    'pie title 占比\n  "a" : 40\n  "b" : 60',
  ];
  for (const source of samples) {
    const svg = render(source, MERMAID_OPTIONS).svg;
    assert.equal(svgViolation(svg), null, source);
  }
});
