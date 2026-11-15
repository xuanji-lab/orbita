/**
 * agent 的 `edit_docx` 在主进程这一层：白名单与转发。
 *
 * 这一层**什么都不写**，所以能钉住的也只有两件事：路径该不该放行、转发时填了什么。
 * 放行的判据与 `fs:read` 同一道（realpath 之后判根内、只认 .docx）；不通过就回一句
 * 模型看得懂的话，绝不让一个有问题的路径走到 renderer。
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DocxAgentEditRequest, DocxEditOutcome, DocxEditRequestMessage } from "../../shared/docx.ts";
import type { FileRoot } from "../../shared/files.ts";
import { applyDocxEditRequest } from "./agent-edit.ts";

let root = "";
let outside = "";
let roots: FileRoot[] = [];
const sent: DocxEditRequestMessage[] = [];

const request = (path: string): DocxAgentEditRequest => ({
  sessionId: "s1",
  workspaceId: "w1",
  path,
  replace: "新话",
  find: "旧话",
});

const capture = async (message: DocxEditRequestMessage): Promise<DocxEditOutcome> => {
  sent.push(message);
  return { ok: true, path: message.request.path, groups: [], skipped: [], note: null };
};

before(async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "orbita-docx-agent-")));
  outside = base;
  await mkdir(join(base, "ws"), { recursive: true });
  root = await realpath(join(base, "ws"));
  await writeFile(join(root, "paper.docx"), "PK fake");
  await writeFile(join(root, "notes.txt"), "text");
  await writeFile(join(outside, "elsewhere.docx"), "PK fake");
  roots = [{ kind: "workspace", label: "ws", path: root, exists: true }];
});

after(async () => {
  await rm(join(root, ".."), { recursive: true, force: true });
});

describe("applyDocxEditRequest", () => {
  it("根内的 .docx：转发给 renderer，路径换成 realpath，作者与会话信息由主进程填", async () => {
    sent.length = 0;
    const outcome = await applyDocxEditRequest({ roots, dispatch: capture }, { sessionId: "s1", workspaceId: "w1", request: request(join(root, "paper.docx")) });
    assert.equal(outcome.ok, true);
    assert.equal(sent.length, 1);
    const message = sent[0] as DocxEditRequestMessage;
    assert.equal(message.request.path, join(root, "paper.docx"));
    assert.equal(message.sessionId, "s1");
    assert.equal(message.request.workspaceId, "w1");
    assert.equal(message.request.replace, "新话");
  });

  it("根外（工作区旁边那份）：拒绝，不转发", async () => {
    sent.length = 0;
    const outcome = await applyDocxEditRequest(
      { roots, dispatch: capture },
      { sessionId: "s1", workspaceId: "w1", request: request(join(outside, "elsewhere.docx")) },
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false ? outcome.reason : "", "invalid");
    assert.equal(sent.length, 0);
  });

  it("不是 .docx：拒绝", async () => {
    const outcome = await applyDocxEditRequest(
      { roots, dispatch: capture },
      { sessionId: "s1", workspaceId: "w1", request: request(join(root, "notes.txt")) },
    );
    assert.equal(outcome.ok === false ? outcome.reason : "", "invalid");
  });

  it("相对路径：拒绝（agent 进程负责拼绝对路径）", async () => {
    const outcome = await applyDocxEditRequest({ roots, dispatch: capture }, { sessionId: "s1", workspaceId: "w1", request: request("paper.docx") });
    assert.equal(outcome.ok === false ? outcome.reason : "", "invalid");
  });

  it("文件不在磁盘上：拒绝，并说清是哪一份", async () => {
    const outcome = await applyDocxEditRequest(
      { roots, dispatch: capture },
      { sessionId: "s1", workspaceId: "w1", request: request(join(root, "gone.docx")) },
    );
    assert.equal(outcome.ok, false);
    assert.match(outcome.ok === false ? outcome.error : "", /不在磁盘上/);
  });
});
