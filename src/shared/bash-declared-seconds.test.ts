import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { declaredCommandSeconds } from "./bash-declared-seconds.ts";

/**
 * `declaredCommandSeconds`：只认「整条命令就是一个简单命令」的自述时长。
 * 命不中就返回 null（闸门退回默认上限）——宁可少豁免，也不要乱猜。
 */
describe("declaredCommandSeconds", () => {
  test("认裸 sleep 的纯秒数", () => {
    assert.equal(declaredCommandSeconds("sleep 30"), 30);
    assert.equal(declaredCommandSeconds("sleep 2000"), 2000);
  });

  test("认 sleep 的 s 后缀（只认秒）", () => {
    assert.equal(declaredCommandSeconds("sleep 30s"), 30);
  });

  test("认 coreutils timeout 的第二个词（后面跟什么不解析）", () => {
    assert.equal(declaredCommandSeconds("timeout 2000 some-cmd --flag"), 2000);
    assert.equal(declaredCommandSeconds("timeout 30 bun run build"), 30);
  });

  test("容忍首尾空白与多余空白", () => {
    assert.equal(declaredCommandSeconds("  sleep   2000  "), 2000);
    assert.equal(declaredCommandSeconds("\ttimeout\t2000\tcmd\t"), 2000);
  });

  test("不认被包一层的（bash -c 'sleep 2000'）：命令名不是 sleep", () => {
    assert.equal(declaredCommandSeconds("bash -c 'sleep 2000'"), null);
  });

  test("不认 && 拼接（复合命令的时长不可信）", () => {
    assert.equal(declaredCommandSeconds("cd x && sleep 2000"), null);
  });

  test("不认 ; 拼接", () => {
    assert.equal(declaredCommandSeconds("sleep 30; echo ok"), null);
  });

  test("不认 & 后台", () => {
    assert.equal(declaredCommandSeconds("sleep 30 & echo ok"), null);
  });

  test("不认管道", () => {
    assert.equal(declaredCommandSeconds("sleep 30 | cat"), null);
  });

  test("不认重定向", () => {
    assert.equal(declaredCommandSeconds("sleep 30 > /tmp/x"), null);
    assert.equal(declaredCommandSeconds("sleep 30 < /tmp/x"), null);
  });

  test("不认子 shell / 反引号 / 变量（时长执行时才知道）", () => {
    assert.equal(declaredCommandSeconds("(sleep 30)"), null);
    assert.equal(declaredCommandSeconds("sleep `cat 30`"), null);
    assert.equal(declaredCommandSeconds("S=2000; sleep $S"), null);
  });

  test("不认多行命令", () => {
    assert.equal(declaredCommandSeconds("sleep 30\necho ok"), null);
    assert.equal(declaredCommandSeconds("sleep 30\r\necho ok"), null);
  });

  test("不认全路径（白名单只认裸词）", () => {
    assert.equal(declaredCommandSeconds("/usr/bin/sleep 30"), null);
    assert.equal(declaredCommandSeconds("/bin/timeout 2000 cmd"), null);
  });

  test("不认缺参数", () => {
    assert.equal(declaredCommandSeconds("sleep"), null);
    assert.equal(declaredCommandSeconds("timeout"), null);
    assert.equal(declaredCommandSeconds("timeout 2000"), null, "没有要跑的命令不是有效 timeout");
  });

  test("不认非数字参数", () => {
    assert.equal(declaredCommandSeconds("sleep abc"), null);
    assert.equal(declaredCommandSeconds("sleep 1.5"), null, "只认整数秒");
  });

  test("不认分钟后缀（sleep 1m 不能被 parseInt 误读成 1 秒）", () => {
    assert.equal(declaredCommandSeconds("sleep 1m"), null);
    assert.equal(declaredCommandSeconds("sleep 2h"), null);
  });

  test("不认非正数", () => {
    assert.equal(declaredCommandSeconds("sleep 0"), null);
    assert.equal(declaredCommandSeconds("sleep -5"), null);
    assert.equal(declaredCommandSeconds("timeout 0 cmd"), null);
  });

  test("不认只是提到 sleep 的命令", () => {
    assert.equal(declaredCommandSeconds("echo sleep 2000"), null);
    assert.equal(declaredCommandSeconds("grep -r 'sleep 2000' ."), null);
  });

  test("不认 sleep 的多个参数（真实时长是它们的和，不是任何一个 token）", () => {
    assert.equal(declaredCommandSeconds("sleep 30 40"), null);
  });

  test("空命令与空白命令", () => {
    assert.equal(declaredCommandSeconds(""), null);
    assert.equal(declaredCommandSeconds("   "), null);
  });
});
