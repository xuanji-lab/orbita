/**
 * SyncTeX 解析与路径映射的回归网。输入是 **TeX Live 2025 真跑出来的输出**
 * （下面几段就是 synctex 1.5 的原样 stdout，含 CRLF），不是我们编出来的理想格式：
 * 这一层的价值全在「发行版实际写什么」，用自己造的样本测等于测自己的假设。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  forwardSearch,
  insideProject,
  parseEditOutput,
  parseViewOutput,
  reverseSearch,
  synctexCommand,
  synctexFile,
  toPdfRect,
  type SynctexDeps,
  type SynctexRunResult,
} from "./synctex.ts";

/** `synctex view` 的真实输出：一行两盒（居中标题），同一页里出现两组坐标 */
const VIEW_ONE_PAGE = [
  "This is SyncTeX command line utility, version 1.5",
  "SyncTeX result begin",
  "Output:build/main.pdf",
  "Page:1",
  "x:144.561218",
  "y:201.486557",
  "h:133.768356",
  "v:201.486557",
  "W:343.711060",
  "H:6.918498",
  "before:",
  "offset:-1",
  "middle:",
  "after:",
  "SyncTeX result end",
].join("\r\n");

/** 一行跨两页 / 两盒：取第一条，且第二个 Page 之前的盒不能被丢掉前一个字段 */
const VIEW_TWO_BOXES = [
  "SyncTeX result begin",
  "Output:build/main.pdf",
  "Page:1",
  "x:133.768356",
  "y:235.359543",
  "h:133.768356",
  "v:235.359543",
  "W:343.711060",
  "H:6.918498",
  "x:256.018188",
  "y:235.359543",
  "h:133.768356",
  "v:235.359543",
  "W:343.711060",
  "H:6.918498",
  "Page:2",
  "x:133.768356",
  "y:88.130997",
  "h:133.768356",
  "v:90.068166",
  "W:343.711060",
  "H:8.855677",
  "SyncTeX result end",
].join("\n");

/** 缺数据时 synctex 只打版本行、退出 0 —— 解析必须回空，而不是编一个 (0,0) */
const VIEW_EMPTY = "This is SyncTeX command line utility, version 1.5\r\n";

const EDIT_ONE = [
  "This is SyncTeX command line utility, version 1.5",
  "SyncTeX result begin",
  "Output:build/main.pdf",
  "Input:C:/Users/dama/paper/./sections/intro.tex",
  "Line:4",
  "Column:-1",
  "Offset:0",
  "Context:",
  "SyncTeX result end",
].join("\r\n");

const EDIT_TWO = [
  "SyncTeX result begin",
  "Input:C:/Users/dama/paper/./main.tex",
  "Line:9",
  "Column:-1",
  "SyncTeX result end",
  "SyncTeX result begin",
  "Input:C:/Users/dama/paper/./sections/intro.tex",
  "Line:2",
  "Column:3",
  "SyncTeX result end",
].join("\n");

describe("parseViewOutput", () => {
  test("一行一条记录，h/v/W/H 都拿全", () => {
    const boxes = parseViewOutput(VIEW_ONE_PAGE);
    assert.equal(boxes.length, 1);
    const box = boxes[0]!;
    assert.equal(box.page, 1);
    assert.equal(box.x, 144.561218);
    assert.equal(box.h, 133.768356);
    assert.equal(box.width, 343.71106);
    assert.equal(box.height, 6.918498);
  });

  test("同一页的两组坐标 = 两个盒，换页前不吞字段", () => {
    const boxes = parseViewOutput(VIEW_TWO_BOXES);
    assert.equal(boxes.length, 3);
    assert.deepEqual(
      boxes.map((box) => [box.page, Math.round(box.x)]),
      [
        [1, 134],
        [1, 256],
        [2, 134],
      ],
    );
    // 第三条属于第 2 页，高度来自它自己的 H
    assert.equal(boxes[2]!.height, 8.855677);
  });

  test("没有 SyncTeX result begin（缺 .synctex.gz）时回空", () => {
    assert.deepEqual(parseViewOutput(VIEW_EMPTY), []);
  });
});

