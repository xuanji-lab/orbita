import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { VIEW_HANDOFF_KEY, readViewHandoff, writeViewHandoff, type HandoffStorage } from "./view-handoff.ts";

const memory = (): HandoffStorage & { map: Map<string, string> } => {
  const map = new Map<string, string>();
  return { map, getItem: (key) => map.get(key) ?? null, setItem: (key, value) => void map.set(key, value) };
};

describe("视图交接（切液态玻璃重开窗口后接上旧窗的视图）", () => {
  test("旧窗写、新窗读：会话、覆盖层、设置页签原样接上", () => {
    const storage = memory();
    writeViewHandoff(storage, { sessionId: "s1", overlay: "settings", settingsTab: "general" });
    assert.deepEqual(readViewHandoff(storage), { sessionId: "s1", overlay: "settings", settingsTab: "general" });
  });

  test("首页（没开会话、没覆盖层）也能交接", () => {
    const storage = memory();
    writeViewHandoff(storage, { sessionId: null, overlay: null, settingsTab: "providers" });
    assert.deepEqual(readViewHandoff(storage), { sessionId: null, overlay: null, settingsTab: "providers" });
  });

  test("后写的覆盖先写的：交接的是旧窗最后看的那一页", () => {
    const storage = memory();
    writeViewHandoff(storage, { sessionId: "a", overlay: null, settingsTab: "general" });
    writeViewHandoff(storage, { sessionId: "b", overlay: "settings", settingsTab: "general" });
    assert.equal(readViewHandoff(storage)?.sessionId, "b");
  });

  test("缺失、坏 JSON、字段不对都回 null，不抛（新窗照旧落首页）", () => {
    const storage = memory();
    assert.equal(readViewHandoff(storage), null);
    for (const raw of ["{", "null", "3", '{"sessionId":5,"overlay":null}', '{"sessionId":"","overlay":null}', '{"sessionId":"x","overlay":"nope"}']) {
      storage.map.set(VIEW_HANDOFF_KEY, raw);
      assert.equal(readViewHandoff(storage), null, raw);
    }
  });

  test("页签认不出（旧版本留下的 / 手改的）落回通用页，会话照样接上", () => {
    const storage = memory();
    storage.map.set(VIEW_HANDOFF_KEY, JSON.stringify({ sessionId: "s1", overlay: "settings", settingsTab: "gone" }));
    assert.deepEqual(readViewHandoff(storage), { sessionId: "s1", overlay: "settings", settingsTab: "general" });
  });

  test("存储抛错（满 / 被禁）：写静默跳过，读回 null", () => {
    const broken: HandoffStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
    };
    assert.doesNotThrow(() => writeViewHandoff(broken, { sessionId: "s", overlay: null, settingsTab: "general" }));
    assert.equal(readViewHandoff(broken), null);
  });
});
