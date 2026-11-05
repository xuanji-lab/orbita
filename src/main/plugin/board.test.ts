import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PluginProblem } from "../../shared/plugin.ts";
import { parseBoard } from "./board.ts";
import { parseExternal, parseIo, parseTuned } from "./extras.ts";
import { parseWorkflow } from "./workflow.ts";

const manifest = (orbita: unknown): Record<string, unknown> => ({ name: "x", orbita });
const card = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ id: "a", size: "1x1", template: "./a.html", ...extra });

describe("parseBoard", () => {
  test("没有 orbita / 没有 board：null，不报问题", () => {
    const problems: PluginProblem[] = [];
    assert.equal(parseBoard({ name: "x" }, "X", problems), null);
    assert.equal(parseBoard(manifest({ workflow: [] }), "X", problems), null);
    assert.deepEqual(problems, []);
  });

  test("正常：标题缺省退回显示名，卡名缺省退回 id，路径去首尾空白，四档尺寸都认", () => {
    const problems: PluginProblem[] = [];
    const board = parseBoard(
      manifest({
        board: {
          spec: " ./spec.md ",
          cards: [
            card({ id: "a", size: "1x1" }),
            card({ id: "b", size: "2x1", title: "宽卡", note: "一句话", data: " ${CLAUDE_PLUGIN_DATA}/b.json ", sample: "./b.sample.json", repeat: "items" }),
            card({ id: "c", size: "1x2" }),
            card({ id: "d", size: "2x2" }),
          ],
        },
      }),
      "显示名",
      problems,
    );
    assert.deepEqual(problems, []);
    assert.equal(board?.title, "显示名");
    assert.equal(board?.spec, "./spec.md");
    assert.deepEqual(board?.cards.map((each) => [each.id, each.size, each.title]), [["a", "1x1", "a"], ["b", "2x1", "宽卡"], ["c", "1x2", "c"], ["d", "2x2", "d"]]);
    assert.deepEqual(board?.cards[1], {
      id: "b",
      title: "宽卡",
      size: "2x1",
      note: "一句话",
      template: "./a.html",
      data: "${CLAUDE_PLUGIN_DATA}/b.json",
      sample: "./b.sample.json",
      repeat: "items",
    });
  });

  test("坏的那张跳过并报 board-invalid，好的照常：id 不合规 / 重复、尺寸不认识、缺 template、不是对象", () => {
    const problems: PluginProblem[] = [];
    const board = parseBoard(
      manifest({
        board: {
          cards: [
            card({ id: "ok" }),
            card({ id: "Bad_Id" }),
            card({ id: "ok" }),
            card({ id: "big", size: "3x3" }),
            card({ id: "nosize", size: undefined }),
            { id: "notpl", size: "1x1" },
            "x",
          ],
        },
      }),
      "X",
      problems,
    );
    assert.deepEqual(board?.cards.map((each) => each.id), ["ok"]);
    assert.equal(problems.length, 6);
    assert.ok(problems.every((problem) => problem.kind === "board-invalid"));
  });

  test("一张能用的都没有：整块 null；board 不是对象 / cards 不是数组都报问题", () => {
    for (const board of [5, { cards: "x" }, { title: "t" }, { cards: [] }, { cards: [{}] }]) {
      const problems: PluginProblem[] = [];
      assert.equal(parseBoard(manifest({ board }), "X", problems), null, JSON.stringify(board));
      if (!Array.isArray((board as { cards?: unknown }).cards) || (board as { cards: unknown[] }).cards.length > 0) assert.ok(problems.length > 0, JSON.stringify(board));
    }
  });

  test("卡片声明最多 12 张，多的忽略并报一条", () => {
    const problems: PluginProblem[] = [];
    const cards = Array.from({ length: 15 }, (_, index) => card({ id: `c${index}` }));
    assert.equal(parseBoard(manifest({ board: { cards } }), "X", problems)?.cards.length, 12);
    assert.equal(problems.length, 1);
  });

  test("repeat：只认顶层属性名，且要有 data 或 sample，否则当没写并报问题", () => {
    const problems: PluginProblem[] = [];
    const board = parseBoard(
      manifest({
        board: {
          cards: [
            card({ id: "a", data: "d.json", repeat: "items" }),
            card({ id: "b", repeat: "items" }),
            card({ id: "c", data: "d.json", repeat: "a.b" }),
            card({ id: "d", sample: "s.json", repeat: "items" }),
          ],
        },
      }),
      "X",
      problems,
    );
    assert.deepEqual(board?.cards.map((each) => each.repeat), ["items", null, null, "items"]);
    assert.equal(problems.length, 2);
  });

  test("已作废的 orbita.panel：报 panel-renamed，不渲染（没有 board 就是 null）", () => {
    const problems: PluginProblem[] = [];
    assert.equal(parseBoard(manifest({ panel: { template: "./a.html", data: "./b.json" } }), "X", problems), null);
    assert.deepEqual(problems, [{ kind: "panel-renamed", detail: "orbita.panel" }]);
  });

  test("过长的字段截断，不报错", () => {
    const board = parseBoard(manifest({ board: { title: "t".repeat(500), cards: [card({ title: "n".repeat(500), note: "x".repeat(900) })] } }), "X", []);
    assert.ok((board?.title.length ?? 999) <= 80);
    assert.ok((board?.cards[0]?.title.length ?? 999) <= 80);
    assert.ok((board?.cards[0]?.note?.length ?? 999) <= 200);
  });
});

