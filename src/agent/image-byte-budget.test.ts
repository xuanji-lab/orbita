/**
 * image-byte-budget 的行为测试（纯模块，node --test 直接跑）。
 *
 * 覆盖：未超预算不动 / 超预算换到目标线以下 / 最近一轮保留 / 水位重放的
 * 前缀逐字节稳定 / 再次越线再次推进 / 占位文本的来源与路径 / 图片头尺寸
 * 解析 / 本子读取。触发线 24MiB 是真量级，测试里用可控的假 base64 填出来。
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import {
  IMAGE_BUDGET_ENTRY,
  IMAGE_BUDGET_TARGET_BYTES,
  IMAGE_BUDGET_TRIGGER_BYTES,
  IMAGE_REFS_ENTRY,
  estimateMessagesBytes,
  hashImage,
  imageSizeOf,
  planImageBudget,
  readImageBudgetBook,
  type ContextMessage,
  type ImageBudgetMark,
} from "./image-byte-budget.ts";

/** 手工 PNG 头（8 字节签名 + IHDR），尺寸可指定；pad 把 base64 撑到想要的大小 */
function pngData(width: number, height: number, padBytes = 0): string {
  const buffer = Buffer.alloc(24 + padBytes);
  buffer.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "latin1");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer.toString("base64");
}

/** 填充用的假 base64（不解码也不解析尺寸；长度即估算长度） */
function fillerData(size: number): string {
  return "A".repeat(size);
}

function userMessage(text: string, images: string[] = [], timestamp = 1000): ContextMessage {
  return {
    role: "user",
    content: [
      { type: "text", text },
      ...images.map((data) => ({ type: "image" as const, data, mimeType: "image/png" })),
    ],
    timestamp,
  } as ContextMessage;
}

function assistantMessage(content: unknown[], timestamp: number): ContextMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-x",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp,
  } as ContextMessage;
}

function assistantWithRead(path: string, timestamp = 1000): ContextMessage {
  return assistantMessage(
    [{ type: "toolCall", id: "call-1", name: "read", arguments: { path } }],
    timestamp,
  );
}

function toolResultMessage(
  toolCallId: string,
  images: string[],
  options: { text?: string; timestamp?: number; toolName?: string } = {},
): ContextMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: options.toolName ?? "read",
    content: [
      { type: "text", text: options.text ?? "Read image file [image/png]" },
      ...images.map((data) => ({ type: "image" as const, data, mimeType: "image/png" })),
    ],
    isError: false,
    timestamp: options.timestamp ?? 1001,
  } as ContextMessage;
}

/** 占位文本块：把替换后的 content 里的 text 块捞出来（跳过第一条原文说明） */
function placeholderTexts(message: ContextMessage): string[] {
  const content = (message as { content: unknown }).content;
  assert.ok(Array.isArray(content));
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text);
}

describe("imageSizeOf", () => {
  test("PNG 头：宽高解析", () => {
    assert.deepEqual(imageSizeOf(pngData(3840, 2340), "image/png"), { width: 3840, height: 2340 });
  });
  test("GIF 头：宽高解析", () => {
    const buffer = Buffer.alloc(13);
    buffer.write("GIF89a", 0, "latin1");
    buffer.writeUInt16LE(640, 6);
    buffer.writeUInt16LE(480, 8);
    assert.deepEqual(imageSizeOf(buffer.toString("base64"), "image/gif"), { width: 640, height: 480 });
  });
  test("JPEG：SOF0 段解析（前面隔一个 APP1 段）", () => {
    // SOI + APP1(8 字节) + SOF0(17 字节：precision 1 + 高 2 + 宽 2 + 分量数 1 + …)
    const buffer = Buffer.alloc(2 + 4 + 8 + 2 + 2 + 17);
    buffer.set([0xff, 0xd8], 0); // SOI
    buffer.set([0xff, 0xe1, 0x00, 0x0a], 2); // APP1，段长 10
    const sof = 2 + 4 + 8;
    buffer.set([0xff, 0xc0, 0x00, 0x11], sof); // SOF0，段长 17
    buffer.writeUInt16BE(1080, sof + 5);
    buffer.writeUInt16BE(1920, sof + 7);
    assert.deepEqual(imageSizeOf(buffer.toString("base64"), "image/jpeg"), { width: 1920, height: 1080 });
  });
  test("解析不了：null（不抛）", () => {
    assert.equal(imageSizeOf(fillerData(64), "image/png"), null);
    assert.equal(imageSizeOf("!!!!", "image/png"), null);
    assert.equal(imageSizeOf(pngData(1, 1), "image/webp"), null);
  });
});

