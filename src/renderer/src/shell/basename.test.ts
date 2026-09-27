/** basename 的最小回归：两种分隔符、多段、尾分隔符、空段、无分隔符原样返回。 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { basename } from "./basename.ts";

describe("basename —— 显示层截尾", () => {
  test("Windows 反斜杠与 POSIX 斜杠都取尾段", () => {
    assert.equal(basename("C:\\Users\\dama\\Desktop\\p1\\paper3"), "paper3");
    assert.equal(basename("/Users/tester/orbita-lab"), "orbita-lab");
  });

  test("尾分隔符与连续分隔符不产生空尾段", () => {
    assert.equal(basename("C:\\work\\proj\\"), "proj");
    assert.equal(basename("C:\\work\\\\proj\\"), "proj");
  });

  test("没有分隔符就整条返回", () => {
    assert.equal(basename("paper3"), "paper3");
  });
});
