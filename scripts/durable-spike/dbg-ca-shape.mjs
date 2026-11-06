// 抓 ca 侧 anthropic 请求形状（bare / full）：打到本地记录 mock。
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolvePkg } from "./pkgs.mjs";
const mod = (p) => import(pathToFileURL(resolvePkg(process.env.CA_ROOT, p)).href);
const { createAgentSessionFromServices, createAgentSessionServices, SessionManager } = await mod("@earendil-works/pi-coding-agent");
const variant = process.argv[2] ?? "bare";
const port = process.env.MOCK_PORT ?? "5391";
const cwd = await mkdtemp(join(tmpdir(), "dbg-ca2-"));
const services = await createAgentSessionServices({
  cwd,
  resourceLoaderOptions: {
    noSkills: true,
    extensionFactories: variant === "bare" ? [{ name: "bare", hidden: true, factory: (pi) => { pi.on("before_agent_start", () => ({ systemPrompt: "" })); } }] : [],
  },
});
services.settingsManager.applyOverrides({ retry: { maxRetries: 0, baseDelayMs: 1 } });
if (variant === "bare") services.settingsManager.applyOverrides({ defaultTools: [] });
services.modelRuntime.registerProvider("mock-anthropic", {
  baseUrl: `http://127.0.0.1:${port}`, apiKey: "x", api: "anthropic-messages",
  models: [{ id: "m", name: "m", api: "anthropic-messages", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 }],
});
const model = services.modelRuntime.getModel("mock-anthropic", "m");
const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(cwd), model });
await session.prompt("hello", { expandPromptTemplates: false });
console.log(`[${variant}] done; session.systemPrompt len:`, session.systemPrompt.length);
process.exit(0);
