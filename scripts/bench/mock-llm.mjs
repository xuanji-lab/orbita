// 测量用假模型：OpenAI chat/completions 兼容的 SSE 流。零依赖，Mac / Windows 同一份。
// 行为只由最后一条用户消息里的指令决定，两台机器上同一句话产生同样的流：
//   tokens=N  正文 N 个 token（默认 200）     rate=R   每秒 R 个（默认 50）
//   ttft=MS   收到请求后多久出第一个字（默认 300）
//   tool=K    先连调 K 次 read 工具，读 toolFile（每次一样大），之后再回正文
//   ctx=T     正文那条回复报 T 个输入 token（默认 1000）。超过「窗口 − 保留量」时 pi 在这轮末尾自动压缩
// 压缩的总结请求（system prompt 是 pi 的 SUMMARIZATION_SYSTEM_PROMPT）不看指令：固定等 summaryMs，
// 再一次性回一段固定的 ~6 KB 摘要，两台机器上压缩耗时里「模型那部分」一样。
// 工具用 read 而不是 bash：Windows 上没有 /dev/zero 与 tr，read 走的是同一条工具结果路径。
// 正文 token 是「 qzv」（不会出现在提示词里），驱动脚本靠它认首字。usage 固定报 1000 输入 token，
// 不让 15 MB 级的真实历史触发自动压缩（压缩另作场景）。
// 每个请求记一条：到达时刻、请求体字节、消息条数、是否带工具、流结束时刻。驱动与假模型同进程同钟，
// 「到达 − 回车」就是 Orbita 自己在发请求前花的时间（读会话、拼上下文、序列化），不用在应用里加探针。
import { createServer } from "node:http";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (text, key, dflt) => Number(new RegExp(`\\b${key}=(\\d+)`).exec(text)?.[1] ?? dflt);
const textOf = (content) =>
  typeof content === "string" ? content : (content ?? []).map((b) => b.text ?? "").join("");

const SUMMARY = `## Goal\nbench summary\n\n${"- bench progress line qzv kept for size\n".repeat(150)}`;

export function startMock({ port, toolFile, summaryMs = 2000 }) {
  /** @type {Array<{arrivedAt:number, bodyBytes:number, messages:number, hasTools:boolean, kind:string, doneAt?:number}>} */
  const log = [];
  const server = createServer((req, res) => {
    const arrivedAt = Date.now();
    const parts = [];
    req.on("data", (c) => parts.push(c));
    req.on("end", async () => {
      const body = Buffer.concat(parts);
      if (!req.url.includes("chat/completions")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "bench-model" }] }));
        return;
      }
      const json = JSON.parse(body.toString("utf8") || "{}");
      const msgs = json.messages ?? [];
      const lastUser = msgs.findLastIndex((m) => m.role === "user");
      const text = textOf(msgs[lastUser]?.content);
      const toolsSinceUser = msgs.slice(lastUser + 1).filter((m) => m.role === "tool").length;
      const hasTools = (json.tools ?? []).some((t) => (t.function?.name ?? t.name) === "read");
      const plan = { tokens: num(text, "tokens", 200), rate: num(text, "rate", 50), ttft: num(text, "ttft", 300), tool: num(text, "tool", 0), ctx: num(text, "ctx", 1000) };
      const system = textOf(msgs.find((m) => m.role === "system" || m.role === "developer")?.content);
      // 压缩总结先认；标题生成、记忆抽取这类辅助请求不带工具：立即回几个字，不进工具剧本
      const kind = system.startsWith("You are a context summarization assistant")
        ? "summary"
        : !hasTools ? "aux" : toolsSinceUser < plan.tool ? "tool" : "text";
      // tag：并发场景里每条会话的提示词带 bench-session=<名>，按它把请求归到会话（没有就是 null）
      const tag = /\bbench-session=(\w+)/.exec(text)?.[1] ?? null;
      const entry = { arrivedAt, bodyBytes: body.length, messages: msgs.length, hasTools, kind, tag };
      log.push(entry);

      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const chunk = (delta, finish = null) =>
        res.write(`data: ${JSON.stringify({ id: "b", object: "chat.completion.chunk", created: 0, model: json.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      const end = (tokens, input = 1000) => {
        res.write(`data: ${JSON.stringify({ id: "b", object: "chat.completion.chunk", created: 0, model: json.model, choices: [], usage: { prompt_tokens: input, completion_tokens: tokens, total_tokens: input + tokens } })}\n\n`);
        res.end("data: [DONE]\n\n");
        entry.doneAt = Date.now();
      };
      if (kind === "summary") {
        await sleep(summaryMs);
        chunk({ role: "assistant", content: SUMMARY });
        chunk({}, "stop");
        return end(1500);
      }
      if (kind === "aux") {
        chunk({ role: "assistant", content: "bench" });
        chunk({}, "stop");
        return end(1);
      }
      await sleep(plan.ttft);
      chunk({ role: "assistant", content: "" });
      if (kind === "tool") {
        const args = JSON.stringify({ path: toolFile });
        chunk({ tool_calls: [{ index: 0, id: `call_${arrivedAt}_${toolsSinceUser}`, type: "function", function: { name: "read", arguments: args } }] });
        chunk({}, "tool_calls");
        return end(20);
      }
      for (let i = 0; i < plan.tokens; i++) {
        chunk({ content: i % 40 === 39 ? " qzv\n\n" : " qzv" });
        await sleep(1000 / plan.rate);
      }
      chunk({}, "stop");
      end(plan.tokens, plan.ctx);
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve({ log, close: () => server.close() }));
  });
}