describe("readImageBudgetBook", () => {
  const custom = (customType: string, data: unknown) =>
    ({ type: "custom", customType, data, id: `e-${customType}`, parentId: null, timestamp: "2026-10-11T00:00:00.000Z" }) as never;

  test("水位取最后一条预算 entry；引用逐条合并", () => {
    const branch = [
      custom(IMAGE_BUDGET_ENTRY, { cut: 100, cutIndex: 2, replaced: 5, bytesAfter: 1 }),
      custom(IMAGE_REFS_ENTRY, [["hash-a", "sess/aaa.png"]]),
      custom(IMAGE_BUDGET_ENTRY, { cut: 200, cutIndex: 4, replaced: 3, bytesAfter: 2 }),
      custom(IMAGE_REFS_ENTRY, [["hash-b", "sess/bbb.png"], ["hash-a", "sess/aaa.png"]]),
      { type: "message", id: "m1", parentId: null, timestamp: "t", message: null } as never,
    ];
    const book = readImageBudgetBook(branch);
    assert.equal(book.mark?.cut, 200);
    assert.equal(book.mark?.cutIndex, 4);
    assert.equal(book.refs.get("hash-a"), "sess/aaa.png");
    assert.equal(book.refs.get("hash-b"), "sess/bbb.png");
  });

  test("缺字段 / 坏形状：跳过（水位作废、引用不进），不抛", () => {
    const book = readImageBudgetBook([
      custom(IMAGE_BUDGET_ENTRY, { cut: "not-a-number" }),
      custom(IMAGE_BUDGET_ENTRY, { cut: 10 }),
      custom(IMAGE_REFS_ENTRY, "not-pairs"),
      custom(IMAGE_REFS_ENTRY, [[42, "x"], ["hash-c", null], ["hash-c", "sess/c.png"]]),
    ]);
    assert.equal(book.mark, null);
    assert.equal(book.refs.get("hash-c"), "sess/c.png");
    assert.equal(book.refs.size, 1);
  });
});

