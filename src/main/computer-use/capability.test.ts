import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  editionToSku,
  featureStateFromExe,
  parseHypervisorPresent,
  parseRegEditionId,
  platformGuidance,
  probe,
  windowsSandboxExePath,
  windowsWslExePath,
  WSL_PROBE_ARGS,
  type RunCommand,
} from "./capability.ts";

/** 模拟 reg query 的真实输出形状 */
const REG_PRO = `
HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion
    EditionID    REG_SZ    Professional

`;

const REG_HOME = "    EditionID    REG_SZ    Core\n";

/**
 * 拼一个假的 run：按命令名回输出，给 undefined 就抛（模拟命令不在 / 超时 / 非 0 退出）。
 * 每条命令都记进 calls——测试靠它断言「哪些命令跑了、跑了几次、参数对不对」。
 */
function makeRun(
  outputs: { reg?: string; hypervisor?: string; wsl?: string } = {},
  calls: Array<{ command: string; args: string[] }> = [],
): RunCommand {
  return async (command, args) => {
    calls.push({ command, args });
    if (command === "reg") {
      if (outputs.reg === undefined) throw new Error("reg 失败");
      return { stdout: outputs.reg, stderr: "" };
    }
    if (command === "powershell") {
      if (outputs.hypervisor === undefined) throw new Error("PowerShell 不在");
      return { stdout: outputs.hypervisor, stderr: "" };
    }
    if (command === "wsl") {
      if (outputs.wsl === undefined) throw new Error("wsl -l -v 没跑成");
      return { stdout: outputs.wsl, stderr: "" };
    }
    throw new Error(`测试没预料到的命令：${command}`);
  };
}

/** 两个系统件的存在性（默认 pro 机器：沙箱 exe 在、wsl.exe 也在） */
function makeExeExists(found: { sandbox: boolean; wsl: boolean }): (path: string) => boolean {
  return (path) => {
    if (path.endsWith("WindowsSandbox.exe")) return found.sandbox;
    if (path.endsWith("wsl.exe")) return found.wsl;
    return false;
  };
}

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

  test("两个系统件路径：默认走 SystemRoot，可注入（win32 分隔符，任何平台拼出来一致）", () => {
    assert.ok(windowsSandboxExePath("C:\\Windows").endsWith("System32\\WindowsSandbox.exe"));
    assert.equal(windowsWslExePath("C:\\Windows"), "C:\\Windows\\System32\\wsl.exe");
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

  test("platformGuidance：macOS 给浏览器档的出路（真话：browser_* 可用，sandbox_* 没有——所有隔离后端都建在 Windows 宿主上）", () => {
    const mac = platformGuidance("darwin");
    assert.ok(mac.includes("macOS"), mac);
    // 「不是没实现，是平台不提供」这层意思必须说出来，否则 macOS 用户会一直等
    assert.ok(mac.includes("不是 Orbita 还没做"), mac);
    assert.ok(mac.includes("browser_navigate"), mac);
    // 不能说「要等 L3」：L3 已经做了，只是同样只在 Windows 上（2026-11-27）
    assert.ok(!mac.includes("路线图"), mac);
    assert.ok(!mac.includes("要等"), mac);
    assert.ok(mac.includes("Windows 宿主"), mac);
    // 不能把 sandbox_* 说成 macOS 能用：它每条命令都走 Windows 沙箱里的 guest 桥
    assert.ok(!mac.includes("sandbox_* 可用"), mac);
    // Linux 等其它平台：短一句，同样说明只在 Windows 上提供
    const linux = platformGuidance("linux");
    assert.ok(linux.includes("只在 Windows"), linux);
  });
});

