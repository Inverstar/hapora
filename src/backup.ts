/**
 * 备份规划：只根据磁盘状态判断「这次要不要（重新）建备份」，不落盘。
 *
 * 单独成文件（而非留在 hack.ts）的原因：这几条判定是纯读盘的决策，可单测；
 * 而「备份里存的是已打补丁的内容」正是本项目最难排查的坑之一
 * （现象是 --restore 报成功但状态没变），必须有测试钉住。
 *
 * 落盘的动作统一由 hack.ts 的 installFiles 做（与成品同批次、最多一次提权）。
 */

import { existsSync } from "node:fs";

import { readEntry, readMain } from "./asar.js";
import { isPatched } from "./patch.js";
import type { TyporaInstall } from "./platform/types.js";

/** asar 路线的备份状态：新建 / 刷新（重装升级或备份不可用）/ 沿用 */
export type AsarBackupState = "created" | "refreshed" | "kept";

/**
 * [asar 路线] 判断备份该怎么处理：
 *   - 没有备份                    → 建一份（内容取「入口还原成原始」的 app.asar）
 *   - 备份读不出来               → 刷新（备份损坏，不能当作还原来源）
 *   - 备份里的入口已含补丁       → 刷新（备份不可用：还原它等于没还原；真原始内容由 stripPatch 还原）
 *   - 备份记录的是另一个入口     → 刷新（换过版本）
 *   - 当前未被改动却与备份不同   → 刷新（被重装/升级过）
 *   - 其余                        → 沿用（它才是原始内容的来源）
 *
 * 注意：判断的是**备份文件本身**是不是补丁版，而不是当前 app.asar —— 后者已被补丁时
 * 恰恰要「沿用」备份。两者混起来就会出现「备份里存着已补丁内容」的死局。
 */
export function planAsarBackup(install: TyporaInstall): AsarBackupState {
  if (!existsSync(install.backup)) return "created";

  let backedEntry: string;
  let backed: string;
  try {
    backedEntry = readMain(install.backup);
    backed = readEntry(install.backup, backedEntry);
  } catch {
    return "refreshed"; // 备份读不出来 ⇒ 不是可用的还原来源，重建
  }
  if (isPatched(backed)) return "refreshed";

  const currentEntry = readMain(install.target);
  const current = readEntry(install.target, currentEntry);
  if (currentEntry !== backedEntry) return "refreshed";
  if (!isPatched(current) && current !== backed) return "refreshed";
  return "kept";
}

/**
 * [记录路线] macOS 的备份规划：备份对象是许可证记录文件（随用户数据走，与 Typora 版本无关），
 * 因此只有「首次创建」与「沿用已有备份」两种状态——已有备份永远指向最早的原始记录。
 */
export function planRecordBackup(install: TyporaInstall): "created" | "kept" {
  return existsSync(install.backup) ? "kept" : "created";
}
