// 抓 du 侧 anthropic 请求形状（bare / full）：打到本地记录 mock。
import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolvePkg } from "./pkgs.mjs";
const mod = (p) => import(pathToFileURL(resolvePkg(process.env.DURABLE_ROOT, p)).href);
const { BACKGROUND_CONTEXT } = await mod("@earendil-works/chord/context");
const { createModels, createProvider } = await mod("@earendil-works/pi-ai/models");
const { anthropicMessagesApi } = await mod("@earendil-works/pi-ai/api/anthropic-messages.lazy");
const durable = await mod("@earendil-works/pi-durable");
const { openNodeSqliteStorage } = await mod("@earendil-works/pi-durable/storage/sqlite/node");
const { createCodingTools } = await mod("@earendil-works/pi-durable/tools");
const context = BACKGROUND_CONTEXT;
const variant = process.argv[2] ?? "bare";
const port = process.env.MOCK_PORT ?? "5391";
const provider = createProvider({
  id: "mock-anthropic", name: "Mock", baseUrl: `http://127.0.0.1:${port}`,
  auth: { apiKey: { name: "x", resolve: async () => ({ auth: { apiKey: "x", baseUrl: `http://127.0.0.1:${port}` } }) } },
  models: [{ provider: "mock-anthropic", id: "m", name: "m", api: "anthropic-messages", baseUrl: `http://127.0.0.1:${port}`, compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true }, input: ["text"], reasoning: false, contextWindow: 128_000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  api: anthropicMessagesApi(),
});
const models = createModels();
models.setProvider(provider);
const registry = durable.createRegistry();
if (variant === "full") {
  registry.install(createCodingTools());
  const filler = Array.from({ length: 90 }, (_, i) => `Guideline ${i}: 你是一个简洁的编码助手，回答要准确、避免废话，注意文件操作安全与命令执行规范。`).join("\n");
  registry.install(durable.defineExtension({ name: "bench-big", sections: [durable.section("big", () => filler)] }));
}
const dir = await mkdtemp(join(import.meta.dirname, "dbgdu"));
const db = join(dir, "x.sqlite");
const harness = await durable.Harness.open(await openNodeSqliteStorage(db), { models, registry }, context);
const root = await harness.root(context, { agent: { model: { provider: "mock-anthropic", modelId: "m" } } });
harness.resume();
const settled = await (await root.submit({ type: "input", content: "hello", requestId: "r1" }, context)).wait(context);
console.log(`[${variant}] settled=${settled.status}`);
await harness.close(context);
rmSync(dir, { recursive: true, force: true });
process.exit(0);
