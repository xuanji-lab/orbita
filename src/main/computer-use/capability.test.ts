import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  editionToSku,
  featureStateFromExe,
  parseRegEditionId,
  probe,
  windowsSandboxExePath,
  type RunCommand,
} from "./capability.ts";

/** 模拟 reg query 的真实输出形状 */
const REG_PRO = `
HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion
    EditionID    REG_SZ    Professional

`;

describe("能力探测解析", () => {
  test("parseRegEditionId：从 reg 输出里抠 EditionID；没有就 null", () => {
    assert.equal(parseRegEditionId(REG_PRO), "Professional");
    assert.equal(parseRegEditionId("垃圾输出，没有 EditionID"), null);
    assert.equal(parseRegEditionId(""), null);
  });

  test("editionToSku：按前缀归组；Core/Cloud 是 Home，认不出归 unknown", () => {
    assert.equal(editionToSku("Professional"), "pro");
    assert.equal(editionToSku("ProfessionalN"), "pro");
    assert.equal(editionToSku("Enterprise"), "enterprise");
    assert.equal(editionToSku("IoTEnterprise"), "enterprise");
    assert.equal(editionToSku("Education"), "education");
    assert.equal(editionToSku("Core"), "home");
    assert.equal(editionToSku("CoreSingleLanguage"), "home");
    assert.equal(editionToSku("Cloud"), "home");
    assert.equal(editionToSku("ServerRdsh"), "unknown");
    assert.equal(editionToSku(null), "unknown");
  });

  test("featureStateFromExe：exe 存在性即功能状态（非提权拿不到 DISM 真值，错误 740）", () => {
    assert.equal(featureStateFromExe(true), "enabled");
    assert.equal(featureStateFromExe(false), "disabled");
  });

  test("windowsSandboxExePath：默认走 SystemRoot，可注入", () => {
    assert.ok(windowsSandboxExePath("C:\\Windows").endsWith("System32\\WindowsSandbox.exe"));
  });

  test("probe：全过 → ready，无指引，只跑 reg 一条命令（不跑 DISM——非提权必 740）", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const run: RunCommand = async (command, args) => {
      calls.push({ command, args });
      return { stdout: REG_PRO, stderr: "" };
    };
    const result = await probe({ platform: "win32", run, exeExists: () => true, systemRoot: "C:\\Windows" });
    assert.equal(result.ready, true);
    assert.equal(result.guidance, null);
    assert.deepEqual(result.edition, "pro");
    assert.deepEqual(result.featureState, "enabled");
    assert.equal(result.sandboxExeFound, true);
    assert.deepEqual(
      calls.map((call) => call.command),
      ["reg"],
    );
  });

  test("probe：家庭版 → 不 ready，指引提到家庭版、且不给「去开功能」的误导", async () => {
    const result = await probe({
      platform: "win32",
      run: async () => ({ stdout: "    EditionID    REG_SZ    Core\n", stderr: "" }),
      exeExists: () => false,
    });
    assert.equal(result.edition, "home");
    assert.equal(result.editionOk, false);
    assert.equal(result.ready, false);
    assert.ok(result.guidance?.includes("家庭版"));
    assert.ok(!result.guidance?.includes("optionalfeatures"));
  });

  test("probe：exe 不在（功能未启用）→ disabled + 指引给 optionalfeatures 路径并明说不会代跑提权命令", async () => {
    const result = await probe({
      platform: "win32",
      run: async () => ({ stdout: REG_PRO, stderr: "" }),
      exeExists: () => false,
    });
    assert.equal(result.ready, false);
    assert.equal(result.featureState, "disabled");
    assert.ok(result.guidance?.includes("optionalfeatures.exe"));
    assert.ok(result.guidance?.includes("不会替你执行"));
  });

  test("probe：非 Windows → 不跑任何命令，ready false", async () => {
    let ran = false;
    const result = await probe({
      platform: "darwin",
      run: async () => {
        ran = true;
        return { stdout: "", stderr: "" };
      },
      exeExists: () => true,
    });
    assert.equal(ran, false);
    assert.equal(result.ready, false);
    assert.equal(result.platformOk, false);
    assert.ok(result.guidance?.includes("Windows"));
  });

  test("probe：reg 失败 + exe 不在 → unknown/disabled + 指引，绝不抛", async () => {
    const result = await probe({
      platform: "win32",
      run: async () => {
        throw new Error("命令不存在");
      },
      exeExists: () => false,
    });
    assert.equal(result.ready, false);
    assert.equal(result.edition, "unknown");
    assert.equal(result.featureState, "disabled");
    assert.equal(result.sandboxExeFound, false);
    assert.ok(result.guidance !== null && result.guidance.length > 0);
  });
});
