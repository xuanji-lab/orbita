/**
 * browser_press 的键名 → CDP `Input.dispatchKeyEvent` 的参数。纯函数，可被 node --test 直接加载。
 *
 * 键名沿用 KeyboardEvent.key / Playwright 的写法（模型最熟）：Enter、Tab、Escape、ArrowDown、PageDown、
 * a、A、1……组合键用 `+` 连：Shift+Tab、Control+A、Meta+A；`ControlOrMeta` 在 macOS 上是 Meta、
 * 其它平台是 Control（「全选」这类跨平台快捷键不用模型自己分平台）。
 *
 * macOS 上 Cmd+A / C / V / X / Z 在网页里不是靠按键事件生效的，而是系统把按键翻成编辑命令；
 * CDP 合成的按键不走那一层，得随事件带上 `commands`（Puppeteer 同样的处理），否则按了没反应。
 */

/** CDP 修饰键位：Alt=1、Control=2、Meta=4、Shift=8 */
const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 } as const;
type Modifier = keyof typeof MODIFIER_BITS;

export interface KeyStroke {
  key: string;
  code: string;
  /** windowsVirtualKeyCode（Chromium 在各平台都认它） */
  keyCode: number;
  modifiers: number;
  /** 这一下产生的字符；不产生字符的键（方向键、带 Control/Meta 的组合）为空串——CDP 走 rawKeyDown */
  text: string;
  /** macOS 编辑命令（selectAll / copy…），其余平台恒为空 */
  commands: string[];
}

const NAMED_KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  Insert: { code: "Insert", keyCode: 45 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
  " ": { code: "Space", keyCode: 32, text: " " },
};

/** 别名 → 规范名（大小写不敏感地匹配） */
const KEY_ALIASES: Record<string, string> = {
  esc: "Escape",
  return: "Enter",
  del: "Delete",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  space: " ",
  spacebar: " ",
  pgup: "PageUp",
  pgdn: "PageDown",
};

const MODIFIER_ALIASES: Record<string, Modifier | "ControlOrMeta"> = {
  alt: "Alt",
  option: "Alt",
  control: "Control",
  ctrl: "Control",
  meta: "Meta",
  cmd: "Meta",
  command: "Meta",
  shift: "Shift",
  controlormeta: "ControlOrMeta",
  cmdorctrl: "ControlOrMeta",
  commandorcontrol: "ControlOrMeta",
  mod: "ControlOrMeta",
};

/** macOS 上 Meta+字母 → 编辑命令（Shift 可选，只有 z 区分撤销 / 重做） */
const MAC_EDIT_COMMANDS: Record<string, string> = {
  a: "selectAll",
  c: "copy",
  x: "cut",
  v: "paste",
  z: "undo",
};

export function parseKeyCombo(input: string, platform: string): KeyStroke | { error: string } {
  const raw = input.trim();
  if (raw === "") return { error: "key is empty" };
  // 「+」本身也是一个键：末尾的 + 不当分隔符（Shift++、+）
  const parts = raw === "+" ? ["+"] : raw.endsWith("++") ? [...raw.slice(0, -2).split("+"), "+"] : raw.split("+");
  const keyPart = parts[parts.length - 1]?.trim() ?? "";
  if (keyPart === "") return { error: `"${input}" has no key after the modifiers` };
  const modifiers = new Set<Modifier>();
  for (const part of parts.slice(0, -1)) {
    const alias = MODIFIER_ALIASES[part.trim().toLowerCase()];
    if (alias === undefined) return { error: `Unknown modifier "${part.trim()}" — use Alt, Control, Meta, Shift or ControlOrMeta` };
    modifiers.add(alias === "ControlOrMeta" ? (platform === "darwin" ? "Meta" : "Control") : alias);
  }
  let bits = 0;
  for (const modifier of modifiers) bits |= MODIFIER_BITS[modifier];
  // 带 Control / Meta / Alt 的组合键不输入字符（Ctrl+A 不该往框里打一个 a）
  const typesText = !modifiers.has("Control") && !modifiers.has("Meta") && !modifiers.has("Alt");

  const named = resolveNamed(keyPart);
  if (named !== null) {
    return {
      key: named.key,
      code: named.code,
      keyCode: named.keyCode,
      modifiers: bits,
      text: typesText ? (named.text ?? "") : "",
      commands: [],
    };
  }
  if (/^F([1-9]|1[0-2])$/.test(keyPart)) {
    return { key: keyPart, code: keyPart, keyCode: 111 + Number(keyPart.slice(1)), modifiers: bits, text: "", commands: [] };
  }
  if ([...keyPart].length !== 1) return { error: `Unknown key "${keyPart}"` };

  const char = keyPart;
  const lower = char.toLowerCase();
  const isLetter = /^[a-z]$/.test(lower);
  const isDigit = /^[0-9]$/.test(char);
  // 字母：Shift 或写成大写都算大写（key 跟着变，code 不变——同真实键盘）
  const key = isLetter && (modifiers.has("Shift") || char !== lower) ? lower.toUpperCase() : char;
  const commands =
    platform === "darwin" && isLetter && modifiers.has("Meta") && !modifiers.has("Control") && !modifiers.has("Alt")
      ? lower === "z" && modifiers.has("Shift")
        ? ["redo"]
        : MAC_EDIT_COMMANDS[lower] !== undefined
          ? [MAC_EDIT_COMMANDS[lower]]
          : []
      : [];
  return {
    key,
    code: isLetter ? `Key${lower.toUpperCase()}` : isDigit ? `Digit${char}` : "",
    keyCode: isLetter ? lower.toUpperCase().charCodeAt(0) : isDigit ? char.charCodeAt(0) : 0,
    modifiers: bits,
    text: typesText ? key : "",
    commands,
  };
}

function resolveNamed(part: string): { key: string; code: string; keyCode: number; text?: string } | null {
  const direct = NAMED_KEYS[part];
  if (direct !== undefined) return { key: part, ...direct };
  const lower = part.toLowerCase();
  const alias = KEY_ALIASES[lower];
  if (alias !== undefined) return { key: alias, ...NAMED_KEYS[alias]! };
  for (const [name, spec] of Object.entries(NAMED_KEYS)) {
    if (name.toLowerCase() === lower) return { key: name, ...spec };
  }
  return null;
}