describe("planImageBudget", () => {
  test("未超预算：原样返回，不推进", () => {
    const messages: ContextMessage[] = [
      userMessage("看这张", [fillerData(1000)]),
      toolResultMessage("call-1", [fillerData(2000)]),
      userMessage("再说一句", [fillerData(500)]),
    ];
    const plan = planImageBudget(messages, null, new Map(), 2);
    assert.equal(plan.advancedCut, null);
    assert.equal(plan.replaced, 0);
    // 未动：浅数组新拷贝，但每条消息对象与原引用相同（没有替换就没有新对象）
    assert.equal(plan.messages[0], messages[0]);
  });

  test("超预算：从最早的图换起，直到估算落回目标线以下；最近一轮保留", () => {
    // 30 条早前消息各带 ~900KB 假图 ≈ 27MB > 24MB 触发；末轮 user 带一张图必须保留
    const early: ContextMessage[] = [];
    for (let i = 0; i < 30; i += 1) {
      early.push(userMessage(`早前第 ${i} 句`, [fillerData(900_000)], 1000 + i));
    }
    const messages = [...early, userMessage("最后这轮", [fillerData(700_000)], 9999)];
    const floor = messages.length - 1;
    const plan = planImageBudget(messages, null, new Map(), floor);
    assert.ok(plan.bytesBefore > IMAGE_BUDGET_TRIGGER_BYTES, "构造的场景必须真的越线");
    assert.ok(plan.bytesAfter < IMAGE_BUDGET_TARGET_BYTES, "替换后要落到目标线以下");
    assert.notEqual(plan.advancedCut, null);
    assert.ok(plan.replaced > 0);
    // 最近一轮的图保留
    const last = plan.messages[floor] as { content: { type: string }[] };
    assert.ok(last.content.some((block) => block.type === "image"), "最后一条用户消息的图必须保留");
    // 早前的图全部变成占位文本
    const first = plan.messages[0] as { content: { type: string }[] };
    assert.ok(first.content.every((block) => block.type === "text"), "最早的消息应被整条替换");
  });

  test("水位重放：与触发轮逐字节一致（前缀稳定），且不越线时不推进", () => {
    const early: ContextMessage[] = [];
    for (let i = 0; i < 30; i += 1) {
      early.push(userMessage(`早前第 ${i} 句`, [fillerData(900_000)], 1000 + i));
    }
    const turn1 = [...early, userMessage("第一轮", [fillerData(700_000)], 9999)];
    const plan1 = planImageBudget(turn1, null, new Map(), turn1.length - 1);
    const mark = plan1.advancedCut;
    assert.notEqual(mark, null);

    // 第二轮：同样的前缀 + 新的尾巴（小回复与新 prompt）
    const turn2: ContextMessage[] = [
      ...turn1,
      { role: "assistant", content: [{ type: "text", text: "好" }], timestamp: 20000 } as ContextMessage,
      userMessage("第二轮", [fillerData(10_000)], 21000),
    ];
    const plan2 = planImageBudget(turn2, mark, new Map(), turn2.length - 1);
    assert.equal(plan2.advancedCut, null, "不再越线不应推进");
    const prefix1 = JSON.stringify(plan1.messages);
    const prefix2 = JSON.stringify(plan2.messages.slice(0, turn1.length));
    assert.equal(prefix2, prefix1, "水位重放必须与触发轮的前缀逐字节一致");
  });

  test("再次越线：水位向前推进", () => {
    const early: ContextMessage[] = [];
    for (let i = 0; i < 30; i += 1) {
      early.push(userMessage(`早前第 ${i} 句`, [fillerData(900_000)], 1000 + i));
    }
    const turn1 = [...early, userMessage("第一轮", [], 9999)];
    const plan1 = planImageBudget(turn1, null, new Map(), turn1.length - 1);
    const mark1 = plan1.advancedCut;
    assert.notEqual(mark1, null);

    // 第二轮塞进一大批新图（在保护段之前成段追加），再次越线
    const more: ContextMessage[] = [];
    for (let i = 0; i < 25; i += 1) {
      more.push(userMessage(`第二轮里的第 ${i} 句`, [fillerData(900_000)], 20000 + i));
    }
    const turn2 = [...turn1, ...more, userMessage("第二轮", [], 39999)];
    const plan2 = planImageBudget(turn2, mark1, new Map(), turn2.length - 1);
    const mark2 = plan2.advancedCut;
    assert.notEqual(mark2, null, "再次越线必须推进");
    assert.ok(mark2!.cut > mark1!.cut, "新水位的锚点要更晚");
    assert.ok(plan2.bytesAfter < IMAGE_BUDGET_TARGET_BYTES);
  });

  test("同毫秒两条消息：下标锚保证重放与触发轮一致（只换到了前一条）", () => {
    // 总量 ≈25.5MB：A（9MB）替换后 ≈16.5MB < 16MiB 停手；B 同毫秒但不该被换
    const big = fillerData(9_000_000);
    const small = fillerData(300_000);
    const messages: ContextMessage[] = [
      userMessage("垫场", [fillerData(16_200_000)], 1000),
      toolResultMessage("call-a", [big], { timestamp: 5000 }),
      toolResultMessage("call-b", [small], { timestamp: 5000 }),
      userMessage("最后这轮", [fillerData(100)], 9999),
    ];
    const plan = planImageBudget(messages, null, new Map(), 3);
    const mark = plan.advancedCut;
    assert.notEqual(mark, null);
    assert.ok(plan.bytesAfter < IMAGE_BUDGET_TARGET_BYTES);
    const b = plan.messages[2] as { content: { type: string }[] };
    assert.ok(b.content.some((block) => block.type === "image"), "同毫秒但未被替换的 B 必须留图");
    // 重放：A 占位、B 仍留图（若只按时间戳锚，B 会被误替换）
    const replay = planImageBudget(messages, mark, new Map(), 3);
    const prefixA = JSON.stringify(plan.messages);
    const prefixB = JSON.stringify(replay.messages);
    assert.equal(prefixB, prefixA, "重放与触发轮逐字节一致");
    assert.equal(replay.advancedCut, null);
  });

  test("占位文本：read 的图带文件路径与尺寸", () => {
    const data = pngData(3840, 2340);
    const messages: ContextMessage[] = [
      assistantWithRead("/tmp/shot.png"),
      toolResultMessage("call-1", [data]),
      userMessage("继续", [], 9999),
    ];
    const plan = planImageBudget(messages, null, new Map(), 2);
    // 不越线也会给占位吗？不会——没触发就没替换。这里直接构造触发场景太贵，
    // 改用下面的越线用例；本用例先确认未越线时确实不动。
    assert.equal(plan.replaced, 0);
  });

  test("占位文本：越线后 read / show_image / browser_screenshot / 用户附件各带来源与路径", () => {
    const readImage = pngData(800, 600);
    const shownA = pngData(100, 100);
    const shownB = pngData(100, 100);
    const shot = fillerData(400_000);
    const attached = pngData(64, 64);
    const messages: ContextMessage[] = [
      // read 读图
      assistantMessage(
        [{ type: "toolCall", id: "c-read", name: "read", arguments: { path: "/work/a.png" } }],
        1000,
      ),
      toolResultMessage("c-read", [readImage]),
      // show_image 两张
      assistantMessage(
        [
          {
            type: "toolCall",
            id: "c-show",
            name: "show_image",
            arguments: { paths: ["/work/one.png", "/work/two.png"] },
          },
        ],
        1002,
      ),
      toolResultMessage("c-show", [shownA, shownB], { toolName: "show_image", timestamp: 1003 }),
      // browser_screenshot 存过盘
      assistantMessage(
        [{ type: "toolCall", id: "c-shot", name: "browser_screenshot", arguments: { save: true } }],
        1004,
      ),
      toolResultMessage("c-shot", [shot], {
        toolName: "browser_screenshot",
        text:
          "Screenshot of https://example.com (Example), 800×600, visible part of the page only. " +
          "Saved the full-resolution image to /work/shots/example.png. To show it to the user, " +
          "call show_image with this path.",
        timestamp: 1005,
      }),
      // 早期用户附件（有 ref 与无 ref 各一张）
      userMessage("早前的附件", [attached, fillerData(10)], 1006),
      // 垫量：让总量越线
      userMessage("垫场", [fillerData(25_000_000)], 1007),
      userMessage("最后这轮", [], 9999),
    ];
    const refs = new Map([[hashImage(attached), "/store/sess.attachments/uuid-1.png"]]);
    const plan = planImageBudget(messages, null, refs, messages.length - 1);
    assert.ok(plan.bytesBefore > IMAGE_BUDGET_TRIGGER_BYTES);
    assert.ok(plan.replaced >= 6);

    const readPlaceholder = placeholderTexts(plan.messages[1]!).at(-1) ?? "";
    assert.match(readPlaceholder, /read 读取的图片/);
    assert.match(readPlaceholder, /800×600/);
    assert.match(readPlaceholder, /\/work\/a\.png/);
    assert.match(readPlaceholder, /用 read 工具重新查看/);

    const showPlaceholders = placeholderTexts(plan.messages[3]!);
    assert.match(showPlaceholders.at(-2) ?? "", /\/work\/one\.png/);
    assert.match(showPlaceholders.at(-1) ?? "", /\/work\/two\.png/);

    const shotPlaceholder = placeholderTexts(plan.messages[5]!).at(-1) ?? "";
    assert.match(shotPlaceholder, /browser_screenshot 的截图/);
    assert.match(shotPlaceholder, /\/work\/shots\/example\.png/);

    const userPlaceholders = placeholderTexts(plan.messages[6]!);
    assert.match(userPlaceholders.at(-2) ?? "", /用户附件/);
    assert.match(userPlaceholders.at(-2) ?? "", /\/store\/sess\.attachments\/uuid-1\.png/);
    assert.match(userPlaceholders.at(-1) ?? "", /原图不可取回/);
  });

  test("入参不被改动（替换只发生在返回的副本上）", () => {
    const messages: ContextMessage[] = [
      userMessage("垫场", [fillerData(25_000_000)], 1000),
      userMessage("最后这轮", [], 9999),
    ];
    const before = JSON.stringify(messages);
    planImageBudget(messages, null, new Map(), 1);
    assert.equal(JSON.stringify(messages), before);
  });
});

