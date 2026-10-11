/**
 * macOS 许可证记录编解码的单测（不需要 Typora，也不碰本机 ~/Library）。
 *
 * 钉住两条会让 NSKeyedUnarchiver **静默返回 nil** 的编码硬约束：
 *   1. binary plist 的 int marker 低 4 位是 log2(字节数)（4 字节是 0x12 而不是 0x13）；
 *   2. NSKeyedArchive 的 `NS.time` 必须按 real（0x23，双精度）编码——
 *      个别时刻恰为整数时若退化成 int，整份记录会解档失败（现象是「伪造被无视、未激活」且无报错）。
 */

import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  buildForgedRecord, decodeBplist, encodeBplist, fingerprint, LAST_TRY_HOURS_AGO, PlistUid,
  readRecord, recordLooksActivated, RealNumber, writeRecord, type LicenseRecord, type PLValue,
} from "./darwin-license.js";

/** NSDate 纪元（2001-01-01T00:00:00Z）。 */
const APPLE_EPOCH_MS = 978307200000;

test("指纹 = Base64(SHA256(uuid))[0..10]，特殊字符已净化", () => {
  const uuid = "A1B2C3D4-1111-2222-3333-444455556666";
  const fp = fingerprint(uuid);
  assert.equal(fp, createHash("sha256").update(uuid, "utf-8").digest("base64").slice(0, 10).replace(/[/=+-]/g, "a"));
  assert.equal(fp.length, 10);
  assert.equal(/[/=+-]/.test(fp), false);
});

test("binary plist 编解码往返（含 dict / array / string / bool / date / int）", () => {
  const value = {
    s: "typora",
    b: true,
    f: false,
    i: 42,
    arr: [1, 2, 3],
    nested: { k: "v" },
    d: new Date(1700000000123),
  };
  const decoded = decodeBplist(encodeBplist(value)) as Record<string, unknown>;
  assert.equal(decoded["s"], "typora");
  assert.equal(decoded["b"], true);
  assert.equal(decoded["f"], false);
  assert.equal(decoded["i"], 42);
  assert.deepEqual(decoded["arr"], [1, 2, 3]);
  assert.deepEqual(decoded["nested"], { k: "v" });
  assert.equal((decoded["d"] as Date).getTime(), 1700000000123);
});

test("int marker 的低 4 位是 log2(字节数)：4 字节整数是 0x12", () => {
  const n = 70000; // > 0xFFFF ⇒ 4 字节
  const buf = encodeBplist({ n });
  const expect = Buffer.concat([Buffer.from([0x12]), Buffer.from([0x00, 0x01, 0x11, 0x70])]); // 70000 = 0x00011170
  assert.ok(buf.indexOf(expect) >= 0, "4 字节整数的 marker 必须是 0x12");
  assert.equal((decodeBplist(buf) as { n: number }).n, n);
});

test("1 字节 / 2 字节整数的 marker 分别是 0x10 / 0x11", () => {
  assert.ok(encodeBplist({ n: 7 }).indexOf(Buffer.from([0x10, 0x07])) >= 0);
  assert.ok(encodeBplist({ n: 700 }).indexOf(Buffer.from([0x11, 0x02, 0xbc])) >= 0); // 700 = 0x02bc
});

test("RealNumber 强制 real 编码（0x23 + 8 字节双精度）", () => {
  const v = 1700000000;
  const buf = encodeBplist({ t: new RealNumber(v) });
  assert.ok(buf.indexOf(Buffer.from([0x23])) >= 0, "必须按 real 编码");
  const decoded = decodeBplist(buf) as { t: number };
  assert.equal(decoded.t, v);
});

