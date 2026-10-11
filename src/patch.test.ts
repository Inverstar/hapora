/**
 * 补丁渲染与注入的单测（不需要 Typora）。
 *
 * 钉住的是「踩错就静默失效」的几条性质：长度回填必须定宽、剥离必须还原成原文、
 * 自校验基准必须等于原始内容的 sha256、许可证值的形状必须符合 `base64#0#M/D/YYYY`。
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  inject, isPatched, licenseValue, loadTemplate, stripPatch, formatDate, LICENSE_MARKER, PATCH_BEGIN, PATCH_END,
} from "./patch.js";

const config = { email: "krkr@xrl.im", licenseCode: "POWER0-ED0000-BY0000-XRL000" };
const ENTRY = "out/launch.dist.js";
const ORIGINAL = '"use strict";\nrequire("./atom.compiled.dist.jsc");\n';

test("剥离注入结果 == 原文（幂等的基础）", () => {
  const { patched } = inject(ENTRY, ORIGINAL, loadTemplate(), config);
  assert.ok(isPatched(patched));
  assert.equal(stripPatch(patched), ORIGINAL);
  assert.equal(isPatched(stripPatch(patched)), false);
});

test("未打补丁的内容 stripPatch 原样返回", () => {
  assert.equal(stripPatch(ORIGINAL), ORIGINAL);
});

test("stripPatch 容忍 CRLF 行尾（Windows 签出的模板 / 历史产物）", () => {
  const crlf = ORIGINAL.replace(/\n/g, "\r\n");
  const injected = inject(ENTRY, crlf, loadTemplate(), config).patched;
  assert.equal(stripPatch(injected), crlf);

  // 补丁块自身也是 CRLF 的情形：从 LF 产物里取出补丁块，整体换成 CRLF 后再拼上 CRLF 原文
  const patchText = injected.slice(injected.indexOf(PATCH_BEGIN), injected.indexOf(PATCH_END) + PATCH_END.length);
  assert.equal(stripPatch(patchText.replace(/\n/g, "\r\n") + "\r\n" + crlf), crlf);
});

test("模板行尾被归一成 LF（注入内容与宿主平台无关）", () => {
  assert.equal(loadTemplate().includes("\r"), false);
});

test("长度回填不改变字节数（8 位定宽占位符）", () => {
  for (const original of [ORIGINAL, ORIGINAL.repeat(50), ""]) {
    const r = inject(ENTRY, original, loadTemplate(), config);
    assert.equal(Buffer.byteLength(r.patched, "utf-8"), r.selfLen);
    assert.equal(Buffer.byteLength(stripPatch(r.patched), "utf-8"), Buffer.byteLength(original, "utf-8"));
  }
});

test("注入后的长度值确实是它自己的字节长度", () => {
  const r = inject(ENTRY, ORIGINAL, loadTemplate(), config);
  const selfLen = Buffer.byteLength(r.patched, "utf-8");
  // 补丁里回填的那个数字必须出现在产物里，且等于实际长度
  assert.ok(r.patched.includes(String(selfLen).padStart(8, "0")));
});

test("自校验基准 = 原始入口内容的 sha256", () => {
  const r = inject(ENTRY, ORIGINAL, loadTemplate(), config);
  const expect = createHash("sha256").update(Buffer.from(ORIGINAL, "utf-8")).digest("hex");
  assert.equal(r.selfSha256, expect);
  // 补丁里带的就是这份基准，客户端算出来的也是它
  assert.ok(r.patched.includes(expect));
});

test("所有占位符都被替换（产物里不留 __HAPORA_*__）", () => {
  const r = inject(ENTRY, ORIGINAL, loadTemplate(), config);
  assert.equal(/__HAPORA_[A-Z_]+__/.test(r.patched), false);
});

test("注入位置在 \"use strict\" 之后、代码之前", () => {
  const r = inject(ENTRY, ORIGINAL, loadTemplate(), config);
  const at = r.patched.indexOf(PATCH_BEGIN);
  assert.ok(at > ORIGINAL.indexOf('"use strict";'), "补丁应落在 use strict 之后");
  assert.ok(r.patched.indexOf('require("./atom.compiled.dist.jsc")') > at);
});

test("没有 use strict 时插到文件最前面", () => {
  const plain = "console.log(1);\n";
  const r = inject(ENTRY, plain, loadTemplate(), config);
  assert.ok(r.patched.startsWith(PATCH_BEGIN));
  assert.equal(stripPatch(r.patched), plain);
});

test("模板含 7 个占位符各一次（占位符契约）", () => {
  // 模板校验在 loadTemplate 里做：这里只确认当前模板能过、且含 7 个占位符各一次
  const t = loadTemplate();
  for (const slot of [
    "__HAPORA_SELF_SHA256__", "__HAPORA_SELF_B64__", "__HAPORA_SELF_LEN__",
    "__HAPORA_ENTRY__", "__HAPORA_MARKER__", "__HAPORA_LICENSE_KEY__", "__HAPORA_EMAIL__",
  ]) {
    assert.equal(t.split(slot).length - 1, 1, `${slot} 必须恰好出现一次`);
  }
});

test("许可证值形状：base64(标记)#0#M/D/YYYY", () => {
  const v = licenseValue(new Date(2026, 8, 3));
  assert.equal(v, `${Buffer.from(LICENSE_MARKER, "utf-8").toString("base64")}#0#9/3/2026`);
  assert.equal(formatDate(new Date(2026, 8, 3)), "9/3/2026");
  assert.equal(formatDate(new Date(2026, 11, 31)), "12/31/2026");
});
