import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { PairProveFrame } from "../../shared/mobile.ts";
import { MOBILE_CRYPTO } from "../../shared/mobile.ts";
import {
  boxKeyPairFromRaw,
  generateBoxKeyPair,
  hostProofOf,
  openPairingBox,
  pairMessage,
  pairProofOf,
  type PairingOffer,
} from "./crypto.ts";
import { PairingBook } from "./pairing.ts";

const HOST = boxKeyPairFromRaw(Buffer.from("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a", "hex"));
const DEVICE_ID = "fedcba9876543210fedcba9876543210";
const NAME = "wafo 的 Pixel";
/** 测试里的轻量派生：真 scrypt 已在 crypto.test.ts 用 RFC 参数与定值向量单独验过 */
const lite = (code: Buffer, salt: Buffer): Promise<Buffer> => Promise.resolve(createHash("sha256").update(code).update(salt).digest());

function fixture(maxTrackedAddresses?: number): { book: PairingBook; advance(ms: number): void } {
  let now = 1_700_000_000_000;
  return {
    book: new PairingBook({ now: () => now, hostBoxPublic: HOST.publicRaw, derivePinKey: lite, ...(maxTrackedAddresses === undefined ? {} : { maxTrackedAddresses }) }),
    advance: (ms) => {
      now += ms;
    },
  };
}

/** 手机那一侧：解 box、生成自己的长期钥匙、算证明 */
async function phoneProof(
  offer: PairingOffer,
  input: { code?: string; device?: ReturnType<typeof generateBoxKeyPair>; hostBoxPublic?: Buffer; name?: string } = {},
): Promise<PairProveFrame | null> {
  const code = input.code ?? offer.code;
  const seed = await openPairingBox(Buffer.from(offer.wire.box, "base64"), Buffer.from(offer.wire.salt, "base64"), Buffer.from(offer.wire.iv, "base64"), code, lite);
  if (seed === null) return null;
  const device = input.device ?? generateBoxKeyPair();
  const deviceName = input.name ?? NAME;
  const message = pairMessage({
    offerId: offer.wire.offerId,
    salt: Buffer.from(offer.wire.salt, "base64"),
    iv: Buffer.from(offer.wire.iv, "base64"),
    box: Buffer.from(offer.wire.box, "base64"),
    hostBoxPublic: input.hostBoxPublic ?? Buffer.from(offer.wire.hostBoxPublic, "base64"),
    deviceBoxPublic: device.publicRaw,
    deviceName,
  });
  return {
    v: 1,
    type: "pair.prove",
    id: 2,
    params: {
      offerId: offer.offerId,
      deviceBoxPublic: device.publicRaw.toString("base64"),
      deviceName,
      proof: pairProofOf(seed, message).toString("base64"),
    },
  };
}

describe("配对：走通与一次性", () => {
  test("配对码解开种子，手机自生成钥匙；证明与双向确认都对，种子用掉即清", async () => {
    const { book } = fixture();
    const offer = await book.create();
    assert.deepEqual(book.current(), { offerId: offer.offerId, code: offer.code, expiresAt: offer.expiresAt });
    assert.deepEqual(book.wire(), offer.wire);
    const seedBefore = Buffer.from(offer.seed);
    const device = generateBoxKeyPair();
    const frame = await phoneProof(offer, { device });
    assert.ok(frame);
    const message = pairMessage({
      offerId: offer.offerId,
      salt: Buffer.from(offer.wire.salt, "base64"),
      iv: Buffer.from(offer.wire.iv, "base64"),
      box: Buffer.from(offer.wire.box, "base64"),
      hostBoxPublic: HOST.publicRaw,
      deviceBoxPublic: device.publicRaw,
      deviceName: NAME,
    });
    const expectedHostProof = hostProofOf(seedBefore, message, DEVICE_ID);
    const verdict = book.prove(frame, DEVICE_ID);
    assert.ok(verdict.ok);
    assert.equal(verdict.hostProof.toString("hex"), expectedHostProof.toString("hex"));
    assert.equal(verdict.deviceBoxPublic.toString("hex"), device.publicRaw.toString("hex"));
    assert.equal(book.current(), null);
    assert.equal(book.wire(), null);
    assert.ok(offer.seed.every((byte) => byte === 0), "种子用掉后原地清零");
    // 同一个证明不能重放来登记第二台设备
    assert.equal(book.prove(frame, DEVICE_ID).ok, false);
  });

  test("正在生成时重复点拿到同一份；生成第二份会让第一份作废", async () => {
    const { book } = fixture();
    const firstPromise = book.create();
    assert.equal(book.create(), firstPromise);
    const first = await firstPromise;
    const firstProof = await phoneProof(first);
    assert.ok(firstProof);
    const second = await book.create();
    assert.notEqual(first.offerId, second.offerId);
    assert.ok(first.seed.every((byte) => byte === 0));
    assert.equal(book.prove(firstProof, DEVICE_ID).ok, false);
    assert.equal(book.current()?.offerId, second.offerId);
    book.cancel();
  });

  test("取消：已有的与正在生成的都作废；取消后再生成能拿到新的", async () => {
    const { book } = fixture();
    const pending = book.create();
    book.cancel();
    const replacementPromise = book.create();
    const [cancelled, replacement] = await Promise.all([pending, replacementPromise]);
    assert.ok(cancelled.seed.every((byte) => byte === 0));
    assert.equal(book.current()?.offerId, replacement.offerId);
    book.cancel();
    assert.equal(book.current(), null);
    const proof = await phoneProof(replacement);
    assert.ok(proof);
    assert.equal(book.prove(proof, DEVICE_ID).ok, false);
  });
});