describe("estimateMessagesBytes", () => {
  test("图片 base64 按字符数入账（ASCII 1:1），中文按 UTF-8 字节", () => {
    const messages: ContextMessage[] = [userMessage("中文三个字节一个字", [], 1)];
    const bytes = estimateMessagesBytes(messages);
    // JSON 总长无法精确断言，断两个方向性事实：远大于字符数（中文 3 倍），远小于 10KB
    assert.ok(bytes > 22, "三个中文字至少 9 字节 + 结构开销");
    assert.ok(bytes < 10_000);
    const imageMessage: ContextMessage[] = [userMessage("x", [fillerData(1000)], 1)];
    assert.ok(estimateMessagesBytes(imageMessage) > 1000, "base64 本体要计入");
  });
});

/** ImageBudgetMark 形状自查：运行时 appendEntry 的载荷必须能被 readImageBudgetBook 读回 */
test("mark 写读往返", () => {
  const mark: ImageBudgetMark = { cut: 123456, cutIndex: 7, replaced: 9, bytesAfter: 15_000_000 };
  const branch = [
    {
      type: "custom",
      customType: IMAGE_BUDGET_ENTRY,
      data: mark,
      id: "e1",
      parentId: null,
      timestamp: "2026-10-11T00:00:00.000Z",
    } as never,
  ];
  const book = readImageBudgetBook(branch);
  assert.equal(book.mark?.cut, mark.cut);
  assert.equal(book.mark?.cutIndex, mark.cutIndex);
});
