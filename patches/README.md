# pi patch 清单

适用精确锁版本 `@earendil-works/*` **0.84.3**。pi 升级后 patch 打不上时 `bun install`
会当场报错——按下面的意图在新版本上重打；重打前先确认新版是否已原生支持该行为，
支持了就直接删 patch。

## @earendil-works/pi-ai — api.kimi.com 认作 Moonshot 端点

`dist/api/openai-completions.js`（`detectCompat` 的 `isMoonshot`）：

```diff
- const isMoonshot = provider === "moonshotai" || provider === "moonshotai-cn" || baseUrl.includes("api.moonshot.");
+ const isMoonshot = provider === "moonshotai" ||
+     provider === "moonshotai-cn" ||
+     baseUrl.includes("api.moonshot.") ||
+     baseUrl.includes("api.kimi.com");
```

**为什么（2026-10-01）**：Kimi 官方 coding 端点迁到新域名 `api.kimi.com/coding/v1`，pi 0.84.3 的
域名识别表只认 `api.moonshot.*`——以 openai-compatible 自定义网关接入时被当标准 OpenAI 端点，
推理模型（k3 借目录参数 `reasoning:true`）的系统提示词以 `developer` 角色发出，Moonshot 服务端
400「role 'developer' is not allowed」。归入 `isMoonshot` 后一并继承该家族既有适配
（`supportsDeveloperRole:false`、不发 `reasoning_effort`、`max_tokens` 字段名等）。

**行为守卫**：`src/agent/kimi-compat-patch.test.ts`（`stream` + 假 fetch 断言首条消息角色，
同文件另有一条标准 OpenAI 端点仍用 `developer` 的反向断言）。

## @earendil-works/pi-ai — 错误带明确的 4xx 不重试

`dist/utils/retry.js`（`isRetryableAssistantError`）：在额度名单之后、可重试正则之前插一道
`hasNonRetryableClientStatus`——错误文本里能确定的 HTTP 状态码（`API error (403):`、开头的
`403 Forbidden`、`HTTP 403` / `status 403`）全是 4xx 且不是 408 / 429 时判为不可重试。
认不出状态码、混有非 4xx 状态码、或文本说的是限流 / 过载时不改原判。

**为什么（2026-10-24）**：原判只看正则，`server.?error` 命中 OpenCode 写在永久错误体里的
`"type":"server_error"`——403「Model access is disabled」、400「Model is unavailable.」被当临时故障，
按 retry-policy 的 8 次指数退避重试约 4 分钟，前 5 次界面不显示，用户看到一直「回应中」。
patch 在 pi-ai 而不在 Orbita 侧：AgentSession 的 `_isRetryableError` 是私有方法、没有注入点；
订阅 `auto_retry_start` 再 `abortRetry()` 会把真错误换成 "Retry cancelled"，且盖不住压缩的
`retryAssistantCall`。这一个函数是两条重试路径的共同判据。

**行为守卫**：`src/agent/retry-4xx-patch.test.ts`（纯判定 + 真 AgentSession 走 faux provider，
含 502 仍重试的对照组）。pi 升级后若原生按状态码判，删掉这段 patch。

## @earendil-works/pi-coding-agent — 公开入口导出 `resolveToCwd`

`dist/index.js` / `dist/index.d.ts`：追加一行 `export { resolveToCwd } from "./core/tools/path-utils.js"`。

**为什么（2026-10-01）**：会话回退的文件账（`src/agent/file-tracker.ts` 的 `resolveToolPath`）必须与
pi 的 write / edit 工具算出**同一个**绝对路径，而工具内部用的就是 `resolveToCwd`。它不在包的公开入口，
deep import 又被 `exports` 拦下（`ERR_PACKAGE_PATH_NOT_EXPORTED`）。此前手抄的一份漏了 win32 的
MSYS 路径折算（`/c/Users/x` → `C:\Users\x`）、`~\` 展开与 `file://` 转换，工具写 A、账记 B，回退静默失效。

**行为守卫**：`src/agent/file-tracker.test.ts`（断言 `resolveToolPath === resolveToCwd`，并逐形态比对）。
pi 升级后若原生导出了它，删掉这两行 patch。
