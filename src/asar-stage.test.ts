/**
 * asar 打包步骤的单测（真实 asar 包 + 临时目录，不碰本机 Typora）。
 *
 * 核心断言只有一条：**备份源必须是「入口已还原成原始内容」的包**。
 * 当「备份缺失 + 当前 app.asar 已含补丁」时，裸拷当前包会把补丁版存成备份，
 * `pnpm hack --restore` 就成了「报成功但状态没变」——这类失败没有任何报错，必须由测试钉住。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { pack, readEntry, readMain } from "./asar.js";
import { stageAsarPatch } from "./asar-stage.js";
import { inject, isPatched, loadTemplate, stripPatch } from "./patch.js";

const ENTRY = "out/main.js";
const ORIGINAL = '"use strict";\nconsole.log("typora");\n';
const CONFIG = { email: "krkr@xrl.im", licenseCode: "POWER0-ED0000-BY0000-XRL000" };

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "hapora-stage-test-"));
}

async function makeAsar(dir: string, tag: string, content: string, entryName = ENTRY): Promise<string> {
  const src = join(dir, `src-${tag}`);
  mkdirSync(join(src, "out"), { recursive: true });
  writeFileSync(join(src, "package.json"), JSON.stringify({ name: "typora", version: "0.0.0-test", main: entryName }));
  writeFileSync(join(src, entryName), content);
  const out = join(dir, `${tag}.asar`);
  await pack(src, out);
  return out;
}

const entryOf = (asarPath: string): string => readEntry(asarPath, readMain(asarPath));

test("未补丁源：成品含补丁、备份源是原文，剥离成品 == 备份源", async () => {
  const dir = tmpDir();
  try {
    const source = await makeAsar(dir, "source", ORIGINAL);
    const work = join(dir, "work");
    mkdirSync(work);
    const r = await stageAsarPatch({ source, work, backupNeeded: true, template: loadTemplate(), config: CONFIG });

    assert.ok(r.pristine, "backupNeeded=true 必须产出备份源");
    assert.equal(r.entryName, ENTRY);
    assert.equal(entryOf(r.pristine!), ORIGINAL);
    assert.equal(isPatched(entryOf(r.pristine!)), false);
    assert.equal(isPatched(entryOf(r.staged)), true);
    assert.equal(stripPatch(entryOf(r.staged)), ORIGINAL);
    assert.equal(r.originalBytes, Buffer.byteLength(ORIGINAL, "utf-8"));
    assert.equal(Buffer.byteLength(entryOf(r.staged), "utf-8"), r.selfLen);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("已补丁源（备份缺失的场景）：备份源仍必须是原文", async () => {
  const dir = tmpDir();
  try {
    const patched = inject(ENTRY, ORIGINAL, loadTemplate(), CONFIG).patched;
    const source = await makeAsar(dir, "source", patched);
    assert.equal(isPatched(entryOf(source)), true, "前置条件：源包已含补丁");

    const work = join(dir, "work");
    mkdirSync(work);
    const r = await stageAsarPatch({ source, work, backupNeeded: true, template: loadTemplate(), config: CONFIG });

    assert.equal(entryOf(r.pristine!), ORIGINAL, "备份源必须剥离补丁，否则 --restore 是假成功");
    assert.equal(isPatched(entryOf(r.pristine!)), false);
    assert.equal(isPatched(entryOf(r.staged)), true);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("backupNeeded=false：不产出备份源（沿用已有原始备份）", async () => {
  const dir = tmpDir();
  try {
    const source = await makeAsar(dir, "source", ORIGINAL);
    const work = join(dir, "work");
    mkdirSync(work);
    const r = await stageAsarPatch({ source, work, backupNeeded: false, template: loadTemplate(), config: CONFIG });
    assert.equal(r.pristine, null);
    assert.equal(isPatched(entryOf(r.staged)), true);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("包内没有可用的 main：显式报错，不产出坏包", async () => {
  const dir = tmpDir();
  try {
    const src = join(dir, "src-bad");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "package.json"), JSON.stringify({ name: "typora" }));
    const source = join(dir, "bad.asar");
    await pack(src, source);
    const work = join(dir, "work");
    mkdirSync(work);
    await assert.rejects(
      () => stageAsarPatch({ source, work, backupNeeded: true, template: loadTemplate(), config: CONFIG }),
      /main/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});
