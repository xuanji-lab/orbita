import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deriveWorkspaceName,
  normalizeWorkspaceName,
  parseWorkspace,
  WORKSPACE_NAME_MAX,
  type Workspace,
} from "./workspace.ts";

const valid: Workspace = {
  id: "w-1",
  name: "orbita-lab",
  path: "/Users/wafo/Documents/repo/orbita-lab",
  createdAt: 1000,
  attachedDirs: [],
};

describe("deriveWorkspaceName", () => {
  it("取路径最后一段", () => {
    strictEqual(deriveWorkspaceName("/Users/wafo/repo/orbita-lab"), "orbita-lab");
  });

  it("Windows 反斜杠路径也取最后一段（只切 `/` 会把整条 C:\\… 当成名字）", () => {
    strictEqual(deriveWorkspaceName("C:\\Users\\dama\\Desktop\\p1\\paper3"), "paper3");
  });

  it("UNC 路径取最后一段", () => {
    strictEqual(deriveWorkspaceName("\\\\server\\share\\proj"), "proj");
  });

  it("POSIX 路径里 \\ 是文件夹名的合法字符，不当分隔符切", () => {
    strictEqual(deriveWorkspaceName("/Users/x/my\\folder"), "my\\folder");
  });

  it("结尾的斜杠不影响", () => {
    strictEqual(deriveWorkspaceName("/Users/wafo/repo/orbita-lab/"), "orbita-lab");
  });

  it("连续分隔符不产生空尾段", () => {
    strictEqual(deriveWorkspaceName("C:\\work\\\\proj\\"), "proj");
  });

  it("没有分隔符就整条返回", () => {
    strictEqual(deriveWorkspaceName("paper3"), "paper3");
  });

  it("根目录退回原路径，不给空名字", () => {
    strictEqual(deriveWorkspaceName("/"), "/");
  });
});

describe("normalizeWorkspaceName", () => {
  it("前后空白去掉", () => {
    strictEqual(normalizeWorkspaceName("  我的项目  ", "/x/y"), "我的项目");
  });

  // 空名字在侧栏里是一行看不见的东西，用户会以为工作区丢了
  it("全空白退回路径末段，不留空名字", () => {
    strictEqual(normalizeWorkspaceName("   ", "/Users/wafo/repo/orbita-lab"), "orbita-lab");
    strictEqual(normalizeWorkspaceName("", "/Users/wafo/repo/orbita-lab"), "orbita-lab");
  });

  it("超长截断——侧栏只有 288px", () => {
    strictEqual(normalizeWorkspaceName("x".repeat(200), "/x/y").length, WORKSPACE_NAME_MAX);
  });
});

describe("parseWorkspace", () => {
  it("完整的一条原样解出来", () => {
    deepStrictEqual(parseWorkspace(valid), valid);
  });

  // 一条路径编出来的工作区会把 agent 指向一个不存在的目录
  it("缺 id 或 path 返回 null，让调用方跳过这条", () => {
    strictEqual(parseWorkspace({ ...valid, id: undefined }), null);
    strictEqual(parseWorkspace({ ...valid, path: undefined }), null);
    strictEqual(parseWorkspace({ ...valid, id: "" }), null);
    strictEqual(parseWorkspace({ ...valid, path: "" }), null);
    strictEqual(parseWorkspace(null), null);
    strictEqual(parseWorkspace("{}"), null);
    strictEqual(parseWorkspace([]), null);
  });

  it("缺名字就用路径末段", () => {
    strictEqual(parseWorkspace({ ...valid, name: undefined })?.name, "orbita-lab");
    strictEqual(parseWorkspace({ ...valid, name: "   " })?.name, "orbita-lab");
  });

  // 早期只切 `/` 的派生在 Windows 落库的整条路径：读时截回尾段（磁盘不动，写回自然落净）。
  // 不治的话，超长老路径名会在改名回车时被 40 上限切成分尸名落库。
  it("名字仍是路径形读时治病——截回尾段；Mac 的 a\\b 合法名字原样保留", () => {
    strictEqual(parseWorkspace({ ...valid, name: "C:\\Users\\dama\\Desktop\\p1\\paper3" })?.name, "paper3");
    strictEqual(parseWorkspace({ ...valid, name: "a/b" })?.name, "b");
    strictEqual(parseWorkspace({ ...valid, name: "/Users/wafo/repo/orbita-lab" })?.name, "orbita-lab");
    strictEqual(parseWorkspace({ ...valid, name: "a\\b" })?.name, "a\\b");
  });

  it("缺 createdAt 给 0，不因为一个时间戳丢掉整条工作区", () => {
    strictEqual(parseWorkspace({ ...valid, createdAt: undefined })?.createdAt, 0);
  });

  it("缺 attachedDirs 解析为空数组——字段之前存的工作区不迁移", () => {
    deepStrictEqual(parseWorkspace({ ...valid, attachedDirs: undefined })?.attachedDirs, []);
  });

  it("attachedDirs 不是数组时解析为空数组", () => {
    deepStrictEqual(parseWorkspace({ ...valid, attachedDirs: "x" })?.attachedDirs, []);
    deepStrictEqual(parseWorkspace({ ...valid, attachedDirs: {} })?.attachedDirs, []);
  });

  it("attachedDirs 混入空串、数字、重复项时只留合法且去重保序", () => {
    deepStrictEqual(
      parseWorkspace({ ...valid, attachedDirs: ["/a", "", 1, "/b", "/a"] })?.attachedDirs,
      ["/a", "/b"],
    );
  });

  it("不认识的字段丢掉", () => {
    deepStrictEqual(parseWorkspace({ ...valid, branch: "main", junk: 1 }), valid);
  });
});
