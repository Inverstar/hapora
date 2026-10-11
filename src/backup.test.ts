/**
 * 备份规划的单测（用真实 asar 包在临时目录里跑，不动本机 Typora）。
 *
 * 钉住的是一类「回滚假装成功」的坑：备份里如果存的是已打补丁的内容，
 * `pnpm hack --restore` 会报成功但状态根本没变（无报错、极难排查）。
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { pack } from "./asar.js";
import { planAsarBackup, planRecordBackup } from "./backup.js";
import { inject, loadTemplate } from "./patch.js";
import type { TyporaInstall } from "./platform/types.js";

const ENTRY = "out/main.js";
const ORIGINAL = '"use strict";\nconsole.log("typora");\n';
const CONFIG = { email: "krkr@xrl.im", licenseCode: "POWER0-ED0000-BY0000-XRL000" };

const PATCHED = inject(ENTRY, ORIGINAL, loadTemplate(), CONFIG).patched;

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "hapora-backup-test-"));
}

/** 造一个 asar：包内 package.json 的 main 指向 entryName，内容是 content。 */
async function makeAsar(dir: string, tag: string, content: string, entryName = ENTRY): Promise<string> {
  const src = join(dir, `src-${tag}`);
  mkdirSync(join(src, "out"), { recursive: true });
  writeFileSync(join(src, "package.json"), JSON.stringify({ main: entryName }));
  writeFileSync(join(src, entryName), content);
  const out = join(dir, `${tag}.asar`);
  await pack(src, out);
  return out;
}

function installWith(target: string, backup: string): TyporaInstall {
  return { dir: "unused", target, backup, exe: "unused" };
}

test("没有备份 → created", async () => {
  const dir = tmpDir();
  try {
    const target = await makeAsar(dir, "target", ORIGINAL);
    assert.equal(planAsarBackup(installWith(target, target + ".bak")), "created");
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("备份与当前一致、都未补丁 → kept", async () => {
  const dir = tmpDir();
  try {
    const target = await makeAsar(dir, "target", ORIGINAL);
    const backup = await makeAsar(dir, "backup", ORIGINAL);
    assert.equal(planAsarBackup(installWith(target, backup)), "kept");
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("备份未补丁、当前已补丁 → kept（旧备份才是原始内容的来源）", async () => {
  const dir = tmpDir();
  try {
    const target = await makeAsar(dir, "target", PATCHED);
    const backup = await makeAsar(dir, "backup", ORIGINAL);
    assert.equal(planAsarBackup(installWith(target, backup)), "kept");
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("备份里存的就是补丁版 → refreshed（还原它等于没还原）", async () => {
  const dir = tmpDir();
  try {
    const target = await makeAsar(dir, "target", PATCHED);
    const backup = await makeAsar(dir, "backup", PATCHED);
    assert.equal(planAsarBackup(installWith(target, backup)), "refreshed");
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("备份记录的是另一个入口（换过版本）→ refreshed", async () => {
  const dir = tmpDir();
  try {
    const target = await makeAsar(dir, "target", ORIGINAL, "out/new.js");
    const backup = await makeAsar(dir, "backup", ORIGINAL, "out/old.js");
    assert.equal(planAsarBackup(installWith(target, backup)), "refreshed");
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("两者都未补丁但内容不同（被重装/升级）→ refreshed", async () => {
  const dir = tmpDir();
  try {
    const target = await makeAsar(dir, "target", `${ORIGINAL}\n// v2\n`);
    const backup = await makeAsar(dir, "backup", ORIGINAL);
    assert.equal(planAsarBackup(installWith(target, backup)), "refreshed");
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("备份文件根本不是 asar（损坏）→ refreshed", async () => {
  const dir = tmpDir();
  try {
    const target = await makeAsar(dir, "target", ORIGINAL);
    const backup = join(dir, "broken.bak");
    writeFileSync(backup, "not an asar at all");
    assert.equal(planAsarBackup(installWith(target, backup)), "refreshed");
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("记录路线：存在即 kept，不存在即 created", async () => {
  const dir = tmpDir();
  try {
    const target = await makeAsar(dir, "target", ORIGINAL);
    assert.equal(planRecordBackup(installWith(target, target + ".bak")), "created");
    const backup = await makeAsar(dir, "backup", ORIGINAL);
    assert.equal(planRecordBackup(installWith(target, backup)), "kept");
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});
