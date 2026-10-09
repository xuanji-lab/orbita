import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  editionToSku,
  parseDismState,
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

/** dism /Online /Get-FeatureInfo /English 的真实输出形状（/English 才有 State : Enabled） */
const DISM_ENABLED = `
Deployment Image Servicing and Management tool
Version: 10.0.26200.1

Image Version: 10.0.26200.1

Feature Name : Containers-DisposableClientVM
Display Name : Windows Sandbox
Description : Enables the use of the Windows Sandbox.
Restart Required : Possible
State : Enabled

The operation completed successfully.
`;

const DISM_DISABLED = `
Feature Name : Containers-DisposableClientVM
Display Name : Windows Sandbox
State : Disabled with Payload Removed
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

  test("parseDismState：Enabled / Disabled with Payload Removed / 本地化输出 / 空输出", () => {
    assert.equal(parseDismState(DISM_ENABLED), "enabled");
    assert.equal(parseDismState(DISM_DISABLED), "disabled");
    // 没带 /English 的中文输出解析不了——宁可 unknown 也不瞎猜
    assert.equal(parseDismState("状态 : 已启用"), "unknown");
    assert.equal(parseDismState(""), "unknown");
  });

  test("windowsSandboxExePath：默认走 SystemRoot，可注入", () => {
    assert.ok(windowsSandboxExePath("C:\\Windows").endsWith("System32\\WindowsSandbox.exe"));
  });

  test("probe：全过 → ready，无指引，命令参数正确", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const run: RunCommand = async (command, args) => {
      calls.push({ command, args });
      if (command === "reg") return { stdout: REG_PRO, stderr: "" };
      return { stdout: DISM_ENABLED, stderr: "" };
    };
    const result = await probe({ platform: "win32", run, exeExists: () => true, systemRoot: "C:\\Windows" });
    assert.equal(result.ready, true);
    assert.equal(result.guidance, null);
    assert.deepEqual(result.edition, "pro");
    assert.deepEqual(result.featureState, "enabled");
    assert.equal(result.sandboxExeFound, true);
    assert.deepEqual(
      calls.map((call) => call.command),
      ["reg", "dism"],
    );
    assert.deepEqual(calls[1]?.args, [
      "/Online",
      "/Get-FeatureInfo",
      "/FeatureName:Containers-DisposableClientVM",
      "/English",
    ]);
  });

  test("probe：家庭版 → 不 ready，指引提到家庭版", async () => {
    const result = await probe({
      platform: "win32",
      run: async () => ({ stdout: "    EditionID    REG_SZ    Core\n", stderr: "" }),
      exeExists: () => true,
    });
    assert.equal(result.edition, "home");
    assert.equal(result.editionOk, false);
    assert.equal(result.ready, false);
    assert.ok(result.guidance?.includes("家庭版"));
  });

  test("probe：功能未启用 → 指引给手动路径并明说不会代跑提权命令", async () => {
    const result = await probe({
      platform: "win32",
      run: async (command) =>
        command === "reg" ? { stdout: REG_PRO, stderr: "" } : { stdout: DISM_DISABLED, stderr: "" },
      exeExists: () => true,
    });
    assert.equal(result.ready, false);
    assert.ok(result.guidance?.includes("启用或关闭 Windows 功能"));
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

  test("probe：命令失败 → unknown + 指引，绝不抛", async () => {
    const result = await probe({
      platform: "win32",
      run: async () => {
        throw new Error("命令不存在");
      },
      exeExists: () => false,
    });
    assert.equal(result.ready, false);
    assert.equal(result.edition, "unknown");
    assert.equal(result.featureState, "unknown");
    assert.equal(result.sandboxExeFound, false);
    assert.ok(result.guidance !== null && result.guidance.length > 0);
  });
});
