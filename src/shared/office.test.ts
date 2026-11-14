/**
 * Office 契约的纯函数：路径规范化 / 区间、batch 拼装、`--json` 解析与改动清单。
 *
 * 这些是全链里最容易错、又最好钉住的一段：模型给的路径千奇百怪，batch 的输出格式
 * 由上游决定——两边都不该靠「跑一遍真二进制才发现」。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  buildOfficeBatch,
  normalizeOfficePath,
  officeChangesFromBatch,
  officeDisplayPath,
  officeFormatOf,
  officePropsOf,
  parseOfficeBatchReport,
  xlsxCellOf,
  xlsxColumnIndex,
  xlsxColumnLabel,
  xlsxRangePath,
  type OfficeOp,
} from "./office.ts";

describe("officeFormatOf / normalizeOfficePath", () => {
  test("只认 .xlsx / .pptx（大小写不敏感）", () => {
    assert.equal(officeFormatOf("/a/b.xlsx"), "xlsx");
    assert.equal(officeFormatOf("C:\\book\\DECK.PPTX"), "pptx");
    assert.equal(officeFormatOf("/a/b.xls"), null);
    assert.equal(officeFormatOf("/a/b.docx"), null);
  });

  test("路径必须 / 开头、不含空白 / 引号 / ..", () => {
    assert.equal(normalizeOfficePath(" /Sheet1/B2 "), "/Sheet1/B2");
    assert.equal(normalizeOfficePath("Sheet1/B2"), null);
    assert.equal(normalizeOfficePath("/Sheet1/B 2"), null);
    assert.equal(normalizeOfficePath('/slide[1]/shape[@id="3"]'), null);
    assert.equal(normalizeOfficePath("/slides/../etc/passwd"), null);
    assert.equal(normalizeOfficePath(""), null);
    assert.equal(normalizeOfficePath(`/${"a".repeat(600)}`), null);
  });
});

describe("xlsx 单元格与区间", () => {
  test("拆单元格 / 列号互转", () => {
    assert.deepEqual(xlsxCellOf("/Sheet1/b2"), { sheet: "Sheet1", cell: "B2" });
    assert.equal(xlsxCellOf("/Sheet1/B2:D5"), null);
    assert.equal(xlsxColumnIndex("A"), 0);
    assert.equal(xlsxColumnIndex("Z"), 25);
    assert.equal(xlsxColumnIndex("AA"), 26);
    assert.equal(xlsxColumnLabel(0), "A");
    assert.equal(xlsxColumnLabel(25), "Z");
    assert.equal(xlsxColumnLabel(26), "AA");
    assert.equal(xlsxColumnLabel(-1), "");
  });

  test("两次点选 → 归一化的区间（反向拖动同一结果）", () => {
    assert.equal(xlsxRangePath("/Sheet1/B2", "/Sheet1/D5"), "/Sheet1/B2:D5");
    assert.equal(xlsxRangePath("/Sheet1/D5", "/Sheet1/B2"), "/Sheet1/B2:D5");
    assert.equal(xlsxRangePath("/Sheet1/B2", "/Sheet1/B2"), "/Sheet1/B2");
    // 跨表没有可表达的形式：回 null，调用方退化成单格
    assert.equal(xlsxRangePath("/Sheet1/B2", "/Sheet2/C3"), null);
    // 不是单元格（整列 / 整行 / 形状）
    assert.equal(xlsxRangePath("/Sheet1/col[A]", "/Sheet1/B2"), null);
  });

  test("给人看的标注：xlsx 用 Sheet!A1 语法，pptx 原样", () => {
    assert.equal(officeDisplayPath("xlsx", "/Sheet1/B2:D5"), "Sheet1!B2:D5");
    assert.equal(officeDisplayPath("xlsx", "/Sheet1/B2"), "Sheet1!B2");
    assert.equal(officeDisplayPath("xlsx", "/Sheet1/col[A]"), "/Sheet1/col[A]");
    assert.equal(officeDisplayPath("pptx", "/slide[3]/table[@id=3]"), "/slide[3]/table[@id=3]");
  });

  test("officePropsOf：数字 / 布尔转成文本，空表当没有", () => {
    assert.deepEqual(officePropsOf({ value: 42, bold: true }), { value: "42", bold: "true" });
    assert.equal(officePropsOf({}), undefined);
    assert.equal(officePropsOf(undefined), undefined);
  });
});

describe("buildOfficeBatch", () => {
  test("set / remove 先读后写；add 直接写（path 是父路径）", () => {
    const ops: OfficeOp[] = [
      { op: "set", path: "/Sheet1/B2", props: { value: 42 } },
      { op: "add", path: "/slide[1]", type: "textbox", props: { text: "Hi" } },
      { op: "remove", path: "/slide[1]/shape[@id=2]" },
    ];
    const { reads, items } = buildOfficeBatch(ops);
    assert.deepEqual(reads, [
      { command: "get", path: "/Sheet1/B2" },
      { command: "get", path: "/slide[1]/shape[@id=2]" },
    ]);
    assert.deepEqual(items, [
      { command: "set", path: "/Sheet1/B2", props: { value: "42" } },
      { command: "add", parent: "/slide[1]", type: "textbox", props: { text: "Hi" } },
      { command: "remove", path: "/slide[1]/shape[@id=2]" },
    ]);
  });

  test("坏路径被丢掉（全坏 → 空批次，调用方据此报错）", () => {
    const { items } = buildOfficeBatch([{ op: "set", path: "Sheet1/B2", props: { value: 1 } }]);
    assert.equal(items.length, 0);
  });
});

describe("parseOfficeBatchReport", () => {
  test("get 的文本 / add 新建的路径 / 失败原因", () => {
    const stdout = JSON.stringify({
      success: false,
      data: {
        results: [
          { index: 0, success: true, output: { results: [{ path: "/Sheet1/B2", text: "42" }] } },
          { index: 1, success: true, output: "Added textbox at /slide[1]/shape[@id=100000]" },
          { index: 2, success: false, error: "Element not found: nope", code: "not_found" },
        ],
      },
    });
    const report = parseOfficeBatchReport(stdout);
    assert.equal(report.parsed, true);
    assert.equal(report.results[0]?.text, "42");
    assert.equal(report.results[1]?.addedPath, "/slide[1]/shape[@id=100000]");
    assert.equal(report.results[1]?.text, null);
    assert.equal(report.results[2]?.error, "Element not found: nope");
    assert.equal(report.failed, 1);
    assert.equal(report.success, false);
  });

  test("不是 JSON（老版本 / 被截断）→ parsed:false，不把成功当失败", () => {
    const report = parseOfficeBatchReport("[1] Updated /Sheet1/B2: value=42\nBatch complete");
    assert.equal(report.parsed, false);
    assert.equal(report.results.length, 0);
  });
});

describe("officeChangesFromBatch", () => {
  test("set：旧值来自读批次，新值来自 props；add 的路径取 batch 回报", () => {
    const ops: OfficeOp[] = [
      { op: "set", path: "/Sheet1/B2", props: { value: 99 } },
      { op: "add", path: "/slide[1]", type: "shape", props: { text: "Hi" } },
    ];
    const report = {
      success: true,
      parsed: true,
      failed: 0,
      results: [
        { index: 0, success: true, text: null, addedPath: null, error: null },
        { index: 1, success: true, text: null, addedPath: "/slide[1]/shape[@id=7]", error: null },
      ],
    };
    const reads = [{ index: 0, success: true, text: "42", addedPath: null, error: null }];
    const { items, failures } = officeChangesFromBatch(ops, report, reads, 1000);
    assert.equal(failures.length, 0);
    assert.deepEqual(
      items.map((item) => [item.command, item.path, item.before, item.after]),
      [
        ["set", "/Sheet1/B2", "42", "99"],
        ["add", "/slide[1]/shape[@id=7]", null, "Hi"],
      ],
    );
    assert.equal(items[0]?.id, "1000:0");
  });

  test("失败项进 failures、不进清单（原子批次里它们本来就没落盘）", () => {
    const ops: OfficeOp[] = [{ op: "remove", path: "/slide[2]" }];
    const report = {
      success: false,
      parsed: true,
      failed: 1,
      results: [{ index: 0, success: false, text: null, addedPath: null, error: "not found" }],
    };
    const { items, failures } = officeChangesFromBatch(ops, report, [], 5);
    assert.equal(items.length, 0);
    assert.deepEqual(failures, [{ path: "/slide[2]", error: "not found" }]);
  });
});
