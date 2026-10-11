/**
 * Mach-O 解析与补丁的单测：用**合成的最小 Mach-O fixture**（thin + fat）跑，
 * 不依赖真机二进制，也不需要 macOS（纯 Buffer 运算）。
 *
 * 钉住的性质：
 *   - 补丁点是**运行时在符号表里定位**出来的，代码里没有任何指令偏移 / vm 地址常量；
 *   - 补丁是**等长替换**（文件长度不变、其它偏移不漂移）；
 *   - 结构意外（太短 / fat_arch_64 / 大端 / 符号缺失 / 同名多地址）一律抛错，绝不猜；
 *   - entitlements 的注入是幂等的、插在最外层 `</dict>` 之前。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  archName, applyPatches, locateSymbols, parseSlices, planRetPatches, readPatchState, retBytesFor,
  withDisableLibraryValidation, MACHO_TARGETS,
} from "./darwin-macho.js";

const CPU_ARM64 = 0x0100000c;
const CPU_X86_64 = 0x01000007;

const VM_BASE = 0x100000000;
const CODE_OFF = 0x1000; // 目标 IMP 在文件里的偏移（由 vm 地址映射得出，不是硬编码常量）
const MH_MAGIC_64 = 0xfeedfacf;

interface SymSpec {
  name: string;
  value: number;
  /** n_sect：0 视为未定义符号（应被跳过） */
  sect?: number;
}

/** 造一个最小的 thin mach_header_64（1 个可执行 __TEXT 段 + LC_SYMTAB + 符号表）。 */
function buildThin(cpuType: number, symbols: SymSpec[]): Buffer {
  const SYM_OFF = CODE_OFF + 0x100;
  // 字符串表：首字节 NUL，其后是去重后的符号名
  const strx = new Map<string, number>();
  let strtab = Buffer.from([0]);
  for (const s of symbols) {
    if (strx.has(s.name)) continue;
    strx.set(s.name, strtab.length);
    strtab = Buffer.concat([strtab, Buffer.from(s.name, "utf-8"), Buffer.from([0])]);
  }
  const STR_OFF = SYM_OFF + symbols.length * 16;
  const total = STR_OFF + strtab.length;

  const buf = Buffer.alloc(total);
  buf.writeUInt32LE(MH_MAGIC_64, 0);
  buf.writeInt32LE(cpuType, 4);
  buf.writeUInt32LE(2, 12); // filetype = MH_EXECUTE
  buf.writeUInt32LE(2, 16); // ncmds
  buf.writeUInt32LE(72 + 24, 20); // sizeofcmds
  // LC_SEGMENT_64 @32
  buf.writeUInt32LE(0x19, 32);
  buf.writeUInt32LE(72, 36);
  buf.write("__TEXT", 40, 16, "latin1");
  buf.writeBigUInt64LE(BigInt(VM_BASE), 56); // vmaddr
  buf.writeBigUInt64LE(BigInt(0x4000), 64); // vmsize
  buf.writeBigUInt64LE(0n, 72); // fileoff
  buf.writeBigUInt64LE(BigInt(total), 80); // filesize
  buf.writeInt32LE(0x7, 88); // maxprot（含 EXECUTE）
  buf.writeInt32LE(0x5, 92); // initprot
  // LC_SYMTAB @104
  buf.writeUInt32LE(0x2, 104);
  buf.writeUInt32LE(24, 108);
  buf.writeUInt32LE(SYM_OFF, 112);
  buf.writeUInt32LE(symbols.length, 116);
  buf.writeUInt32LE(STR_OFF, 120);
  buf.writeUInt32LE(strtab.length, 124);

  // IMP 首指令（8 字节占位，补丁会覆盖开头的 ret 长度个字节）
  Buffer.from([0xff, 0x83, 0x00, 0xd1, 0xfd, 0x7b, 0x01, 0xa9]).copy(buf, CODE_OFF);

  symbols.forEach((s, i) => {
    const p = SYM_OFF + i * 16;
    buf.writeUInt32LE(strx.get(s.name)!, p); // n_strx
    buf.writeUInt8(0x0f, p + 4); // n_type（N_SECT|N_EXT）
    buf.writeUInt8(s.sect ?? 1, p + 5); // n_sect
    buf.writeUInt16LE(0, p + 6); // n_desc
    buf.writeBigUInt64LE(BigInt(s.value), p + 8); // n_value
  });
  strtab.copy(buf, STR_OFF);
  return buf;
}

