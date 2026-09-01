/**
 * highlight.ts 的最小可执行测试：14 种预置语言逐一真跑一遍（顺带验证 JS 正则引擎
 * 吃得下每份语法）、别名归一、未知语言降级、双主题输出形态、缓存命中。
 * 引擎初始化是异步的——先等 highlighterReady 再断言。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  highlighterReady,
  highlightBlock,
  highlightLines,
  langFromPath,
  resolveLang,
} from "./highlight.ts";

await highlighterReady;

describe("resolveLang", () => {
  test("语法自带的别名直接命中（别名本身在 loaded 集合里，codeToHtml 内部再归一到语法）", () => {
    for (const alias of ["ts", "sh", "shell", "zsh", "yml", "py", "ps1", "pwsh", "js", "mjs", "tsx"]) {
      assert.ok(resolveLang(alias) !== null, `${alias} 应可解析`);
    }
  });

  test("补归一的别名", () => {
    assert.equal(resolveLang("patch"), "diff");
    assert.equal(resolveLang("jsonc"), "json");
  });

  test("未预置的语言与纯文本标记返回 null", () => {
    assert.equal(resolveLang("foobar"), null);
    assert.equal(resolveLang("text"), null);
    assert.equal(resolveLang(""), null);
  });
});

describe("langFromPath", () => {
  test("常见扩展名可解析（扩展名与 fence 别名同池）", () => {
    const cases: ReadonlyArray<[string, string]> = [
      ["src/app.ts", "ts"],
      ["C:\\Users\\x\\a.py", "py"],
      ["docs/README.md", "md"],
      [".github/workflows/ci.yml", "yml"],
      ["scripts/run.sh", "sh"],
      ["config/settings.json", "json"],
      ["a/b/c.tsx", "tsx"],
    ];
    for (const [path, ext] of cases) {
      assert.ok(langFromPath(path) !== null, `${path} 应可解析（.${ext}）`);
    }
  });

  test("大小写不敏感：README.MD 也认", () => {
    assert.ok(langFromPath("README.MD") !== null);
  });

  test("无扩展名、点文件、未预置扩展名返回 null", () => {
    assert.equal(langFromPath("LICENSE"), null);
    assert.equal(langFromPath(".gitignore"), null);
    assert.equal(langFromPath("logo.svg"), null);
    assert.equal(langFromPath("archive.tar.gz"), null); // gz 未预置
    assert.equal(langFromPath(""), null);
  });
});

describe("highlightLines", () => {
  test("行数与行内拼接都对：拼起来等于原文各行", () => {
    const code = "const a = 1;\n// 注释\nlet b = \"x\";";
    const lines = highlightLines(code, "ts");
    assert.ok(lines !== null);
    assert.equal(lines.length, 3);
    for (const [i, line] of lines.entries()) {
      assert.equal(
        line.map((token) => token.text).join(""),
        code.split("\n")[i],
        `第 ${i + 1} 行 token 拼接应等于原文`,
      );
    }
  });

  test("双主题：token 样式带浅色 color 与 --shiki-dark 变量", () => {
    const lines = highlightLines("const a = 1;", "ts");
    assert.ok(lines !== null);
    const styled = lines[0]?.filter((token) => token.style !== undefined) ?? [];
    assert.ok(styled.length > 0, "应有带样式的 token");
    const first = styled[0]?.style;
    assert.ok(first !== undefined && typeof first["color"] === "string");
    assert.ok(first !== undefined && typeof first["--shiki-dark"] === "string");
  });

  test("空行是空 token 数组（渲染层给占位空格）", () => {
    const lines = highlightLines("a\n\nb", "ts");
    assert.ok(lines !== null);
    assert.deepEqual(lines[1], []);
  });

  test("未知语言返回 null（纯文本降级）", () => {
    assert.equal(highlightLines("whatever", "foobar"), null);
  });

  test("同输入命中缓存：返回同一份引用", () => {
    const first = highlightLines("let y = 2;", "js");
    const second = highlightLines("let y = 2;", "js");
    assert.ok(first !== null && first === second);
  });
});

describe("highlightBlock", () => {
  test("双主题输出：带 shiki pre 与 --shiki-dark 变量", () => {
    const html = highlightBlock("const x: number = 1;", "ts");
    assert.ok(html !== null);
    assert.ok(html.includes('<pre class="shiki'));
    assert.ok(html.includes("--shiki-dark:"));
  });

  test("14 种预置语言逐一真跑，全部非空", () => {
    const samples: ReadonlyArray<[string, string]> = [
      ["typescript", "const a: number = 1;"],
      ["tsx", "export const A = () => <div>hi</div>;"],
      ["javascript", "console.log('hi')"],
      ["jsx", "const B = () => <span>{x}</span>;"],
      ["json", '{"a": 1}'],
      ["bash", "echo $HOME"],
      ["css", ".a { color: red; }"],
      ["html", "<p class=\"a\">hi</p>"],
      ["python", "def f():\n    return 1"],
      ["yaml", "a: 1\nb: two"],
      ["markdown", "# hi\n\n- one"],
      ["toml", "[a]\nb = 1"],
      ["powershell", "Get-ChildItem -Force"],
      ["diff", "- old\n+ new"],
    ];
    for (const [lang, code] of samples) {
      assert.ok(
        highlightBlock(code, lang) !== null,
        `${lang} 应产出 HTML`,
      );
    }
  });

  test("未知语言返回 null（无色降级，不抛错）", () => {
    assert.equal(highlightBlock("whatever", "foobar"), null);
  });

  test("同输入命中缓存：返回同一份字符串", () => {
    const first = highlightBlock("let y = 2;", "js");
    const second = highlightBlock("let y = 2;", "js");
    assert.ok(first !== null && first === second);
  });
});
