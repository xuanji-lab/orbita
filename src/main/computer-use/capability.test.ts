import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  editionToSku,
  featureStateFromExe,
  parseHypervisorPresent,
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

  test("probe：全过 → ready，无指引，两条命令各跑一次（不跑 DISM——非提权必 740）", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const run: RunCommand = async (command, args) => {
      calls.push({ command, args });
      return { stdout: command === "powershell" ? "True" : REG_PRO, stderr: "" };
    };
    const result = await probe({ platform: "win32", run, exeExists: () => true, systemRoot: "C:\\Windows" });
    assert.equal(result.ready, true);
    assert.equal(result.guidance, null);
    assert.deepEqual(result.edition, "pro");
    assert.deepEqual(result.featureState, "enabled");
    assert.equal(result.sandboxExeFound, true);
    assert.deepEqual(result.hypervisorState, "present");
    assert.deepEqual(
      calls.map((call) => call.command),
      ["reg", "powershell"],
    );
    // 虚拟化查询用 Get-CimInstance（不用 wmic：24H2+ 已可选移除）
    assert.ok(calls[1]?.args.join(" ").includes("Get-CimInstance Win32_ComputerSystem"), calls[1]?.args.join(" "));
  });

  test("probe：BIOS 关了虚拟化 → 不 ready，指引指回 BIOS（审查意见 B：别让 start 才失败）", async () => {
    const result = await probe({
      platform: "win32",
      run: async (command) => ({ stdout: command === "powershell" ? "False" : REG_PRO, stderr: "" }),
      exeExists: () => true,
    });
    // 其它三项全过——只有虚拟化把它拦下来，这正是这一项存在的理由
    assert.equal(result.edition, "pro");
    assert.equal(result.featureState, "enabled");
    assert.equal(result.sandboxExeFound, true);
    assert.equal(result.hypervisorState, "absent");
    assert.equal(result.ready, false);
    assert.ok(result.guidance?.includes("BIOS"), result.guidance ?? "");
    assert.ok(result.guidance?.includes("虚拟化"), result.guidance ?? "");
  });

  test("probe：虚拟化查不成（PowerShell 不在 / 超时）→ unknown，**不阻塞**，其余三项说了算", async () => {
    const result = await probe({
      platform: "win32",
      run: async (command) => {
        if (command === "powershell") throw new Error("PowerShell 不在");
        return { stdout: REG_PRO, stderr: "" };
      },
      exeExists: () => true,
    });
    assert.equal(result.hypervisorState, "unknown");
    assert.equal(result.ready, true, "少一条信号不能把能用的机器判死");
    assert.equal(result.guidance, null);
  });

  test("parseHypervisorPresent：True/False 认（大小写、空白），其余一律 unknown", () => {
    assert.equal(parseHypervisorPresent("True"), "present");
    assert.equal(parseHypervisorPresent("true\r\n"), "present");
    assert.equal(parseHypervisorPresent("  False "), "absent");
    assert.equal(parseHypervisorPresent("FALSE"), "absent");
    assert.equal(parseHypervisorPresent(""), "unknown");
    assert.equal(parseHypervisorPresent("Get-CimInstance : 拒绝访问"), "unknown");
    assert.equal(parseHypervisorPresent("1"), "unknown");
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
    assert.equal(result.hypervisorState, "unknown");
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
    assert.equal(result.hypervisorState, "unknown");
    assert.ok(result.guidance !== null && result.guidance.length > 0);
  });
});
