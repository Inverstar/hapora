/**
 * Linux 许可证存储的单测（纯函数部分，不需要 Typora）。
 *
 * 钉住两条「踩错就静默失效」的硬约束：
 *   1. 文件名指纹 = Base64(SHA256(machineId + "typora"))[0..10] 且 [/=+-] → "a"（末尾替换不可省）；
 *   2. 文件内容是**整段 JSON 的十六进制编码**（同 profile.data），不是裸 JSON——
 *      写成裸 JSON 时 Typora 读不出 SLicense，日志恒 `no info` + `hasL: false` 且无任何报错。
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { decodeLicenseFile, encodeLicenseFile, fingerprintFor } from "./linux.js";
import { licenseValue, LICENSE_MARKER } from "../patch.js";

test("指纹 = Base64(SHA256(machineId + \"typora\"))[0..10]，特殊字符已净化", () => {
  const mid = "7f9c2b1e4d4a4f0e9a112c3d4e5f6a7b";
  const fp = fingerprintFor(mid);
  const raw = createHash("sha256").update(mid + "typora").digest("base64").slice(0, 10);
  assert.equal(fp, raw.replace(/[/=+-]/g, "a"));
  assert.equal(fp.length, 10);
  assert.equal(/[/=+-]/.test(fp), false);
});

test("指纹末尾替换不可省（raw 含特殊字符时两者必须不同）", () => {
  let hit = "";
  for (let i = 0; i < 5000 && !hit; i++) {
    const mid = `machine-${i}`;
    const raw = createHash("sha256").update(mid + "typora").digest("base64").slice(0, 10);
    if (/[/=+-]/.test(raw)) hit = mid;
  }
  assert.ok(hit, "没撞出含特殊字符的片段（公式可能变了）");
  const fp = fingerprintFor(hit);
  const raw = createHash("sha256").update(hit + "typora").digest("base64").slice(0, 10);
  assert.notEqual(fp, raw);
  assert.equal(fp, raw.replace(/[/=+-]/g, "a"));
});

test("文件内容是整段 JSON 的十六进制，不是裸 JSON", () => {
  const data = { SLicense: licenseValue(new Date(2026, 8, 3)) };
  const text = encodeLicenseFile(data);
  assert.match(text, /^[0-9a-f]+$/);
  assert.throws(() => JSON.parse(text), "裸 JSON.parse 必须失败（内容不是 JSON）");
  assert.deepEqual(decodeLicenseFile(text), data);
});

test("只有 SLicense 一个键，日期并入其值尾段（无独立 IDate）", () => {
  const value = licenseValue(new Date(2026, 8, 3));
  const data = { SLicense: value };
  assert.deepEqual(Object.keys(data), ["SLicense"]);
  assert.equal(value, `${Buffer.from(LICENSE_MARKER, "utf-8").toString("base64")}#0#9/3/2026`);
  // 日期放在第三段之后，读取侧按 '#' 切分取 [2..]
  assert.equal(value.split("#").slice(2).join("#"), "9/3/2026");
});

test("解不出来（空文件 / 非法 hex）时抛错，由调用方按「没有记录」处理", () => {
  assert.deepEqual(decodeLicenseFile(encodeLicenseFile({})), {});
  assert.throws(() => decodeLicenseFile(""));
  assert.throws(() => decodeLicenseFile("zzzz"));
});
