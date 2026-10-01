import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { availableDownloadPath, forceDownloadHeaders } from "./downloads.ts";

// 期望值与假 fs 的 key 一律用 join 拼，与产品代码同一套规则（约定见 data-dirs.test.ts:6-7）：
// 写死 "/d/paper.pdf" 只在 POSIX 上成立，Windows 上产品代码产出的是 "\\d\\paper.pdf"——
// 更隐蔽的是假 exists 用 POSIX 字面量当 key 时永远命中不了，「同名加 (n)」分支在 Windows 上根本没被走到。
test("availableDownloadPath：同名加 (n)，扩展名保留在最后", () => {
  const dir = join("d");
  const taken = new Set([join(dir, "paper.pdf"), join(dir, "paper (1).pdf")]);
  assert.equal(availableDownloadPath(dir, "paper.pdf", (p) => taken.has(p)), join(dir, "paper (2).pdf"));
  assert.equal(availableDownloadPath(dir, "new.csv", (p) => taken.has(p)), join(dir, "new.csv"));
  assert.equal(availableDownloadPath(dir, "README", () => false), join(dir, "README"));
});

test("availableDownloadPath：路径分隔符与隐藏文件前缀剥掉，空名兜底", () => {
  const dir = join("d");
  // sanitize 对 / 与 \ 都剥（实现平台无关），所以直接断言剥完之后的文件名
  assert.equal(availableDownloadPath(dir, "../../etc/passwd", () => false), join(dir, "_.._etc_passwd"));
  assert.equal(availableDownloadPath(dir, "...", () => false), join(dir, "download"));
});

test("forceDownloadHeaders：PDF / CSV / RIS 改成 attachment，保留服务器给的文件名", () => {
  assert.deepEqual(forceDownloadHeaders({ "Content-Type": ["application/pdf"] }), {
    "Content-Type": ["application/pdf"],
    "Content-Disposition": ["attachment"],
  });
  assert.deepEqual(
    forceDownloadHeaders({ "content-type": ["application/pdf"], "content-disposition": ['inline; filename="a.pdf"'] }),
    { "content-type": ["application/pdf"], "Content-Disposition": ['attachment; filename="a.pdf"'] },
  );
  assert.ok(forceDownloadHeaders({ "Content-Type": ["text/csv; charset=utf-8"] }) !== undefined);
  assert.ok(forceDownloadHeaders({ "Content-Type": ["application/x-research-info-systems"] }) !== undefined);
});

test("forceDownloadHeaders：网页与已经是 attachment 的不动", () => {
  assert.equal(forceDownloadHeaders({ "Content-Type": ["text/html"] }), undefined);
  assert.equal(
    forceDownloadHeaders({ "Content-Type": ["application/pdf"], "Content-Disposition": ["attachment; filename=x.pdf"] }),
    undefined,
  );
  assert.equal(forceDownloadHeaders(undefined), undefined);
});
