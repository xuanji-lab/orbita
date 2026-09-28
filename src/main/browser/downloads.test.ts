import { test } from "node:test";
import assert from "node:assert/strict";
import { availableDownloadPath, forceDownloadHeaders } from "./downloads.ts";

test("availableDownloadPath：同名加 (n)，扩展名保留在最后", () => {
  const taken = new Set(["/d/paper.pdf", "/d/paper (1).pdf"]);
  assert.equal(availableDownloadPath("/d", "paper.pdf", (p) => taken.has(p)), "/d/paper (2).pdf");
  assert.equal(availableDownloadPath("/d", "new.csv", (p) => taken.has(p)), "/d/new.csv");
  assert.equal(availableDownloadPath("/d", "README", () => false), "/d/README");
});

test("availableDownloadPath：路径分隔符与隐藏文件前缀剥掉，空名兜底", () => {
  const escaped = availableDownloadPath("/d", "../../etc/passwd", () => false);
  assert.ok(escaped.startsWith("/d/") && !escaped.slice(3).includes("/"), escaped);
  assert.equal(availableDownloadPath("/d", "...", () => false), "/d/download");
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