describe("能力探测 · 档位判定", () => {
  test("pro: Pro + 沙箱已启用 + 虚拟化在 + WSL 能跑 → ready，L2", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const result = await probe({
      platform: "win32",
      run: makeRun({ reg: REG_PRO, hypervisor: "True", wsl: "  NAME  STATE  VERSION\n* Ubuntu Running 2\n" }, calls),
      exeExists: makeExeExists({ sandbox: true, wsl: true }),
      systemRoot: "C:\\Windows",
    });
    assert.equal(result.ready, true);
    assert.equal(result.guidance, null);
    assert.equal(result.edition, "pro");
    assert.equal(result.featureState, "enabled");
    assert.equal(result.sandboxExeFound, true);
    assert.equal(result.hypervisorState, "present");
    assert.equal(result.wsl2, "available");
    assert.equal(result.isolationTier, "l2");
    // 三条命令各跑一次（并行发，调用顺序仍是确定的：按创建顺序）
    assert.deepEqual(
      calls.map((call) => call.command),
      ["reg", "powershell", "wsl"],
    );
    // 虚拟化查询用 Get-CimInstance（不用 wmic：24H2+ 已可选移除）
    assert.ok(calls[1]?.args.join(" ").includes("Get-CimInstance Win32_ComputerSystem"), calls[1]?.args.join(" "));
    // WSL 只探「跑不跑得动」，不解析输出（很多版本的 -l -v 是 UTF-16LE）
    assert.deepEqual(calls[2]?.args, [...WSL_PROBE_ARGS]);
  });

  test("home: 家庭版 → 只到 L1，指引说清没有沙箱、且不给「去开功能」的误导", async () => {
    const result = await probe({
      platform: "win32",
      run: makeRun({ reg: REG_HOME, hypervisor: "True", wsl: "x" }),
      exeExists: makeExeExists({ sandbox: false, wsl: true }),
    });
    assert.equal(result.edition, "home");
    assert.equal(result.editionOk, false);
    assert.equal(result.ready, false);
    assert.equal(result.isolationTier, "l1");
    assert.ok(result.guidance?.includes("家庭版"), result.guidance ?? "");
    // 家庭版开不了沙箱：别把用户送去「启用或关闭 Windows 功能」白折腾
    assert.ok(!result.guidance?.includes("optionalfeatures"), result.guidance ?? "");
    // 也不该贴 Hyper-V 冲突警告——那条只跟在「去启用」后面
    assert.ok(!result.guidance?.includes("Hyper-V"), result.guidance ?? "");
  });

  test("darwin: macOS → L1 + 正确文案，一条命令都不跑", async () => {
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
    assert.equal(result.wsl2, "unavailable");
    // 浏览器档（browser_*）在 macOS 上可用，所以下限仍然是 L1，不是「什么都不能用」
    assert.equal(result.isolationTier, "l1");
    // 平台不对时指引只有一条（reg 根本没跑，「读不到版本档位」只会稀释信号）
    const lines = (result.guidance ?? "").split("\n");
    assert.equal(lines.length, 1, result.guidance ?? "");
    assert.equal(lines[0], platformGuidance("darwin"));
    assert.ok(result.guidance?.includes("browser_navigate"), result.guidance ?? "");
  });

  test("wsl: 探测失败不误判——wsl2 归 unknown，其余三项说了算，仍是 L2", async () => {
    const result = await probe({
      platform: "win32",
      run: makeRun({ reg: REG_PRO, hypervisor: "True" }), // wsl 缺省 → 抛
      exeExists: makeExeExists({ sandbox: true, wsl: true }),
    });
    assert.equal(result.wsl2, "unknown");
    assert.equal(result.ready, true, "WSL2 不是隔离边界，它坏了不该把 L2 判死");
    assert.equal(result.isolationTier, "l2");
    assert.equal(result.guidance, null);
  });

  test("wsl: exe 不在 → unavailable，且不跑 wsl 命令（没装的机器不白等一条超时）", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const result = await probe({
      platform: "win32",
      run: makeRun({ reg: REG_PRO, hypervisor: "True", wsl: "x" }, calls),
      exeExists: makeExeExists({ sandbox: true, wsl: false }),
    });
    assert.equal(result.wsl2, "unavailable");
    assert.deepEqual(
      calls.map((call) => call.command),
      ["reg", "powershell"],
    );
  });

  test("edition 读不到 ≠ Home：unknown、不 ready、也不给「家庭版」的错话", async () => {
    const result = await probe({
      platform: "win32",
      run: makeRun({ hypervisor: "True", wsl: "x" }), // reg 缺省 → 抛
      exeExists: makeExeExists({ sandbox: true, wsl: true }),
    });
    assert.equal(result.edition, "unknown");
    assert.equal(result.editionOk, false);
    assert.equal(result.ready, false);
    assert.equal(result.isolationTier, "l1");
    assert.ok(result.guidance?.includes("读不到"), result.guidance ?? "");
    assert.ok(!result.guidance?.includes("家庭版"), result.guidance ?? "");
    // 版本读不到但 exe 在：不再劝用户去开功能（它已经开了）
    assert.ok(!result.guidance?.includes("optionalfeatures"), result.guidance ?? "");
  });

  test("probe：BIOS 关了虚拟化 → 不 ready、L1，指引指回 BIOS（审查意见 B：别让 start 才失败）", async () => {
    const result = await probe({
      platform: "win32",
      run: makeRun({ reg: REG_PRO, hypervisor: "False", wsl: "x" }),
      exeExists: makeExeExists({ sandbox: true, wsl: true }),
    });
    // 其它三项全过——只有虚拟化把它拦下来，这正是这一项存在的理由
    assert.equal(result.edition, "pro");
    assert.equal(result.featureState, "enabled");
    assert.equal(result.sandboxExeFound, true);
    assert.equal(result.hypervisorState, "absent");
    assert.equal(result.ready, false);
    assert.equal(result.isolationTier, "l1");
    assert.ok(result.guidance?.includes("BIOS"), result.guidance ?? "");
    assert.ok(result.guidance?.includes("虚拟化"), result.guidance ?? "");
  });

  test("probe：虚拟化查不成（PowerShell 不在 / 超时）→ unknown，**不阻塞**，其余三项说了算", async () => {
    const result = await probe({
      platform: "win32",
      run: makeRun({ reg: REG_PRO, wsl: "x" }), // hypervisor 缺省 → 抛
      exeExists: makeExeExists({ sandbox: true, wsl: true }),
    });
    assert.equal(result.hypervisorState, "unknown");
    assert.equal(result.ready, true, "少一条信号不能把能用的机器判死");
    assert.equal(result.guidance, null);
  });

  test("probe：exe 不在（功能未启用）→ L1 + 指引给 optionalfeatures 路径、明说不代跑提权命令、并贴上 Hyper-V 冲突警告", async () => {
    const result = await probe({
      platform: "win32",
      run: makeRun({ reg: REG_PRO, hypervisor: "True", wsl: "x" }),
      exeExists: makeExeExists({ sandbox: false, wsl: true }),
    });
    assert.equal(result.ready, false);
    assert.equal(result.featureState, "disabled");
    assert.equal(result.isolationTier, "l1");
    assert.ok(result.guidance?.includes("optionalfeatures.exe"));
    assert.ok(result.guidance?.includes("不会替你执行"));
    // 安装器那句提示的另一份：启用沙箱会打开 Hyper-V，第三方虚拟机会受影响
    assert.ok(result.guidance?.includes("Hyper-V"), result.guidance ?? "");
    assert.ok(result.guidance?.includes("VMware"), result.guidance ?? "");
    assert.ok(result.guidance?.includes("VirtualBox"), result.guidance ?? "");
    // 警告必须排在「去启用」那条之后（用户读到这里就准备动手了）
    const lines = (result.guidance ?? "").split("\n");
    const enableAt = lines.findIndex((line) => line.includes("optionalfeatures"));
    const warnAt = lines.findIndex((line) => line.includes("Hyper-V"));
    assert.ok(enableAt >= 0 && warnAt > enableAt, result.guidance ?? "");
  });

  test("probe：reg 失败 + exe 不在 → unknown/disabled + 指引，绝不抛", async () => {
    const result = await probe({
      platform: "win32",
      run: makeRun({}), // 三条全失败
      exeExists: () => false,
    });
    assert.equal(result.ready, false);
    assert.equal(result.edition, "unknown");
    assert.equal(result.featureState, "disabled");
    assert.equal(result.sandboxExeFound, false);
    assert.equal(result.hypervisorState, "unknown");
    assert.equal(result.wsl2, "unavailable");
    assert.equal(result.isolationTier, "l1");
    assert.ok(result.guidance !== null && result.guidance.length > 0);
  });
});