/** 把若干 thin 切片包成 fat（0xcafebabe）。 */
function buildFat(slices: Array<{ cpuType: number; buf: Buffer }>): Buffer {
  const headerSize = 8 + slices.length * 20;
  const head = Buffer.alloc(headerSize);
  head.writeUInt32BE(0xcafebabe, 0);
  head.writeUInt32BE(slices.length, 4);
  let cursor = 0x1000;
  const offsets: number[] = [];
  slices.forEach((s, i) => {
    offsets.push(cursor);
    head.writeInt32BE(s.cpuType, 8 + i * 20);
    head.writeUInt32BE(cursor, 8 + i * 20 + 8);
    head.writeUInt32BE(s.buf.length, 8 + i * 20 + 12);
    head.writeUInt32BE(12, 8 + i * 20 + 16); // align
    cursor += s.buf.length;
  });
  return Buffer.concat([head, Buffer.alloc(offsets[0]! - headerSize), ...slices.map((s) => s.buf)]);
}

const RENEW = MACHO_TARGETS.renew;
const renewAt = (offset = CODE_OFF, extra = 0): number => offset + extra;

test("parseSlices：thin 视为单切片", () => {
  const slices = parseSlices(buildThin(CPU_ARM64, []));
  assert.equal(slices.length, 1);
  assert.equal(slices[0]!.cpuType, CPU_ARM64);
  assert.equal(slices[0]!.offset, 0);
});

test("parseSlices：fat 解析出全部切片", () => {
  const fat = buildFat([
    { cpuType: CPU_ARM64, buf: buildThin(CPU_ARM64, []) },
    { cpuType: CPU_X86_64, buf: buildThin(CPU_X86_64, []) },
  ]);
  const slices = parseSlices(fat);
  assert.deepEqual(slices.map((s) => s.cpuType), [CPU_ARM64, CPU_X86_64]);
  assert.ok(slices[1]!.offset > slices[0]!.offset);
});

test("parseSlices：结构意外一律抛错（太短 / fat_arch_64 / 大端 / 非 Mach-O）", () => {
  assert.throws(() => parseSlices(Buffer.alloc(8)), /不是 Mach-O/);
  const fat64 = Buffer.alloc(64);
  fat64.writeUInt32BE(0xcafebabf, 0);
  assert.throws(() => parseSlices(fat64), /fat_arch_64/);
  const be = Buffer.alloc(64);
  be.writeUInt32LE(0xcffaedfe, 0); // MH_CIGAM_64：字节交换过
  assert.throws(() => parseSlices(be), /字节交换/);
  assert.throws(() => parseSlices(Buffer.from("MZ....", "latin1")), /不是 Mach-O/);
});

test("locateSymbols：按名字在符号表里定位（偏移现算，不是常量）", () => {
  const buf = buildThin(CPU_ARM64, [
    { name: "_main", value: VM_BASE + 0x800 },
    { name: RENEW, value: VM_BASE + CODE_OFF },
  ]);
  const sites = locateSymbols(buf, [RENEW]);
  assert.equal(sites.length, 1);
  assert.equal(sites[0]!.name, RENEW);
  assert.equal(sites[0]!.cpuType, CPU_ARM64);
  assert.equal(sites[0]!.vmAddr, VM_BASE + CODE_OFF);
  assert.equal(sites[0]!.fileOffset, CODE_OFF);
});

test("locateSymbols：fat 里每个切片都要命中（缺一片即抛错，绝不只补一半）", () => {
  const fat = buildFat([
    { cpuType: CPU_ARM64, buf: buildThin(CPU_ARM64, [{ name: RENEW, value: VM_BASE + CODE_OFF }]) },
    { cpuType: CPU_X86_64, buf: buildThin(CPU_X86_64, []) },
  ]);
  assert.throws(() => locateSymbols(fat, [RENEW]), /缺少/);

  const fat2 = buildFat([
    { cpuType: CPU_ARM64, buf: buildThin(CPU_ARM64, [{ name: RENEW, value: VM_BASE + CODE_OFF }]) },
    { cpuType: CPU_X86_64, buf: buildThin(CPU_X86_64, [{ name: RENEW, value: VM_BASE + CODE_OFF }]) },
  ]);
  const sites = locateSymbols(fat2, [RENEW]);
  assert.equal(sites.length, 2);
  assert.deepEqual(sites.map((s) => s.cpuType), [CPU_ARM64, CPU_X86_64]);
  // 第二个切片的偏移必须跟着 fat 的布局走（现算），而不是沿用第一个
  assert.ok(sites[1]!.fileOffset > sites[0]!.fileOffset);
});

