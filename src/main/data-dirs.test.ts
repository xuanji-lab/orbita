import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { devDataDirs } from "./data-dirs.ts";

// 期望值一律用 join 拼，与产品代码同一套规则：写死 "/AS/orbita-dev" 只在 POSIX 上成立，
// Windows 上产品代码产出的是 "\\AS\\orbita-dev"——那是分隔符差异，不是产品行为差异。
const APP_DATA = "/AS";
const HOME = "/Users/me";

/** 正式版的名字：userData 是 orbita，工作区根是 Orbita（Electron / WorkspaceStore 的默认值） */
const PACKAGED_USER_DATA = join(APP_DATA, "orbita");
const PACKAGED_ORBITA_ROOT = join(HOME, "Orbita");

describe("devDataDirs", () => {
  test("正式版不改路径：返回 null，沿用 Electron 与 WorkspaceStore 的默认值", () => {
    assert.equal(devDataDirs({ packaged: true, appData: APP_DATA, home: HOME }), null);
  });

  test("开发版：userData 挪到 orbita-dev，工作区根挪到 ~/Orbita-dev", () => {
    assert.deepEqual(devDataDirs({ packaged: false, appData: APP_DATA, home: HOME }), {
      userData: join(APP_DATA, "orbita-dev"),
      orbitaRoot: join(HOME, "Orbita-dev"),
    });
  });

  test("开发版的两个目录都不与正式版撞（大小写不敏感的 APFS 上也不撞）", () => {
    const dev = devDataDirs({ packaged: false, appData: APP_DATA, home: HOME });
    assert.notEqual(dev?.userData.toLowerCase(), PACKAGED_USER_DATA.toLowerCase());
    assert.notEqual(dev?.orbitaRoot.toLowerCase(), PACKAGED_ORBITA_ROOT.toLowerCase());
  });
});

describe("devDataDirs —— 显式 --user-data-dir（隔离实例）", () => {
  test("工作区根跟 userData 目录名走：orbita-dev-2 → ~/Orbita-dev-2", () => {
    assert.deepEqual(
      devDataDirs({ packaged: false, appData: APP_DATA, home: HOME, userDataSwitch: join(APP_DATA, "orbita-dev-2") }),
      { userData: join(APP_DATA, "orbita-dev-2"), orbitaRoot: join(HOME, "Orbita-dev-2") },
    );
  });

  test("目录名不带 orbita- 前缀也行：accept → ~/Orbita-accept", () => {
    assert.equal(
      devDataDirs({ packaged: false, appData: APP_DATA, home: HOME, userDataSwitch: join(APP_DATA, "accept") })?.orbitaRoot,
      join(HOME, "Orbita-accept"),
    );
  });

  test("尾部分隔符不碍事：orbita-dev-2/ 与无尾斜杠同结果", () => {
    const withSlash = devDataDirs({ packaged: false, appData: APP_DATA, home: HOME, userDataSwitch: `${join(APP_DATA, "orbita-dev-2")}/` });
    const bare = devDataDirs({ packaged: false, appData: APP_DATA, home: HOME, userDataSwitch: join(APP_DATA, "orbita-dev-2") });
    assert.deepEqual(withSlash, bare);
  });

  test("空串与未给等价：走默认开发版目录", () => {
    assert.deepEqual(
      devDataDirs({ packaged: false, appData: APP_DATA, home: HOME, userDataSwitch: "" }),
      devDataDirs({ packaged: false, appData: APP_DATA, home: HOME }),
    );
  });

  test("隔离实例的工作区根也不与正式版撞", () => {
    const iso = devDataDirs({ packaged: false, appData: APP_DATA, home: HOME, userDataSwitch: join(APP_DATA, "orbita-dev-2") });
    assert.notEqual(iso?.orbitaRoot.toLowerCase(), PACKAGED_ORBITA_ROOT.toLowerCase());
  });

  test("正式版带 --user-data-dir 也不改路径：packaged 优先返回 null", () => {
    assert.equal(
      devDataDirs({ packaged: true, appData: APP_DATA, home: HOME, userDataSwitch: join(APP_DATA, "orbita-dev-2") }),
      null,
    );
  });
});

describe("devDataDirs —— ORBITA_DEV_INSTANCE（一键隔离）", () => {
  test("按名字分 userData 与工作区根：2 → orbita-dev-2 / ~/Orbita-dev-2", () => {
    assert.deepEqual(devDataDirs({ packaged: false, appData: APP_DATA, home: HOME, instance: "2" }), {
      userData: join(APP_DATA, "orbita-dev-2"),
      orbitaRoot: join(HOME, "Orbita-dev-2"),
    });
  });

  test("与 --user-data-dir orbita-dev-2 落到同一对目录：两种给法是同一个实例", () => {
    assert.deepEqual(
      devDataDirs({ packaged: false, appData: APP_DATA, home: HOME, instance: "2" }),
      devDataDirs({ packaged: false, appData: APP_DATA, home: HOME, userDataSwitch: join(APP_DATA, "orbita-dev-2") }),
    );
  });

  test("空串与未给等价：走默认开发版目录", () => {
    assert.deepEqual(
      devDataDirs({ packaged: false, appData: APP_DATA, home: HOME, instance: "" }),
      devDataDirs({ packaged: false, appData: APP_DATA, home: HOME }),
    );
  });

  test("--user-data-dir 优先于环境变量", () => {
    assert.equal(
      devDataDirs({ packaged: false, appData: APP_DATA, home: HOME, instance: "2", userDataSwitch: join(APP_DATA, "orbita-accept") })?.userData,
      join(APP_DATA, "orbita-accept"),
    );
  });

  test("名字带路径字符就报错，不悄悄落回共享目录", () => {
    for (const bad of ["../x", "a/b", "a\\b", "-x", "a b"]) {
      assert.throws(() => devDataDirs({ packaged: false, appData: APP_DATA, home: HOME, instance: bad }), /ORBITA_DEV_INSTANCE/);
    }
  });

  test("正式版不认：packaged 优先返回 null", () => {
    assert.equal(devDataDirs({ packaged: true, appData: APP_DATA, home: HOME, instance: "2" }), null);
  });
});
