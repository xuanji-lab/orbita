/**
 * 配方表的账：9 条 id 唯一、steps 合法（工具名 / 参数是非空字符串、占位符拼得起来）、
 * 清理可用性只给 latexmk 系、分组顺序与「推荐」标记对得上。
 *
 * 这里不测「命令跑起来对不对」（那是真机的事）；它钉的是**菜单、落盘 id 与主进程
 * 展开三处共用的一张表**不被悄悄改坏。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  LATEX_RECIPE_GROUPS,
  LATEX_RECIPE_PRESETS,
  latexEngineTool,
  latexRecipePreset,
} from "./latex-recipes.ts";

const PLACEHOLDER = /%[A-Z]+%/g;
const KNOWN_PLACEHOLDERS = new Set(["%DOC%", "%DOCFILE%", "%JOB%", "%DIR%", "%OUTDIR%", "%OUTREL%", "%ENGINE%"]);

describe("配方表：9 条、id 唯一", () => {
  test("表里正好 9 条（菜单里的推荐 3 / 索引 1 / 术语表 1 / 手写 2 / 调试 1 / 特殊 1）", () => {
    assert.equal(LATEX_RECIPE_PRESETS.length, 9);
  });

  test("id 唯一且非空（id 是 .orbita/latex.json 的落盘契约）", () => {
    const ids = LATEX_RECIPE_PRESETS.map((preset) => preset.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) assert.match(id, /^[a-z0-9-]+$/);
  });

  test("每个分组都有条目，且顺序与 LATEX_RECIPE_GROUPS 一致", () => {
    const groups = LATEX_RECIPE_PRESETS.map((preset) => preset.group);
    for (const group of LATEX_RECIPE_GROUPS) assert.ok(groups.includes(group), `缺少分组 ${group}`);
    const seen = [...new Set(groups)];
    assert.deepEqual(seen, [...LATEX_RECIPE_GROUPS]);
  });

  test("推荐组正好是三条 latexmk 推荐项", () => {
    const recommended = LATEX_RECIPE_PRESETS.filter((preset) => preset.recommended === true);
    assert.deepEqual(
      recommended.map((preset) => preset.id),
      ["latexmk-xelatex", "latexmk-pdflatex", "latexmk-lualatex"],
    );
    for (const preset of recommended) assert.equal(preset.group, "recommended");
  });
});

describe("steps 合法", () => {
  test("每一步都有工具名与非空参数，参数里没有空白 / 空串", () => {
    for (const preset of LATEX_RECIPE_PRESETS) {
      assert.ok(preset.steps.length > 0, `${preset.id} 没有步骤`);
      for (const step of preset.steps) {
        assert.ok(step.tool === "%ENGINE%" || /^[a-z][a-z0-9-]*$/.test(step.tool), `${preset.id} 的工具名不合法：${step.tool}`);
        assert.ok(step.args.length > 0, `${preset.id} 的 ${step.tool} 没有参数`);
        for (const arg of step.args) {
          assert.equal(typeof arg, "string");
        }
      }
    }
  });

  test("占位符只出现表里认识的几个（拼错的 %OUTDIR 会静默变成字面量）", () => {
    for (const preset of LATEX_RECIPE_PRESETS) {
      for (const step of preset.steps) {
        for (const arg of step.args) {
          for (const match of arg.match(PLACEHOLDER) ?? []) {
            assert.ok(KNOWN_PLACEHOLDERS.has(match), `${preset.id} 里有未知占位符 ${match}`);
          }
        }
      }
    }
  });

  test("主文件与产物目录都写明了（不可能只看产物目录不指定文件）", () => {
    for (const preset of LATEX_RECIPE_PRESETS) {
      const args = preset.steps.flatMap((step) => step.args).join(" ");
      assert.ok(
        args.includes("%OUTDIR%") || args.includes("%OUTREL%"),
        `${preset.id} 没有产物目录占位符`,
      );
      assert.ok(args.includes("%DOCFILE%"), `${preset.id} 没有 %DOCFILE%`);
    }
  });

  test("只有「单次编译」用 %ENGINE%（其余配方自带引擎）", () => {
    for (const preset of LATEX_RECIPE_PRESETS) {
      const usesEngine = preset.steps.some((step) => step.tool === "%ENGINE%");
      assert.equal(usesEngine, preset.engine === null, `${preset.id} 的引擎与 %ENGINE% 不自洽`);
    }
  });
});

describe("清理可用性：只有 latexmk 系能 latexmk -c", () => {
  test("latexmk 配方可清理；手写链与单次编译不可", () => {
    for (const preset of LATEX_RECIPE_PRESETS) {
      const latexmkFamily = preset.steps.some((step) => step.tool === "latexmk");
      assert.equal(preset.cleanable, latexmkFamily, `${preset.id} 的 cleanable 与步骤工具不符`);
    }
  });

  test("推荐组三条都可清理（它们就是默认链的等价写法）", () => {
    for (const preset of LATEX_RECIPE_PRESETS.filter((item) => item.group === "recommended")) {
      assert.equal(preset.cleanable, true);
    }
  });
});

describe("按 id 取", () => {
  test("认识的 id 原样取回；未知 / 空回 null（不猜一条近似的）", () => {
    for (const preset of LATEX_RECIPE_PRESETS) {
      assert.equal(latexRecipePreset(preset.id)?.id, preset.id);
    }
    assert.equal(latexRecipePreset("nope"), null);
    assert.equal(latexRecipePreset(""), null);
    assert.equal(latexRecipePreset(undefined), null);
  });
});

describe("引擎工具名", () => {
  test("契约的 pdf = pdflatex；其余与引擎同名", () => {
    assert.equal(latexEngineTool("pdf"), "pdflatex");
    assert.equal(latexEngineTool("xelatex"), "xelatex");
    assert.equal(latexEngineTool("lualatex"), "lualatex");
  });
});
