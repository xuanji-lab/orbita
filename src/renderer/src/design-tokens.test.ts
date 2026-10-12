/**
 * 设计 token 契约的静态扫描（AGENTS.md「禁裸 hex / 未定义 CSS 变量」）。
 *
 * 两条检查：
 *  1. **每个 `var(--x)` 引用都得有声明**——声明来自 `design-system/tokens/*.css`、
 *     渲染层 `.css`，以及渲染层 TS/TSX 在运行时写的自定义属性（对象字面量 `"--x": …` 或
 *     `el.style.setProperty("--x", …)`）。少了任何一处，token 就是静默回落到继承值，
 *     `--font-size-label` 就是这么死的（McpPanel.tsx / SkillsPanel.tsx 两处）。
 *  2. **渲染层代码里不许出现裸 hex 颜色**——颜色只能从 token 来，`tokens/*.css` 之外一律
 *     报错。唯一的文件级豁免见下面 `HEX_FILE_EXEMPTIONS`。
 *
 * 两个检查各自独立扫描，互不借用对方的豁免——hex 检查的文件豁免不代表那个文件的
 * token 引用也不用声明。
 *
 * 路径解析走 `import.meta.url`，不依赖 cwd（照 `shell/menu-position.test.ts` 的先例）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// HERE = <repo>/src/renderer/src —— 上三层到仓库根
const REPO_ROOT = join(HERE, "..", "..", "..");
const RENDERER_SRC = join(REPO_ROOT, "src/renderer/src");
const TOKENS_DIR = join(REPO_ROOT, "design-system/tokens");

// 本文件自己的绝对路径：声明/引用扫描都要把自己排除在外（字符串里写满了 token 名与
// 正则片段，混进去只会污染结果）。
const SELF_PATH = fileURLToPath(import.meta.url);

/** 递归收集某目录下指定扩展名的文件（同步、无第三方依赖）。 */
function walk(dir: string, exts: readonly string[]): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walk(full, exts));
    } else if (exts.includes(extname(name))) {
      out.push(full);
    }
  }
  return out;
}

/** 非递归收集某目录下指定扩展名的文件（`tokens/*.css` 是平铺目录，不需要递归）。 */
function listFiles(dir: string, exts: readonly string[]): string[] {
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((full) => statSync(full).isFile() && exts.includes(extname(full)));
}

/**
 * 剥掉块注释，但用等量的「非换行字符 → 空」替换而不是整段删除，行号保持不变。
 * css 和 ts/tsx 都有 `/* … *‍/` 块注释，共用这一步。
 */
function stripBlockComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ""));
}

/**
 * 剥掉 `//` 行注释（只对 ts/tsx 调用）。不能见 `//` 就切——字符串字面量里的 `://`
 * （`"https://example.com"`）不是注释：只在 `//` 前一个字符不是 `:` 时才算注释起点。
 * 这是启发式，不是完整的 JS 词法分析，但覆盖了本仓实际出现的写法。
 */
function stripLineComments(text: string): string {
  return text.replace(/(^|[^:])\/\/[^\n]*/gm, "$1");
}

function readClean(path: string, isTs: boolean): string {
  let text = readFileSync(path, "utf8");
  text = stripBlockComments(text);
  if (isTs) text = stripLineComments(text);
  return text;
}

/**
 * 仓库相对路径，**统一用正斜杠**（本仓的路径书写约定，git 也是这个形状）。
 *
 * 为什么必须归一：`HEX_FILE_EXEMPTIONS` 里的键是手写的路径字面量，而 `relative()`
 * 在 Windows 上返回反斜杠——不归一的话豁免名单在 Windows 上**静默失效**，被豁免的
 * highlight.ts 会被当成裸 hex 报错。这是「同一份名单两平台同一把钥匙」，
 * 不是用来掩盖分隔符差异（真正的路径比较都走 realpath / join）。
 */
function relPath(path: string): string {
  return relative(REPO_ROOT, path).split(sep).join("/");
}

/**
 * 三个正则都只声明了一个捕获组，匹配到就一定有 group 1——但 TS 的
 * `RegExpMatchArray` 类型不知道这点，各处都得从 `string | undefined` 收窄。
 * 集中在这一个函数里做，调用点不再重复判断。
 */
function group1(m: RegExpMatchArray): string {
  const value = m[1];
  if (value === undefined) {
    throw new Error("正则声明了捕获组但没有捕获到内容，不应该发生");
  }
  return value;
}

// ---------------------------------------------------------------------------
// 声明集：token 名 → 声明处（只用来在失败信息里给上下文，非必需）
// ---------------------------------------------------------------------------