describe("toPdfRect", () => {
  test("纵向取 v − H 到 v，横向取 h 与 W（PDF 点、左上原点）", () => {
    const rect = toPdfRect({
      page: 1,
      x: 144.56,
      y: 201.49,
      h: 133.77,
      v: 201.49,
      width: 343.71,
      height: 6.92,
    });
    assert.equal(rect.page, 1);
    assert.equal(rect.left, 133.77);
    assert.ok(Math.abs(rect.top - 194.57) < 1e-9, `top=${rect.top}`);
    assert.equal(rect.width, 343.71);
    assert.equal(rect.height, 6.92);
  });

  test("H 缺失时给一个能看见的默认高度，不画零高框", () => {
    const rect = toPdfRect({ page: 1, x: 10, y: 20, h: 10, v: 20, width: 0, height: 0 });
    assert.equal(rect.height, 10);
    assert.equal(rect.top, 10);
  });
});

describe("parseEditOutput", () => {
  test("Input 里的 ./ 保留原样（清理交给 insideProject），Column:-1 → null", () => {
    const hits = parseEditOutput(EDIT_ONE);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.line, 4);
    assert.equal(hits[0]!.column, null);
    assert.match(hits[0]!.input, /\.\/sections\/intro\.tex$/);
  });

  test("多条命中按出现顺序，各自带自己的行号", () => {
    const hits = parseEditOutput(EDIT_TWO);
    assert.deepEqual(
      hits.map((hit) => [hit.line, hit.column]),
      [
        [9, null],
        [2, 3],
      ],
    );
  });

  test("空输出回空", () => {
    assert.deepEqual(parseEditOutput(VIEW_EMPTY), []);
  });
});

describe("insideProject", () => {
  test("项目内：清掉 ./，给绝对路径 + 正斜杠相对路径", () => {
    const dir = resolve("C:/Users/dama/paper");
    const mapped = insideProject(dir, "C:/Users/dama/paper/./sections/intro.tex");
    assert.notEqual(mapped, null);
    assert.equal(mapped!.relative, "sections/intro.tex");
    assert.equal(mapped!.file, resolve(dir, "sections", "intro.tex"));
  });

  test("项目外（系统 .cls）回 null", () => {
    const dir = resolve("C:/Users/dama/paper");
    assert.equal(insideProject(dir, "C:/texlive/2025/texmf-dist/tex/latex/base/article.cls"), null);
  });

  test("同名前缀的兄弟目录不算项目内", () => {
    const dir = resolve("C:/Users/dama/paper");
    assert.equal(insideProject(dir, "C:/Users/dama/paper-other/main.tex"), null);
  });
});

describe("synctexCommand / synctexFile", () => {
  test("与 latexmk 同目录的 synctex.exe 优先（Windows）", () => {
    const latexmk = "G:\\texlive\\2025\\bin\\windows\\latexmk.exe";
    const command = synctexCommand(latexmk, "win32", (path) => path.endsWith("synctex.exe"));
    assert.equal(command, "G:\\texlive\\2025\\bin\\windows\\synctex.exe");
  });

  test("latexmk 是 PATH 上的裸名字时回裸 synctex，让 OS 走同一条 PATH", () => {
    assert.equal(synctexCommand("latexmk", "win32", () => false), "synctex");
    assert.equal(synctexCommand(null, "linux", () => false), "synctex");
  });

  test("索引文件认 .synctex.gz 与未压缩的 .synctex", () => {
    const pdf = resolve("proj", "build", "main.pdf");
    assert.equal(
      synctexFile(pdf, (path) => path.endsWith("main.synctex")),
      resolve("proj", "build", "main.synctex"),
    );
    assert.equal(
      synctexFile(pdf, (path) => path.endsWith("main.synctex.gz")),
      resolve("proj", "build", "main.synctex.gz"),
    );
    assert.equal(synctexFile(pdf, () => false), null);
  });
});

/** 假依赖：记录起过什么命令，按脚本回输出。真 synctex 只在验收里跑 */
function fakeDeps(script: {
  exists: (path: string) => boolean;
  result?: Partial<SynctexRunResult>;
}): SynctexDeps & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    platform: process.platform,
    exists: script.exists,
    calls,
    run: (command, argv) => {
      calls.push([command, ...argv]);
      return Promise.resolve({
        code: 0,
        stdout: "",
        stderr: "",
        spawnError: null,
        ...script.result,
      });
    },
  };
}

