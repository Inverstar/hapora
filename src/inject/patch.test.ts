/**
 * 注入源码（patch.js）里 `fingerprint()` 的单测。
 *
 * 这条公式是本项目最容易踩的坑之一：末尾那次 `.replace(/[/=+-]/g, "a")` 漏掉时，
 * base64 里含 `/ + = -` 的机器（约一半）会因指纹对不上而拒绝伪造载荷，
 * 现象是「装了补丁但没激活」且**没有任何报错**。
 *
 * patch.js 不是模块（它要原样注入 Typora），所以这里把它的两个纯函数从源码里按花括号
 * 配平抽出来，喂一个假 `require` 跑——测的仍是磁盘上那份源码，不会出现「测试与实现漂移」。
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as crypto from "node:crypto";
import { test } from "node:test";

const SRC = readFileSync(new URL("./patch.js", import.meta.url), "utf-8");

/** 从 source 里按花括号配平切出 `function name(...) {...}`。 */
function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`patch.js 里找不到函数 ${name}`);
  let depth = 0;
  let end = -1;
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end < 0) throw new Error(`函数 ${name} 的花括号不配平`);
  return source.slice(start, end + 1);
}

/** 假 require：machineId 会依次试 native-reg（无）→ reg.exe（无）→ /etc/machine-id（命中）。 */
function fakeRequire(machineId: string) {
  return (id: string): unknown => {
    if (id === "fs") {
      return {
        readFileSync: (p: string) => {
          if (p === "/etc/machine-id") return `${machineId}\n`;
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        },
      };
    }
    if (id === "child_process") {
      return { execSync: () => { throw new Error("reg.exe unavailable"); } };
    }
    throw new Error(`module not found: ${id}`);
  };
}

function fingerprintOf(machineId: string): string {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function(
    "require",
    "crypto",
    `${extractFunction(SRC, "machineId")}\n${extractFunction(SRC, "fingerprint")}\nreturn fingerprint();`,
  ) as (req: unknown, c: unknown) => string;
  return factory(fakeRequire(machineId), crypto);
}

const expectOf = (machineId: string): string =>
  createHash("sha256").update(machineId + "typora").digest("base64").slice(0, 10).replace(/[/=+-]/g, "a");

test("fingerprint = Base64(SHA256(machineId + \"typora\"))[0..10] 且末尾替换到位", () => {
  for (const mid of ["", "a1b2c3d4-0000-1111-2222-333344445555", "7f9c2b1e-4d4a-4f0e-9a11-2c3d4e5f6a7b"]) {
    assert.equal(fingerprintOf(mid), expectOf(mid));
    assert.equal(fingerprintOf(mid).length, 10);
    assert.equal(/[/=+-]/.test(fingerprintOf(mid)), false);
  }
});

test("末尾那次 replace 不可省：raw 含 /+= 时结果必须与之不同且已净化", () => {
  // 找一个 raw 片段里确实含特殊字符的 machine-id（真实机器上约一半会命中）。
  // 注意 machine-id 必须够长（实现里要求 ≥32 字符，否则回退成空串）。
  let hit = "";
  for (let i = 0; i < 5000 && !hit; i++) {
    const mid = i.toString(16).padStart(32, "0");
    const raw = createHash("sha256").update(mid + "typora").digest("base64").slice(0, 10);
    if (/[/=+-]/.test(raw)) hit = mid;
  }
  assert.ok(hit, "没能在 5000 次里撞出含特殊字符的 base64 片段（公式可能变了）");

  const fp = fingerprintOf(hit);
  const raw = createHash("sha256").update(hit + "typora").digest("base64").slice(0, 10);
  assert.notEqual(fp, raw, "少了末尾替换 ⇒ 指纹带着 /+= 出去，客户端比对不上");
  assert.equal(fp, raw.replace(/[/=+-]/g, "a"));
  assert.equal(fp.length, raw.length, "替换是等长的（1:1）");
});
