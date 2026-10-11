/**
 * 诊断日志（`--verbose`）。
 *
 * 目的：失败时给用户一个可交付的载体，而不是一句「请把信息提供给维护者」。
 * 默认完全静默（不写文件、不打印）；只有带 `--verbose` 时才收集，且只在
 * **失败路径**落盘到仓库内的 `hapora-debug.log`（不入库，见 .gitignore）。
 *
 * 收集内容：平台、安装目录、入口名、自校验基准 sha256、备份状态、验收期间每次探针结果，
 * 以及失败时 Typora 日志（或记录文件）的末尾片段。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { repoRoot } from "./config.js";

export const DEBUG_LOG_NAME = "hapora-debug.log";

let verbose = false;
const lines: string[] = [];

/** 打开诊断收集（CLI 的 `--verbose`）。 */
export function setVerbose(on: boolean): void {
  verbose = on;
}

export function isVerbose(): boolean {
  return verbose;
}

/** 记一行；未开启 --verbose 时是 no-op（调用点不必自己判断）。 */
export function diag(msg: string): void {
  if (!verbose) return;
  lines.push(`[${new Date().toISOString()}] ${msg}`);
}

/** 把某个文件的末尾若干行纳入诊断（读不到就记一句读不到）。 */
export function diagTail(label: string, filePath: string, maxLines = 40): void {
  if (!verbose) return;
  if (!existsSync(filePath)) {
    diag(`${label}：文件不存在（${filePath}）`);
    return;
  }
  try {
    const tail = readFileSync(filePath, "utf-8").split(/\r?\n/).slice(-maxLines);
    diag(`${label}（末尾 ${tail.length} 行，${filePath}）：`);
    for (const line of tail) lines.push(`    ${line}`);
  } catch (err) {
    diag(`${label}：读取失败（${(err as Error).message}）`);
  }
}

/** 诊断日志的落盘路径（仓库根目录）。 */
export function debugLogPath(): string {
  return join(repoRoot(), DEBUG_LOG_NAME);
}

/**
 * 把收集到的诊断写到 `hapora-debug.log`，返回路径；没有内容或没开 --verbose 时返回 null。
 * 只在失败路径调用 —— 成功时不留下这个文件。
 */
export function flushDiagnostics(reason: string): string | null {
  if (!verbose || lines.length === 0) return null;
  const path = debugLogPath();
  const body = [`hapora 诊断日志`, `失败原因：${reason}`, "", ...lines, ""].join("\n");
  writeFileSync(path, body, "utf-8");
  return path;
}