describe("parseIo / parseExternal / parseTuned", () => {
  test("io：读写两列，项可以是路径字符串或 {path, note, when}；坏项跳过并报", () => {
    const problems: PluginProblem[] = [];
    const io = parseIo(
      manifest({
        io: {
          reads: ["intent.md", { path: "p/", note: "论文库" }, { note: "没路径" }, 3],
          writes: [{ path: "data/today.json", note: "看板读它", when: "每天" }],
        },
      }),
      problems,
    );
    assert.deepEqual(io.reads, [{ path: "intent.md", note: null, when: null }, { path: "p/", note: "论文库", when: null }]);
    assert.deepEqual(io.writes, [{ path: "data/today.json", note: "看板读它", when: "每天" }]);
    assert.equal(problems.length, 2);
  });

  test("io 没写：两个空数组；写成别的形状：空 + 报问题", () => {
    const problems: PluginProblem[] = [];
    assert.deepEqual(parseIo({}, problems), { reads: [], writes: [] });
    assert.deepEqual(parseIo(manifest({ io: [] }), problems), { reads: [], writes: [] });
    assert.deepEqual(parseIo(manifest({ io: { reads: "x" } }), problems).reads, []);
    assert.equal(problems.length, 2);
  });

  test("external：名字 + 四种 kind；account / resident 没写为 null；kind 不认识或缺 name 跳过并报", () => {
    const problems: PluginProblem[] = [];
    const items = parseExternal(
      manifest({
        external: [
          { name: "S2", kind: "api", account: false, resident: false, note: "只在跑的时候联网" },
          { name: "gh", kind: "cli" },
          { name: "z", kind: "ftp" },
          { kind: "api" },
          { name: "m", kind: "mcp", account: "yes" },
        ],
      }),
      problems,
    );
    assert.deepEqual(items.map((each) => [each.name, each.kind, each.account, each.resident]), [["S2", "api", false, false], ["gh", "cli", null, null], ["m", "mcp", null, null]]);
    assert.equal(problems.length, 3);
    assert.deepEqual(parseExternal(manifest({ external: {} }), []), []);
  });

  test("tuned：true / false；没写 false；别的值当 false 并报", () => {
    const problems: PluginProblem[] = [];
    assert.equal(parseTuned(manifest({ tuned: true }), problems), true);
    assert.equal(parseTuned(manifest({}), problems), false);
    assert.deepEqual(problems, []);
    assert.equal(parseTuned(manifest({ tuned: "yes" }), problems), false);
    assert.equal(problems.length, 1);
  });
});

describe("workflow 的 wait", () => {
  test("board / chat 认；不写 null；别的值当没写并报", () => {
    const problems: PluginProblem[] = [];
    const steps = parseWorkflow(
      manifest({ workflow: [{ title: "a", wait: "board" }, { title: "b", wait: "chat" }, { title: "c" }, { title: "d", wait: null }, { title: "e", wait: "phone" }] }),
      [],
      problems,
    );
    assert.deepEqual(steps.map((step) => step.wait), ["board", "chat", null, null, null]);
    assert.equal(problems.length, 1);
  });
});
