#!/usr/bin/env node
/**
 * macOS 打包入口（bun run dist 的最后一步）：解析签名身份并转发给 electron-builder。
 * 请通过 `bun run dist` 调用（依赖 node_modules/.bin 在 PATH 上）。
 *
 * 背景：package.json 的 build.mac.identity 固定为 "-"（ad-hoc）。ad-hoc 签名的要求绑在
 * cdhash 上，每次打包都会变；而 TCC（隐私授权）按 bundle id + 签名要求记录授权，于是每次
 * 重新打包，第一次访问 ~/Documents 等受保护目录都要重新弹窗，多份构建并存时授权还会互相
 * 顶掉（tccd 日志：Failed to match existing code requirement for subject com.orbita.desktop）。
 *
 * 设 ORBITA_MAC_SIGN_IDENTITY=<证书名> 时，改用固定证书签名：designated requirement 基于
 * 证书叶子（identifier + certificate leaf），跨构建稳定，TCC 授权得以延续。一次性创建自签名
 * 证书的步骤：钥匙串访问 → 证书助理 → 创建证书，证书类型选「代码签名」（必须，缺
 * codeSigning 扩展的证书会被过滤掉）；证书助理创建的同时会把证书标记为受信任（需要输入
 * 一次密码）——信任是硬前提，不受信任的证书既不会被 electron-builder 发现，codesign 也
 * 拒绝使用（实测 macOS 25）。不设该变量时行为与原先完全一致（ad-hoc），Windows 打包、
 * CI 不受影响。
 *
 * 为什么不复用 electron-builder 原生的 CSC_NAME：package.json 里 identity 已固定为 "-"，
 * 而 app-builder-lib 的 findIdentity 是 `qualifier || process.env.CSC_NAME`——配置里非空的
 * "-" 永远压过环境变量；若为让 CSC_NAME 生效而删掉 "-"，未配置的协作者会落进自动发现分支
 * （钥匙串里任意可用代码签名证书都可能被选中），不再是确定的 ad-hoc。独立变量 +
 * `--config.mac.identity=` 显式覆盖，默认路径零变化，语义也最窄。
 *
 * electron-builder 26.16.1 对自签名证书的处理（调研结论）：非 MAS 构建的证书类型是
 * "Developer ID Application"，findIdentity 在该类型下有「非 Apple 证书」的回退查找
 * （macCodeSign.js _findIdentity 第二个循环，上游 issue #458），自签名证书按名字子串匹配，
 * 前提是证书带 codeSigning EKU。将来接 Apple Developer ID + 公证时，同一变量换填
 * Developer ID 证书名即可为入口（hardenedRuntime / entitlements / 公证另行立项）。
 */
import { spawnSync } from "node:child_process";
import {
  electronBuilderMacIdentityArgs,
  parseCodesigningIdentities,
  resolveSignIdentity,
  selectIdentityMatches,
} from "./mac-sign-identity.mjs";

const identity = resolveSignIdentity(process.env);

if (identity != null) {
  const list = spawnSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" });
  if (list.error != null) {
    console.error(`查询代码签名证书失败（security find-identity）：${list.error.message}`);
    process.exit(1);
  }
  const names = parseCodesigningIdentities(list.stdout ?? "");
  const matches = selectIdentityMatches(names, identity);
  if (matches.length === 0) {
    // electron-builder 找不到身份时只警告并跳过签名（非强制场景），会静默产出未签名包——
    // 这里提前失败，宁可不打也不要打出一份意料之外的包。
    console.error(
      [
        `钥匙串里没有可用的代码签名证书匹配 ORBITA_MAC_SIGN_IDENTITY=${JSON.stringify(identity)}。`,
        names.length > 0 ? `当前可用证书：${names.join("、")}` : "当前没有可用的代码签名证书。",
        "常见原因：证书不存在；缺代码签名扩展（输出里标 (Missing required extension)）；",
        "或证书不受系统信任（openssl 手搓导入的自签名证书就是这样，需要手动设置信任）。",
        "建议用「钥匙串访问 → 证书助理 → 创建证书」创建，类型选「代码签名」，",
        "创建时会自动标记为受信任。",
      ].join("\n"),
    );
    process.exit(1);
  }
  if (matches.length > 1) {
    console.warn(
      `警告：名字包含 ${JSON.stringify(identity)} 的代码签名证书有多张（${matches.join("、")}），` +
        "electron-builder 会取第一张命中的；建议用能唯一确定证书的完整名字。",
    );
  }
}

const result = spawnSync(
  "electron-builder",
  ["--mac", "--arm64", "--publish", "never", ...electronBuilderMacIdentityArgs(identity)],
  { stdio: "inherit" },
);
if (result.error != null) {
  console.error(`启动 electron-builder 失败：${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