describe("forwardSearch / reverseSearch", () => {
  const dir = resolve("C:/Users/dama/paper");
  const pdf = resolve(dir, "build", "main.pdf");
  const source = resolve(dir, "sections", "intro.tex");

  test("没有 PDF → no-pdf，且不起进程", async () => {
    const deps = fakeDeps({ exists: () => false });
    const outcome = await forwardSearch(
      { dir, pdf, file: source, line: 4, column: 1, latexmk: null },
      deps,
    );
    assert.deepEqual(outcome, { ok: false, reason: "no-pdf", detail: pdf });
    assert.equal(deps.calls.length, 0);
  });

  test("有 PDF 没有 .synctex.gz → no-synctex（不是 no-result）", async () => {
    const deps = fakeDeps({ exists: (path) => path === pdf });
    const outcome = await forwardSearch(
      { dir, pdf, file: source, line: 4, column: 1, latexmk: null },
      deps,
    );
    assert.equal(outcome.ok, false);
    assert.equal(!outcome.ok && outcome.reason, "no-synctex");
    assert.equal(deps.calls.length, 0);
  });

  test("有数据：起 view，参数是 line:column:绝对路径 + 绝对 PDF", async () => {
    const deps = fakeDeps({
      exists: () => true,
      result: { stdout: VIEW_ONE_PAGE },
    });
    const outcome = await forwardSearch(
      { dir, pdf, file: source, line: 4, column: 1, latexmk: null },
      deps,
    );
    assert.equal(outcome.ok, true);
    assert.equal(deps.calls.length, 1);
    assert.deepEqual(deps.calls[0], ["synctex", "view", "-i", `4:1:${source}`, "-o", pdf]);
  });

  test("synctex 起来了但没命中 → no-result", async () => {
    const deps = fakeDeps({ exists: () => true, result: { stdout: VIEW_EMPTY } });
    const outcome = await forwardSearch(
      { dir, pdf, file: source, line: 4, column: 1, latexmk: null },
      deps,
    );
    assert.deepEqual(outcome, { ok: false, reason: "no-result", detail: null });
  });

  test("起不来（ENOENT）→ not-installed，detail 带命令名", async () => {
    const deps = fakeDeps({ exists: () => true, result: { spawnError: "ENOENT" } });
    const outcome = await forwardSearch(
      { dir, pdf, file: source, line: 4, column: 1, latexmk: null },
      deps,
    );
    assert.equal(!outcome.ok && outcome.reason, "not-installed");
    assert.match(!outcome.ok ? (outcome.detail ?? "") : "", /synctex.*ENOENT/);
  });

  test("非零退出 → failed，detail 是 stderr", async () => {
    const deps = fakeDeps({
      exists: () => true,
      result: { code: 2, stderr: "SyncTeX error: cannot open file\n" },
    });
    const outcome = await reverseSearch({ dir, pdf, page: 1, x: 10, y: 20, latexmk: null }, deps);
    assert.deepEqual(outcome, { ok: false, reason: "failed", detail: "SyncTeX error: cannot open file" });
  });

  test("反查命中项目内文件：绝对路径 + 相对路径 + 行号", async () => {
    const deps = fakeDeps({ exists: () => true, result: { stdout: EDIT_ONE } });
    const outcome = await reverseSearch({ dir, pdf, page: 1, x: 160, y: 190.004, latexmk: null }, deps);
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      assert.equal(outcome.line, 4);
      assert.equal(outcome.relative, "sections/intro.tex");
      assert.equal(outcome.file, resolve(dir, "sections", "intro.tex"));
    }
    // 坐标按 0.01 pt 收拢后再交给 synctex
    assert.deepEqual(deps.calls[0], ["synctex", "edit", "-o", `1:160:190:${pdf}`]);
  });

  test("反查只命中项目外文件 → outside-project，不打开系统文件", async () => {
    const stdout = [
      "SyncTeX result begin",
      `Input:${resolve("C:/texlive/2025/texmf-dist/tex/latex/base/article.cls")}`,
      "Line:12",
      "SyncTeX result end",
    ].join("\n");
    const deps = fakeDeps({ exists: () => true, result: { stdout } });
    const outcome = await reverseSearch({ dir, pdf, page: 1, x: 10, y: 20, latexmk: null }, deps);
    assert.equal(outcome.ok, false);
    assert.equal(!outcome.ok && outcome.reason, "outside-project");
  });
});

describe("真 FS 上的路径映射（不跑 synctex）", () => {
  test("临时项目里的子目录文件，与 synctex 记下的 <root>/./sub/a.tex 对应上", () => {
    const root = mkdtempSync(join(tmpdir(), "orbita-synctex-"));
    mkdirSync(join(root, "sub"), { recursive: true });
    writeFileSync(join(root, "sub", "a.tex"), "hi\n", "utf8");
    const hit = insideProject(root, join(root, ".", "sub", "a.tex"));
    assert.notEqual(hit, null);
    assert.equal(hit!.relative, "sub/a.tex");
  });
});
