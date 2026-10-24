import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BROWSER_PARTITION,
  SessionPartitions,
  partitionForSession,
  type PartitionStorage,
} from "./partition.ts";

/** 假的 partition 存储：记下每次被清的是哪一个（Electron 的 Session 由主进程注入，测试不碰它） */
interface FakeStore extends PartitionStorage {
  partition: string;
  cleared: number;
  cachesCleared: number;
  authsCleared: number;
}

function fakeStore(partition: string): FakeStore {
  const store: FakeStore = {
    partition,
    cleared: 0,
    cachesCleared: 0,
    authsCleared: 0,
    clearStorageData: async () => {
      store.cleared += 1;
    },
    clearCache: async () => {
      store.cachesCleared += 1;
    },
    clearAuthCache: async () => {
      store.authsCleared += 1;
    },
  };
  return store;
}

/** 测试用的 registry：open 按 partition 缓存同一把假锁，guard 记下装了哪些 */
function registry(): {
  partitions: SessionPartitions<FakeStore>;
  opened: string[];
  guarded: string[];
  store: (partition: string) => FakeStore;
} {
  const opened: string[] = [];
  const guarded: string[] = [];
  const stores = new Map<string, FakeStore>();
  const partitions = new SessionPartitions<FakeStore>({
    open: (partition) => {
      opened.push(partition);
      const existing = stores.get(partition);
      if (existing !== undefined) return existing;
      const created = fakeStore(partition);
      stores.set(partition, created);
      return created;
    },
    guard: (partition) => {
      guarded.push(partition);
    },
  });
  return {
    partitions,
    opened,
    guarded,
    store: (partition) => {
      const found = stores.get(partition);
      if (found === undefined) throw new Error(`没有打开过 ${partition}`);
      return found;
    },
  };
}

test("partition 名按会话派生：同一 id 稳定，不同 id 不同，前缀仍认得出是受管浏览器", () => {
  assert.equal(partitionForSession("5f0c1a2b"), "persist:orbita-browser-5f0c1a2b");
  assert.equal(partitionForSession("5f0c1a2b"), partitionForSession("5f0c1a2b"));
  assert.notEqual(partitionForSession("a"), partitionForSession("b"));
  assert.equal(partitionForSession("A_b-9"), "persist:orbita-browser-A_b-9");
  assert.ok(partitionForSession("a").startsWith(`${BROWSER_PARTITION}-`));
  assert.notEqual(partitionForSession("a"), BROWSER_PARTITION);
});

test("没有会话 / 空 id / 不安全字符：一律回落旧的全局 partition，不把任意字符拼进磁盘路径", () => {
  for (const missing of [undefined, null, ""]) {
    assert.equal(partitionForSession(missing), BROWSER_PARTITION);
  }
  for (const unsafe of ["../evil", "a/b", "a:b", "会话-1", "a b", "a.ns", "a\\b", "-"]) {
    assert.equal(partitionForSession(unsafe), BROWSER_PARTITION, `${JSON.stringify(unsafe)} 不该进 partition 名`);
  }
});

test("两个会话拿到两份 partition 与两把锁：互不共用", () => {
  const { partitions, opened, guarded } = registry();
  const first = partitions.get("s1");
  const second = partitions.get("s2");
  assert.equal(first.partition, "persist:orbita-browser-s1");
  assert.equal(second.partition, "persist:orbita-browser-s2");
  assert.notEqual(first.storage, second.storage);
  assert.deepEqual(opened, ["persist:orbita-browser-s1", "persist:orbita-browser-s2"]);
  assert.deepEqual(guarded, opened, "每个新 partition 装一次约束");
});

test("同一个会话反复取：同一份 partition、同一个 session，open / guard 都不重复", () => {
  const { partitions, opened, guarded } = registry();
  const first = partitions.get("s1");
  const again = partitions.get("s1");
  assert.equal(again.partition, first.partition);
  assert.equal(again.storage, first.storage);
  assert.equal(opened.length, 1);
  assert.equal(guarded.length, 1);
});

test("没有会话（用户的 tab）用旧的全局 partition：与任何会话都不同", () => {
  const { partitions, opened } = registry();
  const user = partitions.get(null);
  const undecided = partitions.get(undefined);
  const agent = partitions.get("s1");
  assert.equal(user.partition, BROWSER_PARTITION);
  assert.equal(undecided.storage, user.storage);
  assert.notEqual(agent.storage, user.storage);
  assert.deepEqual(opened, [BROWSER_PARTITION, "persist:orbita-browser-s1"]);
});

test("会话关闭只清自己那份存储：别的会话与用户那份分毫不动，缓存也不碰", async () => {
  const { partitions, store } = registry();
  const user = partitions.get(null);
  const first = partitions.get("s1");
  const second = partitions.get("s2");
  assert.equal(await partitions.clearSession("s1"), true);
  assert.equal(first.storage.cleared, 1);
  assert.equal(second.storage.cleared, 0, "别的会话的 cookie 不能跟着没");
  assert.equal(user.storage.cleared, 0, "用户的登录态不能跟着没");
  assert.equal(store("persist:orbita-browser-s2").cleared, 0);
  assert.equal(second.storage.cachesCleared, 0, "删会话不清 HTTP 缓存");
  assert.equal(second.storage.authsCleared, 0);
});

test("会话关闭时没打开过浏览器也清：partition 的数据在盘上，不在这一轮的 tab 里", async () => {
  const { partitions, opened, guarded, store } = registry();
  assert.equal(await partitions.clearSession("never-opened"), true);
  const partition = "persist:orbita-browser-never-opened";
  assert.deepEqual(opened, [partition]);
  assert.deepEqual(guarded, [partition]);
  assert.equal(store(partition).cleared, 1);
});

test("不安全 / 缺失的会话 id：删会话什么都不清，绝不误清用户那份全局登录态", async () => {
  const { partitions, opened } = registry();
  for (const unsafe of [undefined, null, "", "../evil", "a/b"]) {
    assert.equal(await partitions.clearSession(unsafe), false);
  }
  assert.deepEqual(opened, [], "一个 partition 都不该被打开 / 清掉");
});

test("清除全部浏览器数据：用户那份 + 每个用过的会话各清一次（含缓存与认证缓存）", async () => {
  const { partitions, opened, store } = registry();
  partitions.get("s1");
  partitions.get("s2");
  await partitions.clearAll();
  // 用户那份没打开过也要清：窗口从没开过也能清
  assert.deepEqual(opened, ["persist:orbita-browser-s1", "persist:orbita-browser-s2", BROWSER_PARTITION]);
  for (const partition of [BROWSER_PARTITION, "persist:orbita-browser-s1", "persist:orbita-browser-s2"]) {
    assert.equal(store(partition).cleared, 1, `${partition} 的站点存储应清一次`);
    assert.equal(store(partition).cachesCleared, 1, `${partition} 的缓存应清一次`);
    assert.equal(store(partition).authsCleared, 1, `${partition} 的认证缓存应清一次`);
  }
});

test("清除全部浏览器数据不会把同一份 partition 清两遍（用户 tab 已经开过也一样）", async () => {
  const { partitions, opened, store } = registry();
  partitions.get(null);
  partitions.get("s1");
  await partitions.clearAll();
  assert.deepEqual(opened, [BROWSER_PARTITION, "persist:orbita-browser-s1"]);
  assert.equal(store(BROWSER_PARTITION).cleared, 1);
  assert.equal(store("persist:orbita-browser-s1").cleared, 1);
});
