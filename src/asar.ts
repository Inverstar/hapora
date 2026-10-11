/**
 * app.asar 的解包 / 打包 / 读取单文件。
 *
 * 不对包内文件名做任何假设——入口名一律从包内 package.json 的 main 字段读出来。
 */

import { extractAll, createPackage, extractFile } from "@electron/asar";
import { closeSync, fsyncSync, mkdirSync, openSync, rmSync } from "node:fs";

export const PACKAGE_JSON = "package.json";

/** `createPackage` 实际 resolve 出来的那个写流（只用到「等它收尾」这几个成员）。 */
interface MaybeWriteStream {
  closed?: boolean;
  destroyed?: boolean;
  once(event: "close", listener: () => void): unknown;
  once(event: "error", listener: (err: Error) => void): unknown;
}

const STREAM_TIMEOUT_MS = 30_000;

/**
 * 等打包写流真正收尾。
 *
 * 为什么必须有：`@electron/asar` 的 `createPackage` **不等写流关闭就 resolve** ——
 * `lib/disk.js` 的 `writeFilesystem` 最后一句是 `return out.end()`，返回的是 `WriteStream`
 * 而不是 promise，于是 `await createPackage(...)` 拿到的其实是那个还在刷盘的流。
 * 后果：紧接着读取刚打好的包，会读到「文件大小已到位、内容还是零页」的中间态。
 * 实测表现是紧随 `pack()` 的 `readMain()` 抛
 * `Unexpected token '\x00', "\x00\x00…" is not valid JSON`（约每 3 次全套测试出现 1 次）；
 * 生产路径上更糟：`installFiles()` 可能把**未写完的成品**拷进安装目录。
 * 上游若改变返回值形态（不再是流），这里退化为 no-op，不会更差。
 */
async function waitForStreamEnd(out: unknown, asarPath: string): Promise<void> {
  const stream = out as MaybeWriteStream | null | undefined;
  if (!stream || typeof stream.once !== "function") return;
  if (stream.closed || stream.destroyed) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`打包写流未在 ${STREAM_TIMEOUT_MS / 1000}s 内关闭：${asarPath}`)),
      STREAM_TIMEOUT_MS,
    );
    stream.once("close", () => { clearTimeout(timer); resolve(); });
    stream.once("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

/** 把刚写出的文件刷到盘上（写流关闭只保证数据进了缓存，这一步保证它落到设备）。 */
function syncToDisk(path: string): void {
  const fd = openSync(path, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export async function unpack(asarPath: string, destDir: string): Promise<void> {
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  await extractAll(asarPath, destDir);
}

export async function pack(srcDir: string, asarPath: string): Promise<void> {
  rmSync(asarPath, { force: true });
  await waitForStreamEnd(await createPackage(srcDir, asarPath), asarPath);
  syncToDisk(asarPath);
}

export function readEntry(asarPath: string, entry: string): string {
  return extractFile(asarPath, entry).toString("utf-8");
}

/**
 * 从包内 package.json 读出入口文件名。
 * Typora 的自校验也是先读它、再读 main 指向的文件，所以这里必须用同一个来源。
 */
export function readMain(asarPath: string): string {
  const pkg = JSON.parse(extractFile(asarPath, PACKAGE_JSON).toString("utf-8")) as { main?: string };
  if (!pkg.main || typeof pkg.main !== "string") {
    throw new Error(`app.asar 的 package.json 里没有可用的 main 字段`);
  }
  return pkg.main;
}
