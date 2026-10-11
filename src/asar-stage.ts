/**
 * asar 路线的「打包」步骤（平台无关，纯文件操作，可在临时目录里单测）。
 *
 * 从 hack.ts 抽出来的原因：这一步藏着本项目最容易静默出错的两件事——
 *   1. 备份源必须是「入口已还原成原始内容」的包，不能裸拷当前 app.asar
 *      （当前包可能已含补丁 ⇒ 备份里存的是补丁版 ⇒ `--restore` 变成假成功）；
 *   2. 入口名只能来自包内 `package.json` 的 `main`，不得硬编码。
 *
 * 只解一次包、打两次：先打「入口已还原」的 pristine（备份源），再打注入后的成品。
 */

import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { pack, readEntry, readMain, unpack } from "./asar.js";
import { inject, isPatched, stripPatch } from "./patch.js";

export interface StagedAsar {
  /** 注入后的成品 app.asar（在 work 目录里） */
  staged: string;
  /** 备份源：入口已还原成原始内容的 app.asar；backupNeeded=false 时为 null */
  pristine: string | null;
  /** 包内 `package.json` 的 `main` */
  entryName: string;
  /** 原始入口内容的 sha256（补丁内嵌的自校验基准） */
  selfSha256: string;
  /** 注入后入口文件的字节长度 */
  selfLen: number;
  /** 原始入口的字节数（输出用） */
  originalBytes: number;
}

/** 防御性断言：备份内容绝不能是已补丁版本（否则 --restore 是「假成功」）。 */
function assertUnpatched(asarPath: string, label: string): void {
  const entry = readMain(asarPath);
  if (isPatched(readEntry(asarPath, entry))) {
    throw new Error(`${label}内容（${basename(asarPath)}）仍是已补丁版本，拒绝继续`);
  }
}

/**
 * 把 source（当前 app.asar，或已有的原始备份）加工成「成品」与（可选）「备份源」。
 *
 * @param source        读原始入口内容的来源；backupNeeded 为 true 时应当传当前 app.asar
 * @param backupNeeded  false 表示已有可用的原始备份，不必产出备份源（省一次打包）
 */
export async function stageAsarPatch(opts: {
  source: string;
  work: string;
  backupNeeded: boolean;
  template: string;
  config: { email: string; licenseCode: string };
}): Promise<StagedAsar> {
  const entryName = readMain(opts.source);
  const original = stripPatch(readEntry(opts.source, entryName));
  if (isPatched(original)) throw new Error("剥离一次补丁后入口仍含补丁，请先回滚");

  const result = inject(entryName, original, opts.template, opts.config);

  const unpacked = join(opts.work, "unpacked");
  const entryPath = join(unpacked, entryName);
  await unpack(opts.source, unpacked);

  let pristine: string | null = null;
  if (opts.backupNeeded) {
    // 备份源 = 入口还原成原始内容后再打包（不是裸拷 source）
    writeFileSync(entryPath, original);
    pristine = join(opts.work, "pristine.asar");
    await pack(unpacked, pristine);
    assertUnpatched(pristine, "备份");
  }

  writeFileSync(entryPath, result.patched);
  const staged = join(opts.work, "app.asar");
  await pack(unpacked, staged);

  return {
    staged,
    pristine,
    entryName,
    selfSha256: result.selfSha256,
    selfLen: result.selfLen,
    originalBytes: Buffer.byteLength(original, "utf-8"),
  };
}