test("NS.time 必须 real：整秒时间戳解档后仍是 Date（不退化成 int）", () => {
  const dir = mkdtempSync(join(tmpdir(), "hapora-license-test-"));
  const path = join(dir, ".fingerprint");
  const uuid = "TEST-UUID-0001";
  try {
    // 取一个 Apple 纪元秒数恰为整数的时刻——最容易被退化成 int 的情形
    const seconds = Math.floor((Date.now() - APPLE_EPOCH_MS) / 1000);
    const installDate = new Date(APPLE_EPOCH_MS + seconds * 1000);
    const rec: LicenseRecord = new Map<string, PLValue>([["email", "a@b.c"], ["installDate", installDate]]);
    writeRecord(path, uuid, rec);
    const back = readRecord(path, uuid);
    assert.ok(back, "记录必须能被解回来（解档失败会返回 null）");
    assert.ok(back!.get("installDate") instanceof Date, "NS.time 解出来必须是 NSDate");
    assert.equal((back!.get("installDate") as Date).getTime(), installDate.getTime());
    assert.equal(back!.get("email"), "a@b.c");
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("记录文件是 CBC（零 IV）加密，不是 ECB —— 钉住 CommonCrypto 的 iv=NULL 语义", () => {
  const dir = mkdtempSync(join(tmpdir(), "hapora-license-test-"));
  const path = join(dir, ".fingerprint");
  const uuid = "TEST-UUID-0003";
  try {
    const rec: LicenseRecord = new Map<string, PLValue>([
      ["email", "a@b.c"],
      ["installDate", new Date(1700000000123)],
    ]);
    writeRecord(path, uuid, rec);
    const blob = readFileSync(path);
    const key = createHash("sha256").update(`${uuid}typora-license`, "utf-8").digest();

    // 零 IV 的 CBC 能解出 bplist 头 ⇒ 与 Typora 的 CCCrypt(iv=NULL, PKCS7) 同形态
    // （Apple 文档：只有 kCCOptionPKCS7Padding 而 iv=NULL 时仍是 CBC + 全零 IV；
    //   ECB 必须显式带 kCCOptionECBMode）
    const dec = createDecipheriv("aes-256-cbc", key, Buffer.alloc(16));
    const plain = Buffer.concat([dec.update(blob), dec.final()]);
    assert.equal(plain.subarray(0, 8).toString("latin1"), "bplist00");

    // 与 ECB 密文必须不同：多分组时两者从第二个分组起就分道扬镳。
    // （首个分组在两种模式下相同：C₁ = E(P₁ ⊕ 0) = E(P₁)，所以不能只看头 8 字节。）
    assert.ok(plain.length > 16, "明文必须是多分组，这个断言才有区分力");
    const ecb = createCipheriv("aes-256-ecb", key, null);
    const ecbBlob = Buffer.concat([ecb.update(plain), ecb.final()]);
    assert.notEqual(blob.toString("hex"), ecbBlob.toString("hex"));
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("记录往返：键全部保真，且 readRecord 对不存在/损坏的文件返回 null", () => {
  const dir = mkdtempSync(join(tmpdir(), "hapora-license-test-"));
  const path = join(dir, ".fingerprint");
  const uuid = "TEST-UUID-0002";
  try {
    assert.equal(readRecord(path, uuid), null);
    const rec: LicenseRecord = new Map<string, PLValue>([
      ["email", "krkr@xrl.im"],
      ["license", "POWER0-ED0000-BY0000-XRL000"],
      ["lastTry", new Date()],
      ["installDate", new Date()],
    ]);
    writeRecord(path, uuid, rec);
    const back = readRecord(path, uuid);
    assert.equal(back!.get("email"), "krkr@xrl.im");
    assert.equal(back!.get("license"), "POWER0-ED0000-BY0000-XRL000");
    assert.ok(recordLooksActivated(back));
    // 用别的 uuid（密钥不同）解密 ⇒ 解不出来，返回 null
    assert.equal(readRecord(path, "ANOTHER-UUID"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("伪造记录：补上 email/license、lastTry 回拨金丝雀小时数、保留 installDate、清 failedCounts", () => {
  const now = new Date("2026-10-11T12:00:00Z");
  const existing: LicenseRecord = new Map<string, PLValue>([
    ["installDate", new Date("2026-01-01T00:00:00Z")],
    ["failedCounts", 3],
  ]);
  const rec = buildForgedRecord({ email: "me@x.io", licenseCode: "ABC123-DEF456-GHI789-JKL012", now }, existing, LAST_TRY_HOURS_AGO);
  assert.equal(rec.get("email"), "me@x.io");
  assert.equal(rec.get("license"), "ABC123-DEF456-GHI789-JKL012");
  assert.equal((rec.get("lastTry") as Date).getTime(), now.getTime() - LAST_TRY_HOURS_AGO * 3600 * 1000);
  assert.equal((rec.get("installDate") as Date).getTime(), new Date("2026-01-01T00:00:00Z").getTime());
  assert.equal(rec.has("failedCounts"), false);
  assert.ok(recordLooksActivated(rec));
});

test("recordLooksActivated：email 与 license 都在才算激活", () => {
  assert.equal(recordLooksActivated(null), false);
  assert.equal(recordLooksActivated(new Map()), false);
  assert.equal(recordLooksActivated(new Map<string, PLValue>([["email", "a"]])), false);
  assert.equal(recordLooksActivated(new Map<string, PLValue>([["email", "a"], ["license", "b"]])), true);
});

test("PlistUid 可独立往返（keyed archive 的引用形态）", () => {
  const buf = encodeBplist({ root: new PlistUid(7) });
  const decoded = decodeBplist(buf) as { root: PlistUid };
  assert.ok(decoded.root instanceof PlistUid);
  assert.equal(decoded.root.value, 7);
});
