import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { KERNEL_LIBRARY_NAME, kernelLibraryName } from "./kernel.ts";

describe("库文件命名", () => {
  it("库名由根会话 id 拼出，且过库名白名单；带路径的不过", () => {
    assert.equal(kernelLibraryName("abc-1"), "abc-1.sqlite");
    assert.ok(KERNEL_LIBRARY_NAME.test(kernelLibraryName("abc-1")));
    assert.equal(KERNEL_LIBRARY_NAME.test("../x.sqlite"), false);
    assert.equal(KERNEL_LIBRARY_NAME.test("a/b.sqlite"), false);
  });
});
