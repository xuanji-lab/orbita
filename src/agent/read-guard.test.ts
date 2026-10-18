import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { guardPath, readBeforeWriteRefusal, recordedGuardKey } from "./read-guard.ts";

const CWD = "C:\\repo";

/** 只有这些路径「存在」；其余当新建处理 */
function existsOnly(paths: string[]) {
  return (path: string) => paths.includes(path);
}

function hasReadFactory(keys: string[]) {
  const set = new Set(keys);
  return (key: string) => set.has(key);
}

describe("guardPath 归一化", () => {
  test("fold：大小写与两种斜杠写法折成同一个 key", () => {
    const a = guardPath("SRC\\A.ts", CWD, true);
    const b = guardPath("src/a.ts", CWD, true);
    assert.equal(a.key, b.key);
    assert.equal(a.resolved, "C:\\repo\\SRC\\A.ts", "报错文案用原样解析的路径，不是折过的 key");
  });

  test("不折：大小写与分隔符保留原样（posix 上 `a\\b` 是合法文件名，折了会把两个文件当成一个）", () => {
    const path = guardPath("C:\\repo\\src\\A.ts", CWD, false);
    assert.equal(path.key, "C:\\repo\\src\\A.ts");
    assert.notEqual(guardPath("c:/repo/src/a.ts", CWD, false).key, path.key);
  });

  test("`~` / 相对路径的解析交给 pi 自己的 resolveToCwd（与 write/edit 工具同一个函数）", () => {
    assert.equal(guardPath("./src/b.ts", CWD, true).key, guardPath("src/b.ts", CWD, true).key);
  });
});

describe("readBeforeWriteRefusal（read-before-write 守卫）", () => {
  test("目标已存在、本会话没读过 → 拦下，理由指名先用 read", () => {
    const reason = readBeforeWriteRefusal(
      { toolName: "write", input: { path: "src/a.ts" } },
      { cwd: CWD, hasRead: hasReadFactory([]), exists: existsOnly(["C:\\repo\\src\\a.ts"]), fold: true },
    );
    assert.notEqual(reason, null);
    assert.match(reason ?? "", /read-before-write guard/);
    assert.match(reason ?? "", /C:\\repo\\src\\a\.ts/, "报错必须给出它要读的那个绝对路径");
    assert.match(reason ?? "", /read tool first/);
  });

  test("edit 同样被拦（不是只守 write）", () => {
    const reason = readBeforeWriteRefusal(
      { toolName: "edit", input: { path: "src/a.ts" } },
      { cwd: CWD, hasRead: hasReadFactory([]), exists: () => true, fold: true },
    );
    assert.notEqual(reason, null);
  });

  test("读过 → 放行", () => {
    const keys = [guardPath("src/a.ts", CWD, true).key];
    const reason = readBeforeWriteRefusal(
      { toolName: "edit", input: { path: "src/a.ts" } },
      { cwd: CWD, hasRead: hasReadFactory(keys), exists: () => true, fold: true },
    );
    assert.equal(reason, null);
  });

  test("路径写法不同（大小写 / 正反斜杠）但指向同一个文件 → 放行", () => {
    const keys = [guardPath("SRC\\A.ts", CWD, true).key];
    const reason = readBeforeWriteRefusal(
      { toolName: "write", input: { path: "./src/a.ts" } },
      { cwd: CWD, hasRead: hasReadFactory(keys), exists: () => true, fold: true },
    );
    assert.equal(reason, null);
  });

  test("目标不存在（write 新建）→ 放行，不看账本", () => {
    const reason = readBeforeWriteRefusal(
      { toolName: "write", input: { path: "src/new.ts" } },
      { cwd: CWD, hasRead: hasReadFactory([]), exists: () => false, fold: true },
    );
    assert.equal(reason, null);
  });

  test("不按路径改文件的工具一律放行（bash / read / grep / MCP）", () => {
    for (const toolName of ["bash", "read", "grep", "ls", "find", "mcp__server__tool"]) {
      const reason = readBeforeWriteRefusal(
        { toolName, input: { path: "src/a.ts" } },
        { cwd: CWD, hasRead: hasReadFactory([]), exists: () => true, fold: true },
      );
      assert.equal(reason, null, `${toolName} 不该被守卫拦`);
    }
  });

  test("入参里没有可用路径 → 放行（交给 pi 自己的入参校验报错）", () => {
    const options = { cwd: CWD, hasRead: hasReadFactory([]), exists: () => true, fold: true };
    for (const input of [{}, { path: "" }, { path: 42 }, { file_path: "src/a.ts" }]) {
      assert.equal(readBeforeWriteRefusal({ toolName: "write", input }, options), null);
    }
  });
});

describe("recordedGuardKey（成功落定后记什么）", () => {
  test("read / write / edit 的成功调用记进账本，key 与守卫查的是同一个", () => {
    for (const toolName of ["read", "write", "edit"]) {
      const key = recordedGuardKey({ toolName, input: { path: "SRC\\A.ts" } }, CWD, true);
      assert.equal(key, guardPath("src/a.ts", CWD, true).key, `${toolName} 的 key 必须与守卫同源`);
    }
  });

  test("其余工具不记账", () => {
    for (const toolName of ["bash", "grep", "ls", "find", "read_task"]) {
      assert.equal(recordedGuardKey({ toolName, input: { path: "src/a.ts" } }, CWD, true), null);
    }
  });

  test("没有路径的调用不记账", () => {
    assert.equal(recordedGuardKey({ toolName: "read", input: {} }, CWD, true), null);
    assert.equal(recordedGuardKey({ toolName: "read", input: { path: "" } }, CWD, true), null);
  });
});
