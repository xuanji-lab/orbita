import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deriveWorkspaceName,
  looksLikePathDerivedName,
  looksLikeWindowsPath,
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

  it("主流系统的路径形都取对尾段——覆盖绝大多数电脑", () => {
    const cases: Array<[string, string]> = [
      ["C:\\Users\\dama\\Desktop\\p1\\paper3", "paper3"], // Windows 盘符
      ["C:/Users/dama/Desktop/p1/paper3", "paper3"], // Windows 正斜杠（混合分隔）
      ["\\\\server\\share\\proj", "proj"], // UNC 网络共享（SMB）
      ["\\\\wsl.localhost\\Ubuntu\\home\\u\\proj", "proj"], // WSL：Windows 选进 Linux 子系统
      ["\\\\?\\C:\\Users\\dama\\proj", "proj"], // Windows 长路径前缀
      ["\\\\Users\\dama\\proj", "proj"], // 当前盘根相对（没有盘符的 Windows 路径）
      ["\\\\?\\UNC\\server\\share\\proj", "proj"], // 长路径前缀 + UNC
      ["/Users/wafo/repo/orbita-lab", "orbita-lab"], // macOS
      ["/home/user/proj", "proj"], // Linux / BSD（POSIX 同形）
      ["/c/Users/dama/proj", "proj"], // Git Bash / MSYS 形
      ["file:///C:/Users/dama/proj", "proj"], // file URI（Windows 盘）
      ["file:///home/user/proj", "proj"], // file URI（POSIX）
    ];
    for (const [path, want] of cases) strictEqual(deriveWorkspaceName(path), want, path);
  });
});

describe("looksLikeWindowsPath", () => {
  it("盘符后不跟分隔符也算——`C:proj` 是盘符相对路径", () => {
    strictEqual(looksLikeWindowsPath("C:proj"), true);
    strictEqual(looksLikeWindowsPath("c:/Users/x"), true);
  });

  it("反斜杠起头：UNC、设备命名空间、当前盘根相对", () => {
    strictEqual(looksLikeWindowsPath("\\\\server\\share"), true);
    strictEqual(looksLikeWindowsPath("\\\\?\\C:\\x"), true);
    strictEqual(looksLikeWindowsPath("\\Users\\dama\\proj"), true);
  });

  // 这一条是 macOS 上的真事：`my\folder` 是一个文件夹名，不是一个目录层级
  it("POSIX 形不认——`\\` 只在这时候才当分隔符", () => {
    strictEqual(looksLikeWindowsPath("/Users/x/my\\folder"), false);
    strictEqual(looksLikeWindowsPath("/home/u/proj"), false);
    strictEqual(looksLikeWindowsPath("my\\folder"), false);
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

  // 2026-09-28 裁决：截断退役——超长名字照实存，显示层 CSS ellipsis 兜底。
  // 截断只会造分尸名：切出来的前缀既不是用户起的名，也不是路径的尾段，两头不是
  it("超长不截断", () => {
    strictEqual(normalizeWorkspaceName("x".repeat(200), "/x/y"), "x".repeat(200));
  });
});

describe("looksLikePathDerivedName", () => {
  // 早期只切 `/` 的派生在 Windows 落库的整条路径。指纹必须收窄到「跟这条记录自己的 path
  // 对得上」：用户自己起的名字是自由显示文本，「像路径」不是理由
  it("整条路径当名字：认出来", () => {
    const win = "C:\\Users\\dama\\Desktop\\p1\\paper3";
    strictEqual(looksLikePathDerivedName(win, win), true);
    strictEqual(
      looksLikePathDerivedName("/Users/wafo/repo/orbita-lab", "/Users/wafo/repo/orbita-lab"),
      true,
    );
  });

  // 老版本的落库链路（addImported / rename 过 normalize）会把 >40 字的路径存成它的
  // 前 40 字。这是同一病根的第二副面孔，而它比「整条路径」更常见（真实路径几乎都过
  // 40 字）——只认第一种就会漏。截断虽已退役（见 WORKSPACE_NAME_MAX），切过的老数据
  // 还在磁盘上，这一档指纹要一直认下去
  it("被 40 上限切过的路径前缀：也认出来", () => {
    const win = "C:\\Users\\dama\\Desktop\\my-super-long-project-folder-name-2026";
    strictEqual(win.length > WORKSPACE_NAME_MAX, true);
    strictEqual(looksLikePathDerivedName(win.slice(0, WORKSPACE_NAME_MAX), win), true);
  });

  it("用户自己起的名字一个字不动——含分隔符的、长度刚好 40 的", () => {
    const path = "/Users/wafo/repo/orbita-lab";
    strictEqual(looksLikePathDerivedName("PhD/Year1", path), false);
    strictEqual(looksLikePathDerivedName("x".repeat(WORKSPACE_NAME_MAX), path), false);
    strictEqual(looksLikePathDerivedName("a\\b", "C:\\Users\\dama\\folder"), false);
  });

  // 盘符大小写在同一条 Windows 路径上可以两样；POSIX 上大小写是文件名的一部分，折了会误伤
  it("大小写只在 Windows 形路径上折", () => {
    strictEqual(looksLikePathDerivedName("c:\\users\\dama\\proj", "C:\\Users\\dama\\proj"), true);
    strictEqual(looksLikePathDerivedName("/users/wafo/proj", "/Users/wafo/proj"), false);
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

  // 解析不改数据：老脏名（名字就是路径）在解析这一层**原样出来**，治它是 store 的
  // v2 → v3 迁移的事。这一条钉住「解析函数不做隐藏的数据变更」
  it("名字原样解析，不在这里治老脏名", () => {
    const win = "C:\\Users\\dama\\Desktop\\p1\\paper3";
    strictEqual(parseWorkspace({ ...valid, path: win, name: win })?.name, win);
    strictEqual(parseWorkspace({ ...valid, name: "PhD/Year1" })?.name, "PhD/Year1");
    strictEqual(parseWorkspace({ ...valid, name: "a\\b" })?.name, "a\\b");
  });

  // 截断退役的另一半：读盘不截。v2 → v3 迁移会把 >40 字的尾段原样落盘（healNames
  // 不截），若 parse 再切一刀，治好的名字只活一个会话——重启变分尸名，写一次盘就回写磁盘
  it("超长名字原样解析，读盘不截断", () => {
    const long = "my-extremely-long-project-directory-name-2026-forever";
    strictEqual(long.length > WORKSPACE_NAME_MAX, true);
    strictEqual(parseWorkspace({ ...valid, name: long })?.name, long);
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