describe("配对：猜不对、过期与中间人", () => {
  test("配对码错：box 解不开；硬发一份用别的种子算的证明也过不了", async () => {
    const { book } = fixture();
    const offer = await book.create();
    assert.equal(await phoneProof(offer, { code: "000000" }), null);
    const device = generateBoxKeyPair();
    const wrongSeed = Buffer.alloc(32, 9);
    const message = pairMessage({
      offerId: offer.offerId,
      salt: Buffer.from(offer.wire.salt, "base64"),
      iv: Buffer.from(offer.wire.iv, "base64"),
      box: Buffer.from(offer.wire.box, "base64"),
      hostBoxPublic: HOST.publicRaw,
      deviceBoxPublic: device.publicRaw,
      deviceName: NAME,
    });
    const verdict = book.prove(
      { v: 1, type: "pair.prove", id: 2, params: { offerId: offer.offerId, deviceBoxPublic: device.publicRaw.toString("base64"), deviceName: NAME, proof: pairProofOf(wrongSeed, message).toString("base64") } },
      DEVICE_ID,
    );
    assert.deepEqual(verdict, { ok: false, error: { code: "unauthorized", message: "配对码已过期或不对，请在电脑上重新生成" } });
    book.cancel();
  });

  test("提议过期：current 与 prove 都拒，种子清掉", async () => {
    const { book, advance } = fixture();
    const offer = await book.create();
    const frame = await phoneProof(offer);
    assert.ok(frame);
    advance(MOBILE_CRYPTO.offerTtlMs);
    assert.equal(book.current(), null);
    assert.equal(book.prove(frame, DEVICE_ID).ok, false);
    assert.ok(offer.seed.every((byte) => byte === 0));
  });

  test("连错 5 次作废：第 6 次即使拿对证明也过不了", async () => {
    const { book } = fixture();
    const offer = await book.create();
    const good = await phoneProof(offer);
    assert.ok(good);
    const bad: PairProveFrame = { ...good, params: { ...good.params, proof: Buffer.alloc(32).toString("base64") } };
    for (let attempt = 1; attempt <= MOBILE_CRYPTO.maxProveAttemptsPerOffer; attempt += 1) {
      const verdict = book.prove(bad, DEVICE_ID);
      assert.equal(verdict.ok, false);
      if (attempt < MOBILE_CRYPTO.maxProveAttemptsPerOffer) assert.equal(book.current()?.offerId, offer.offerId);
    }
    assert.equal(book.current(), null);
    assert.equal(book.prove(good, DEVICE_ID).ok, false);
  });

  test("中间人换掉 hostBoxPublic：手机看到的 M 不同，电脑验证明失败", async () => {
    const { book } = fixture();
    const offer = await book.create();
    const attacker = generateBoxKeyPair();
    const frame = await phoneProof(offer, { hostBoxPublic: attacker.publicRaw });
    assert.ok(frame);
    const verdict = book.prove(frame, DEVICE_ID);
    assert.equal(verdict.ok, false);
    // 手机侧的双向确认：冒充者不知道 S，随便给的 hostProof 不等于真电脑应给的值
    const realMessage = pairMessage({
      offerId: offer.offerId,
      salt: Buffer.from(offer.wire.salt, "base64"),
      iv: Buffer.from(offer.wire.iv, "base64"),
      box: Buffer.from(offer.wire.box, "base64"),
      hostBoxPublic: HOST.publicRaw,
      deviceBoxPublic: Buffer.from(frame.params.deviceBoxPublic, "base64"),
      deviceName: frame.params.deviceName,
    });
    const forged = Buffer.alloc(32, 4);
    assert.notEqual(forged.toString("hex"), hostProofOf(offer.seed, realMessage, DEVICE_ID).toString("hex"));
    book.cancel();
  });

  test("证明本身对了、但设备公钥是低阶点：也拒绝登记", async () => {
    const { book } = fixture();
    const offer = await book.create();
    const lowOrder = Buffer.alloc(32);
    const message = pairMessage({
      offerId: offer.offerId,
      salt: Buffer.from(offer.wire.salt, "base64"),
      iv: Buffer.from(offer.wire.iv, "base64"),
      box: Buffer.from(offer.wire.box, "base64"),
      hostBoxPublic: HOST.publicRaw,
      deviceBoxPublic: lowOrder,
      deviceName: NAME,
    });
    const verdict = book.prove(
      { v: 1, type: "pair.prove", id: 2, params: { offerId: offer.offerId, deviceBoxPublic: lowOrder.toString("base64"), deviceName: NAME, proof: pairProofOf(offer.seed, message).toString("base64") } },
      DEVICE_ID,
    );
    assert.equal(verdict.ok, false);
    book.cancel();
  });
});

describe("pair.start 来源限速", () => {
  test("每来源地址每分钟 10 次；别的地址不受影响；窗口过后恢复", () => {
    const { book, advance } = fixture();
    for (let i = 0; i < MOBILE_CRYPTO.pairStartPerMinutePerAddress; i += 1) assert.equal(book.admitStart("100.100.1.2"), true);
    assert.equal(book.admitStart("100.100.1.2"), false);
    assert.equal(book.admitStart("192.168.1.8"), true);
    advance(59_999);
    assert.equal(book.admitStart("100.100.1.2"), false);
    advance(1);
    assert.equal(book.admitStart("100.100.1.2"), true);
  });

  test("地址表满了先扫过期项；仍满时新地址拒，记过的地址按窗口放行", () => {
    const { book, advance } = fixture(2);
    assert.equal(book.admitStart("a"), true);
    assert.equal(book.admitStart("b"), true);
    assert.equal(book.admitStart("c"), false);
    advance(60_000);
    // 过期项被扫掉后允许新地址
    assert.equal(book.admitStart("c"), true);
    assert.equal(book.admitStart("d"), true);
    assert.equal(book.admitStart("e"), false);
  });
});
