/**
 * 完成提醒卡（`.completion-card`）必须有渲染点——静态守卫。
 *
 * 为什么是静态扫描而不是渲染测试：`node --test` 只加载 `.ts`（Node 的类型剥离不认
 * JSX），仓库也没有 DOM 依赖，`CompletionCard` 又经 `createPortal` 渲染——服务端
 * 渲染器对 portal 直接抛错。所以这里守的是「JSX 里到底有没有这一行」这个事实。
 *
 * 历史原因：36da01e0 引入功能时只加了 import、prop 与锚点 state，从未写过
 * `<CompletionCard>`；组件整整半个月没有渲染点，后台跑完不弹卡（验收探针 notify
 * 面 27 格红全部由此引起）。只断言 import 存在抓不到这个 bug——必须断言 JSX。
 *
 * 链条三段都要在，缺一段都是「看起来接了、其实断了」：
 *   App.tsx 算 completionNotice + 挂 `.pane-pop-host` → RightRail 的条件渲染 → 组件。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RENDERER_SRC = join(HERE, "..");
const read = (rel: string): string => readFileSync(join(RENDERER_SRC, rel), "utf8");

describe("完成提醒卡的渲染点", () => {
  test("RightRail 真的渲染 CompletionCard，而不只是 import 它", () => {
    const source = read("shell/RightRail.tsx");
    assert.match(source, /import \{ CompletionCard \}/, "import 是本测试的前提");
    const mounts = source.match(/<CompletionCard\b/g) ?? [];
    assert.equal(mounts.length, 1, "应当且只应当有一个 <CompletionCard> 渲染点");
  });

  test("渲染点在 completionNotice 为 null 时不出现（没有提醒就不画卡）", () => {
    const source = read("shell/RightRail.tsx");
    const guard = source.match(/\{props\.completionNotice !== null && \(\s*<CompletionCard\b[^)]*\)\}/);
    assert.ok(guard, "CompletionCard 必须被 `props.completionNotice !== null` 守着");
  });

  test("卡片拿到主槽宿主与整份 props，不改形状", () => {
    const source = read("shell/RightRail.tsx");
    const mount = source.match(/<CompletionCard\b[^>]*?\/>/s)?.[0] ?? "";
    assert.match(mount, /host=\{props\.popHost\}/, "弹出宿主必须用 App 传进来的 .pane-pop-host");
    assert.match(mount, /\{\.\.\.props\.completionNotice\}/, "props 形状由 App 决定，这里只透传");
  });

  test("App 侧两半都在：数据（completionNotice）与宿主（popHost / .pane-pop-host）", () => {
    const app = read("App.tsx");
    assert.match(app, /completionNotice=\{completionNotice\}/, "App 必须把计算好的提醒传进右栏");
    assert.match(app, /popHost=\{popHost\}/, "App 必须把弹出宿主传进右栏");
    assert.match(app, /className="pane-pop-host" ref=\{setPopHost\}/, "主槽必须挂出 .pane-pop-host");
  });

  test("组件自己在宿主缺席时不画（避免 portal 到 null）", () => {
    const card = read("features/notify/CompletionCard.tsx");
    assert.match(card, /if \(props\.host === null\) return null;/, "host 未挂载时返回 null");
  });
});