describe("能力探测 · L2b（多会话隔离）的依赖检查", () => {
  test("沙箱不就绪但 MXC 可用 → 档位是 L2b（Win11 家庭版也能到这一档）", async () => {
    const result = await probe({
      platform: "win32",
      run: makeRun({ reg: REG_HOME, hypervisor: "True", wsl: "x" }),
      exeExists: makeExeExists({ sandbox: false, wsl: true }),
      isolationProbe: () => ({ available: true, reason: null, nodeVersion: "24.21.0", nodeOk: true }),
    });
    assert.equal(result.ready, false);
    assert.equal(result.isolationTier, "l2b");
    assert.deepEqual(result.isolationSession, {
      available: true,
      reason: null,
      nodeVersion: "24.21.0",
      nodeOk: true,
    });
  });

  test("沙箱就绪时档位仍是 L2（默认后端是沙箱；L2b 要在设置里显式选）", async () => {
    const result = await probe({
      platform: "win32",
      run: makeRun({ reg: REG_PRO, hypervisor: "True", wsl: "x" }),
      exeExists: makeExeExists({ sandbox: true, wsl: true }),
      isolationProbe: () => ({ available: true, reason: null, nodeVersion: "24.21.0", nodeOk: true }),
    });
    assert.equal(result.isolationTier, "l2");
    assert.equal(result.isolationSession.available, true);
  });

  test("MXC 不可用时**必有原因**（设置页不能只把开关画灰）", async () => {
    const result = await probe({
      platform: "win32",
      run: makeRun({ reg: REG_PRO, hypervisor: "True", wsl: "x" }),
      exeExists: makeExeExists({ sandbox: true, wsl: true }),
      isolationProbe: () => ({
        available: false,
        reason: "当前 Node 24.14.0 太旧：MXC 的 native stdio 要求 Node 24.21 以上",
        nodeVersion: "24.14.0",
        nodeOk: false,
      }),
    });
    assert.equal(result.isolationSession.available, false);
    assert.match(result.isolationSession.reason ?? "", /24\.14/);
    assert.equal(result.isolationSession.nodeOk, false);
  });

  test("没接探测函数时显式写「本次没检查」，而不是静默当成不支持", async () => {
    const result = await probe({
      platform: "win32",
      run: makeRun({ reg: REG_PRO, hypervisor: "True", wsl: "x" }),
      exeExists: makeExeExists({ sandbox: true, wsl: true }),
    });
    assert.equal(result.isolationSession.available, false);
    assert.match(result.isolationSession.reason ?? "", /没有接 MXC 探测/);
  });

  test("探测函数自己抛 → 只影响 L2b 那一行，WSB 的结论不变", async () => {
    const result = await probe({
      platform: "win32",
      run: makeRun({ reg: REG_PRO, hypervisor: "True", wsl: "x" }),
      exeExists: makeExeExists({ sandbox: true, wsl: true }),
      isolationProbe: () => {
        throw new Error("DLL 加载失败");
      },
    });
    assert.equal(result.ready, true);
    assert.equal(result.isolationTier, "l2");
    assert.equal(result.isolationSession.available, false);
    assert.match(result.isolationSession.reason ?? "", /DLL 加载失败/);
  });

  test("macOS 上 L2b 也不可用（先报平台，不碰 SDK）", async () => {
    let probed = false;
    const result = await probe({
      platform: "darwin",
      run: makeRun({}),
      exeExists: () => false,
      isolationProbe: () => {
        probed = true;
        return { available: true, reason: null, nodeVersion: "24.21.0", nodeOk: true };
      },
    });
    assert.equal(probed, false);
    assert.equal(result.isolationSession.available, false);
    assert.match(result.isolationSession.reason ?? "", /只在 Windows 上有/);
  });
});