test("locateSymbols：未定义符号（n_sect=0 / n_value=0）不计入命中", () => {
  const buf = buildThin(CPU_ARM64, [{ name: RENEW, value: 0, sect: 0 }]);
  assert.throws(() => locateSymbols(buf, [RENEW]), /缺少/);
});

test("locateSymbols：同地址的别名表目放行，不同地址的真歧义抛错", () => {
  const alias = buildThin(CPU_ARM64, [
    { name: RENEW, value: VM_BASE + CODE_OFF },
    { name: RENEW, value: VM_BASE + CODE_OFF },
  ]);
  assert.equal(locateSymbols(alias, [RENEW]).length, 1);

  const ambiguous = buildThin(CPU_ARM64, [
    { name: RENEW, value: VM_BASE + CODE_OFF },
    { name: RENEW, value: VM_BASE + CODE_OFF + 0x40 },
  ]);
  assert.throws(() => locateSymbols(ambiguous, [RENEW]), /歧义/);
});

test("retBytesFor：arm64 四字节、x86_64 一字节，未实证的架构抛错", () => {
  assert.deepEqual([...retBytesFor(CPU_ARM64)], [0xc0, 0x03, 0x5f, 0xd6]);
  assert.deepEqual([...retBytesFor(CPU_X86_64)], [0xc3]);
  assert.throws(() => retBytesFor(0x01000002), /未实证/);
  assert.equal(archName(CPU_ARM64), "arm64");
  assert.equal(archName(CPU_X86_64), "x86_64");
});

test("补丁是等长替换：长度不变，且只动 IMP 首指令", () => {
  for (const cpu of [CPU_ARM64, CPU_X86_64]) {
    const buf = buildThin(cpu, [{ name: RENEW, value: VM_BASE + CODE_OFF }]);
    const ops = planRetPatches(buf, [RENEW]);
    assert.equal(ops.length, 1);
    assert.equal(ops[0]!.patch.length, ops[0]!.current.length);
    assert.equal(readPatchState(buf, [RENEW])[0]!.patched, false);

    const out = applyPatches(buf, ops);
    assert.equal(out.length, buf.length, "补丁不得改变文件长度");
    assert.equal(readPatchState(out, [RENEW])[0]!.patched, true);
    // 首指令被换成 ret，其后内容原样保留
    assert.deepEqual(
      [...out.subarray(CODE_OFF + ops[0]!.patch.length, CODE_OFF + 8)],
      [...buf.subarray(CODE_OFF + ops[0]!.patch.length, CODE_OFF + 8)],
    );
    // 入参不被修改（纯函数）
    assert.equal(readPatchState(buf, [RENEW])[0]!.patched, false);
  }
});

test("已补丁的二进制：readPatchState 判已补丁（幂等判定的依据）", () => {
  const buf = buildThin(CPU_ARM64, [{ name: RENEW, value: VM_BASE + CODE_OFF }]);
  const out = applyPatches(buf, planRetPatches(buf, [RENEW]));
  const ops = planRetPatches(out, [RENEW]);
  assert.ok(ops[0]!.current.equals(ops[0]!.patch));
  assert.equal(ops[0]!.site.fileOffset, renewAt());
});

test("withDisableLibraryValidation：插在最外层 </dict> 之前且幂等", () => {
  const xml =
    '<?xml version="1.0"?>\n<plist version="1.0"><dict>\n' +
    "<key>com.apple.security.app-sandbox</key><true/>\n" +
    "<key>nested</key><dict><key>a</key><true/></dict>\n" +
    "</dict>\n</plist>\n";
  const once = withDisableLibraryValidation(xml);
  assert.ok(once.includes("<key>com.apple.security.cs.disable-library-validation</key><true/>"));
  // 插在最外层（最后一个）</dict> 之前
  assert.ok(once.indexOf("disable-library-validation") < once.lastIndexOf("</dict>"));
  assert.equal(withDisableLibraryValidation(once), once, "重复调用必须幂等");
  assert.throws(() => withDisableLibraryValidation("<plist></plist>"), /没有 <\/dict>/);
});
