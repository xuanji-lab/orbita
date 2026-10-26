import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { zh } from "../../messages-zh.ts";
import {
  absoluteReviewPath,
  disambiguatedDirs,
  reviewEmptyText,
  reviewEmptyTitle,
  unifiedDiffEntries,
} from "./review-panel.ts";

describe("unifiedDiffEntries", () => {
  test("unified diff → DiffBody 条目：@@ 头不进正文、行号按新旧行、一删一增配对", () => {
    const diff = [
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,3 +1,3 @@",
      " context",
      "-old line",
      "+new line",
      " tail",
    ].join("\n");
    const entries = unifiedDiffEntries(diff);
    // 一删一增 → 词级配对一个 pair + 两条 ctx
    assert.deepEqual(
      entries.map((entry) => (entry.kind === "pair" ? "pair" : entry.row.kind)),
      ["ctx", "pair", "ctx"],
    );
    const pair = entries[1];
    assert.equal(pair?.kind, "pair");
    if (pair?.kind === "pair") {
      assert.equal(pair.removed.lineNum, "2");
      assert.equal(pair.added.lineNum, "2");
      assert.equal(pair.removed.text, "old line");
      assert.equal(pair.added.text, "new line");
    }
    // 上下文行带新行号
    const first = entries[0];
    assert.equal(first?.kind === "row" ? first.row.lineNum : "", "1");
  });

  test("多删多增不成对：整块行各自渲染", () => {
    const diff = ["@@ -1,2 +1,3 @@", "-a", "-b", "+x", "+y", "+z"].join("\n");
    const entries = unifiedDiffEntries(diff);
    assert.deepEqual(
      entries.map((entry) => (entry.kind === "pair" ? "pair" : entry.row.kind)),
      ["del", "del", "add", "add", "add"],
    );
  });

  test("空 diff → 空数组", () => {
    assert.deepEqual(unifiedDiffEntries(""), []);
  });
});

test("jsdiff 的 `=====` 分隔行与 Index 头不进正文（实机：被画成第 0 行）", () => {
  const diff = [
    "Index: a/x.html",
    "===================================================================",
    "--- a/x.html",
    "+++ b/x.html",
    "@@ -0,0 +1,2 @@",
    "+<h1>hi</h1>",
    "+<p>x</p>",
  ].join("\n");
  const rows = unifiedDiffEntries(diff);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((entry) => entry.kind !== "pair" && entry.row.kind === "add"));
});

describe("absoluteReviewPath（审查行 2026-10-18 改版：title / 复制 / reveal 用绝对路径）", () => {
  test("task 来源本就是绝对路径（resolveToCwd），原样返回", () => {
    assert.equal(absoluteReviewPath("/Users/x/ws/a.ts", "task", "/Users/x/ws"), "/Users/x/ws/a.ts");
  });

  test("git 来源是仓库相对路径，按会话 cwd 拼（与主进程 untrackedEntries 同口径）", () => {
    assert.equal(absoluteReviewPath("src/a.ts", "unstaged", "/Users/x/ws"), "/Users/x/ws/src/a.ts");
  });

  test("cwd 缺失（列表没回来 / 空串）时不硬造，原样返回", () => {
    assert.equal(absoluteReviewPath("src/a.ts", "staged", null), "src/a.ts");
    assert.equal(absoluteReviewPath("src/a.ts", "branch", ""), "src/a.ts");
  });
});

describe("disambiguatedDirs（重名文件补最短区分父目录）", () => {
  test("无重名：全部 null，行里只显文件名", () => {
    const dirs = disambiguatedDirs(["a/shot.mjs", "b/fold.ts", "c/other.mjs"], null);
    assert.equal(dirs.get("a/shot.mjs"), null);
    assert.equal(dirs.get("b/fold.ts"), null);
    assert.equal(dirs.get("c/other.mjs"), null);
  });

  test("两个同名 shot.mjs：各补一段区分父目录", () => {
    const dirs = disambiguatedDirs(["smoke/shot.mjs", "ui/shot.mjs", "a/fold.ts"], null);
    assert.equal(dirs.get("smoke/shot.mjs"), "smoke");
    assert.equal(dirs.get("ui/shot.mjs"), "ui");
    // 独一份的名字不补
    assert.equal(dirs.get("a/fold.ts"), null);
  });

  test("最后一段撞车（x 出现两次）：整组统一补到两段", () => {
    const dirs = disambiguatedDirs(["a/x/shot.mjs", "b/x/shot.mjs"], null);
    assert.equal(dirs.get("a/x/shot.mjs"), "a/x");
    assert.equal(dirs.get("b/x/shot.mjs"), "b/x");
  });

  test("深度不同也能区分：浅的那个用全部目录，深的补到分得开为止", () => {
    const dirs = disambiguatedDirs(["x/shot.mjs", "b/x/shot.mjs"], null);
    assert.equal(dirs.get("x/shot.mjs"), "x");
    assert.equal(dirs.get("b/x/shot.mjs"), "b/x");
  });

  test("根下同名文件：目录为空串（显示层不补段），另一个补一段", () => {
    const dirs = disambiguatedDirs(["shot.mjs", "x/shot.mjs"], null);
    assert.equal(dirs.get("shot.mjs"), "");
    assert.equal(dirs.get("x/shot.mjs"), "x");
  });

  test("task 来源的绝对路径先按 cwd 剥再分组（pathParts 同一口径）", () => {
    const dirs = disambiguatedDirs(
      ["/ws/smoke/shot.mjs", "/ws/ui/shot.mjs", "/ws/fold.ts"],
      "/ws",
    );
    assert.equal(dirs.get("/ws/smoke/shot.mjs"), "smoke");
    assert.equal(dirs.get("/ws/ui/shot.mjs"), "ui");
    assert.equal(dirs.get("/ws/fold.ts"), null);
  });
});

describe("空态文案", () => {
  test("no-changes：标题是「还没有改动」，说明句不再重复同一句", () => {
    const list = { kind: "empty", reason: "no-changes", cwd: "/w" } as const;
    const title = reviewEmptyTitle(list, zh);
    const detail = reviewEmptyText(list, zh, "task");
    assert.equal(title, zh.review.emptyNoChanges);
    assert.notEqual(detail, title);
    assert.equal(detail, zh.review.emptyNoChangesDetail("task"));
  });

  test("no-changes 的说明句跟着来源走（task 与 git 来源不同）", () => {
    const list = { kind: "empty", reason: "no-changes", cwd: "/w" } as const;
    assert.equal(reviewEmptyText(list, zh, "unstaged"), zh.review.emptyNoChangesDetail("unstaged"));
    assert.notEqual(reviewEmptyText(list, zh, "unstaged"), reviewEmptyText(list, zh, "task"));
  });

  test("其它空态理由的标题与说明句不同（没有顺手重复的老毛病）", () => {
    const notRepo = { kind: "empty", reason: "not-repo", cwd: "/w" } as const;
    const noGit = { kind: "empty", reason: "no-git", cwd: "/w" } as const;
    assert.notEqual(reviewEmptyTitle(notRepo, zh), reviewEmptyText(notRepo, zh, "unstaged"));
    assert.notEqual(reviewEmptyTitle(noGit, zh), reviewEmptyText(noGit, zh, "unstaged"));
  });
});
