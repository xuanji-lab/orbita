/**
 * 功能图标单一来源（shell/feature-icons.ts）的静态扫描。
 *
 * 规则：FEATURE_ICON 表里登记的图标名，不允许以字面量出现在渲染层代码——
 * 右栏入口、面板头、页签、空态、聊天行……一律 `import { FEATURE_ICON }` 取，
 * 这样换图标只改表一处（2026-11-06 用户：换 logo 不应该一个一个改）。
 *
 * 字面量只许出现在两个文件：`shell/Icon.tsx`（SVG 登记）与 `shell/feature-icons.ts`（表本体）；
 * 测试文件在扫描时整体跳过（可以断言表值）。做法学 `design-tokens.test.ts` 的裸 hex 扫描。
 *
 * 少数图标名撞了通用义（folder 同时是「目录」、book-open 同时是「单个技能」……），
 * 全量禁会把无关代码打红：这些名字放行（`GENERIC_ICON_NAMES`，每条写清理由），
 * 它们的**功能表面**同样走表，只是字面量扫描不设防。新名字进表时先想清楚：
 * 语义独占的直接进严格档（不放行即受保护），撞通用义的进放行档并写理由。
 *
 * 路径解析走 `import.meta.url`，不依赖 cwd（照 design-tokens.test.ts 的先例）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { FEATURE_ICON } from "./feature-icons.ts";

const HERE = dirname(fileURLToPath(import.meta.url)); // <repo>/src/renderer/src/shell
const RENDERER_SRC = join(HERE, "..");
const SELF_PATH = fileURLToPath(import.meta.url);

/** 字面量允许出现的文件（渲染层相对路径，统一正斜杠） */
const OK_FILES = new Set(["shell/Icon.tsx", "shell/feature-icons.ts"]);

/**
 * 撞通用义的图标名 → 放行理由。功能表面照旧走表；这里放行的只是「不是该功能」的用法。
 * 想收紧某一项：先让它的通用用法改用别的图标，再从这张表里删掉那一行。
 */
const GENERIC_ICON_NAMES = new Map<string, string>([
  ["folder", "目录的通用图标（文件树、工作区行、附件 chip）；「文件」面板的功能表面走表"],
  ["globe", "网页/全局范围的通用图标（web 文件、全局作用域、browser_* 工具行）；「浏览器」的入口与设置页签走表"],
  ["book-open", "单个技能/文档的通用图标（聊天里的技能行、上下文清单的技能行、插件工作流）；「技能与 MCP」的入口与面板走表"],
  ["archive", "词同时是普通字符串（侧栏的 step 名、迁移视图的归档徽记），字面量扫描分不出；「已归档」的入口与空态走表"],
  ["settings", "词同时是 overlay id（overlay === \"settings\"），字面量扫描分不出；「设置」的入口走表"],
  ["bell", "词同时是面板 id（countPanel(\"bell\")、item.id === \"bell\"），字面量扫描分不出；「通知」的入口与空态走表"],
]);

const TABLE_VALUES: readonly string[] = [...new Set(Object.values(FEATURE_ICON))];

test("FEATURE_ICON：两个功能不共用同一枚图标（用户 2026-11-05：各入口图标不能重复）", () => {
  const seen = new Map<string, string>();
  for (const [key, icon] of Object.entries(FEATURE_ICON)) {
    const first = seen.get(icon);
    if (first !== undefined) {
      assert.fail(`图标 "${icon}" 同时登记给 ${first} 和 ${key}；给其中一个换 Icon.tsx 里的别的形状`);
    }
    seen.set(icon, key);
  }
});

test("GENERIC_ICON_NAMES：放行档里的名字都得是表值（删了表值要连着删放行条目）", () => {
  for (const name of GENERIC_ICON_NAMES.keys()) {
    assert.ok(TABLE_VALUES.includes(name), `"${name}" 不在 FEATURE_ICON 的值里，放行条目该删了`);
  }
});

/** 递归收集渲染层的 ts/tsx（测试文件不算：它们可以断言表值） */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if ((extname(name) === ".ts" || extname(name) === ".tsx") && !name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 剥注释，但保持行号（等量「非换行字符 → 空」替换）。功能图标的字面量只该出现在
 * 图标属性里，注释里提到图标名不算用；不剥会把说明文字误当违规。
 */
function stripComments(text: string): string {
  let out = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ""));
  // 字符串里的 "://" 不是注释（如 "https://…"）
  return out.replace(/(^|[^:])\/\/[^\n]*/gm, "$1");
}

function repoRel(path: string): string {
  return relative(RENDERER_SRC, path).split(/[\\/]/).join("/");
}

test("功能图标字面量只许出现在登记处（Icon.tsx / feature-icons.ts），别处一律走表", () => {
  const violations: string[] = [];
  for (const file of walk(RENDERER_SRC)) {
    const rel = repoRel(file);
    if (rel === repoRel(SELF_PATH) || OK_FILES.has(rel)) continue;
    const lines = stripComments(readFileSync(file, "utf8")).split("\n");
    for (const [i, line] of lines.entries()) {
      for (const name of TABLE_VALUES) {
        if (GENERIC_ICON_NAMES.has(name)) continue;
        if (new RegExp(`["']${name}["']`).test(line)) {
          violations.push(`${rel}:${i + 1}: "${name}"`);
        }
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    `这些功能图标写成了字面量——改 import { FEATURE_ICON } from "…/shell/feature-icons.ts"：\n${violations.join("\n")}`,
  );
});
