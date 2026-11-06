// 记录型 anthropic-messages mock：收请求 → 落盘 body → 回最小合法 SSE。
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
const OUT = process.env.OUT ?? "/tmp/anthropic-req.json";
const PORT = Number(process.env.PORT ?? 5391);
let n = 0;
const server = createServer((req, res) => {
  const parts = [];
  req.on("data", (c) => parts.push(c));
  req.on("end", () => {
    const body = Buffer.concat(parts).toString("utf8");
    writeFileSync(`${OUT}.${n}`, JSON.stringify({ url: req.url, headers: req.headers, body }, null, 1));
    n += 1;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const ev = (name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    ev("message_start", { type: "message_start", message: { id: "m1", type: "message", role: "assistant", model: "mock", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } });
    ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } });
    ev("content_block_stop", { type: "content_block_stop", index: 0 });
    ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } });
    ev("message_stop", { type: "message_stop" });
    res.end();
  });
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
console.log(`anthropic-rec-mock on ${PORT} -> ${OUT}.*`);