const DECL_CSS_RE = /--([a-zA-Z0-9-]+)\s*:/g;
const DECL_TS_OBJKEY_RE = /["']--([a-zA-Z0-9-]+)["']\s*:/g;
const DECL_TS_SETPROP_RE = /\.style\.setProperty\(\s*["']--([a-zA-Z0-9-]+)["']/g;

const declared = new Set<string>();

const tokenCssFiles = listFiles(TOKENS_DIR, [".css"]);
const rendererCssFiles = walk(RENDERER_SRC, [".css"]);
const rendererTsFiles = walk(RENDERER_SRC, [".ts", ".tsx"]).filter((f) => f !== SELF_PATH);

for (const file of [...tokenCssFiles, ...rendererCssFiles]) {
  const text = readClean(file, false);
  for (const m of text.matchAll(DECL_CSS_RE)) declared.add(group1(m));
}
for (const file of rendererTsFiles) {
  const text = readClean(file, true);
  for (const m of text.matchAll(DECL_TS_OBJKEY_RE)) declared.add(group1(m));
  for (const m of text.matchAll(DECL_TS_SETPROP_RE)) declared.add(group1(m));
}

// ---------------------------------------------------------------------------
// 引用集：var(--x) 用到的每一处
// ---------------------------------------------------------------------------

/**
 * 白名单前缀——只有这一条：`--shiki-*` 是 shiki 高亮在运行时直接写进 span 的 inline
 * style（`highlight.ts` 顶部注释：「每个 span 同时写入浅色内联色与 `--shiki-dark` 变量」），
 * 不会出现在任何 .css/.tsx 源码里，天然扫不到声明。再加条目必须写清它在哪声明。
 */
const REF_WHITELIST_PREFIXES = ["shiki-"] as const;

const REF_RE = /var\(\s*--([a-zA-Z0-9-]+)/g;

function isWhitelisted(name: string): boolean {
  return REF_WHITELIST_PREFIXES.some((p) => name.startsWith(p));
}

interface Usage {
  name: string;
  loc: string;
}

function scanRefs(files: string[], isTs: boolean): Usage[] {
  const usages: Usage[] = [];
  for (const file of files) {
    const text = readClean(file, isTs);
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      for (const m of line.matchAll(REF_RE)) {
        usages.push({ name: group1(m), loc: `${relPath(file)}:${i + 1}` });
      }
    });
  }
  return usages;
}

const allRefs = [
  ...scanRefs(tokenCssFiles, false),
  ...scanRefs(rendererCssFiles, false),
  ...scanRefs(rendererTsFiles, true),
];

// ---------------------------------------------------------------------------
// hex 检查：src/renderer/src 下 .ts/.tsx/.css 里的裸 hex 颜色
// ---------------------------------------------------------------------------

/**
 * 只抓「3/4/6/8 位十六进制」这个形状，且后面不能再跟十六进制字符（避免把 7 位这种
 * 不合法长度的前缀吃进去）。天然排除 `#root`、`#app` 这类选择器/DOM id——字母表以外
 * 的字符（r、o、t…）第一个就不是十六进制数字，正则从 `#` 起步直接失配；也天然排除
 * URL 片段一类的东西（本仓目前没有会撞到这个模式的 URL）。
 */
const HEX_RE = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b(?![0-9a-fA-F])/g;

/**
 * hex 检查的文件级豁免（按仓库相对路径）——加条目必须写清理由，不能是“先放行再说”。
 *
 * - `features/chat/highlight.ts`：shiki 的 TextMate 主题数据（`GITHUB_DARK.tokenColors`）。
 *   shiki 只接受字面量颜色字符串，自己转成 inline style/CSS 变量（如上面的 `--shiki-dark`），
 *   一个 CSS 自定义属性放不进 TextMate 的 `settings.foreground`——这不是「偷懒没接
 *   token」，是这层数据格式本身只吃十六进制。上游 `shiki/themes/github-dark.mjs` 整份
 *   也全是十六进制，这条本地补丁与被补的主题同格式。
 *   （2026-09-23 裁决：豁免这一个文件，不改颜色值、不新造 token；token 检查不豁免它。）
 */
const HEX_FILE_EXEMPTIONS = new Set<string>(["src/renderer/src/features/chat/highlight.ts"]);

interface HexHit {
  value: string;
  loc: string;
}

function scanHex(files: string[]): HexHit[] {
  const hits: HexHit[] = [];
  for (const file of files) {
    const rel = relPath(file);
    if (HEX_FILE_EXEMPTIONS.has(rel)) continue;
    const text = readClean(file, extname(file) !== ".css");
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      for (const m of line.matchAll(HEX_RE)) {
        hits.push({ value: m[0], loc: `${rel}:${i + 1}` });
      }
    });
  }
  return hits;
}

describe("design-tokens —— var(--x) 引用都要有声明", () => {
  test("没有死 token：每个引用到的自定义属性都能在 css 声明或 ts/tsx 运行时写入里找到", () => {
    const missing = new Map<string, string[]>();
    for (const usage of allRefs) {
      if (isWhitelisted(usage.name)) continue;
      if (declared.has(usage.name)) continue;
      const locs = missing.get(usage.name) ?? [];
      locs.push(usage.loc);
      missing.set(usage.name, locs);
    }
    if (missing.size > 0) {
      const lines: string[] = [];
      for (const [name, locs] of missing) {
        lines.push(`--${name}`);
        for (const loc of locs) lines.push(`  ${loc}`);
      }
      assert.fail(`以下 token 有引用但找不到声明：\n${lines.join("\n")}`);
    }
  });
});

describe("design-tokens —— 渲染层不许有裸 hex 颜色", () => {
  test("src/renderer/src 下 ts/tsx/css 没有未豁免的 hex 颜色字面量", () => {
    const hits = scanHex([...rendererCssFiles, ...rendererTsFiles]);
    if (hits.length > 0) {
      const lines = hits.map((h) => `  ${h.loc}: ${h.value}`);
      assert.fail(`发现裸 hex 颜色（不在 HEX_FILE_EXEMPTIONS 里）：\n${lines.join("\n")}`);
    }
  });
});
