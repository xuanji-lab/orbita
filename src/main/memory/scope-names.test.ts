import test from "node:test";
import assert from "node:assert/strict";
import { lastSegment, scopeLabels } from "./scope-names.ts";

const GONE = "0161d576-0000-4000-8000-000000000000";

test("工作区不在：名字回落到会话 cwd 的末段目录名，标 missing、带完整路径，不露 uuid", () => {
  const labels = scopeLabels([{ workspaceId: GONE, cwd: "/Users/u/code/generative_agents" }], []);
  assert.deepEqual(labels.get(GONE), { kind: "missing", name: "generative_agents", path: "/Users/u/code/generative_agents" });
});

test("多个 cwd 取出现最多的那个；并列按路径字典序取第一个", () => {
  const sessions = [
    { workspaceId: GONE, cwd: "/a/WUWA-Data" },
    { workspaceId: GONE, cwd: "/b/geo-agent-os" },
    { workspaceId: GONE, cwd: "/b/geo-agent-os" },
  ];
  assert.equal(scopeLabels(sessions, []).get(GONE)?.name, "geo-agent-os");
  const tie = [
    { workspaceId: GONE, cwd: "/z/two" },
    { workspaceId: GONE, cwd: "/a/one" },
  ];
  assert.equal(scopeLabels(tie, []).get(GONE)?.name, "one");
});

test("工作区还在用工作区名（哪怕没有会话）；没有工作区的按 cwd", () => {
  const labels = scopeLabels(
    [
      { workspaceId: "ws-1", cwd: "/x/whatever" },
      { workspaceId: null, cwd: "/Users/u/Orbita/Home" },
    ],
    [
      { id: "ws-1", name: "意图系统" },
      { id: "ws-empty", name: "空的" },
    ],
  );
  assert.deepEqual(labels.get("ws-1"), { kind: "workspace", name: "意图系统" });
  assert.deepEqual(labels.get("ws-empty"), { kind: "workspace", name: "空的" });
  assert.deepEqual(labels.get("/Users/u/Orbita/Home"), { kind: "cwd", name: "/Users/u/Orbita/Home", path: "/Users/u/Orbita/Home" });
});

test("lastSegment：末尾斜杠与 Windows 分隔符", () => {
  assert.equal(lastSegment("/a/b/SVI-to-POI/"), "SVI-to-POI");
  assert.equal(lastSegment("C:\\Users\\u\\workspace"), "workspace");
  assert.equal(lastSegment("/"), "/");
});
