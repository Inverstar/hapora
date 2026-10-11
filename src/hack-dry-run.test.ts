/**
 * `pnpm hack --dry-run` 的端到端测试：用临时目录里伪造的「Typora 安装」跑真实的 CLI。
 *
 * 这一条钉住的是**契约**而不是文案：dry-run 必须在把包解开、注入、重新打包之后停下，
 * 打印将要写入什么，并且**一个字节都不写**（不改 app.asar、不建备份、不写许可证、不启动 Typora）。
 * 同时也验证了「--dir 指向的目录里只要有 resources/app.asar 就能被定位」这条前提。
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { pack } from "./asar.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(import.meta.url);
/** tsx 的 CLI（bin: ./dist/cli.mjs）：用当前 node 跑它，跨平台一致。 */
const TSX_CLI = join(dirname(require_.resolve("tsx/package.json")), "dist", "cli.mjs");

const ENTRY = "out/main.js";
const ORIGINAL = '"use strict";\nconsole.log("typora");\n';

const sha256 = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");

/** 造一个「长得像 Typora 安装」的目录：<root>/resources/app.asar。 */
async function fakeTyporaInstall(dir: string): Promise<{ root: string; asar: string }> {
  const src = join(dir, "pkg");
  mkdirSync(join(src, "out"), { recursive: true });
  writeFileSync(join(src, "package.json"), JSON.stringify({ name: "typora", version: "0.0.0-test", main: ENTRY }));
  writeFileSync(join(src, ENTRY), ORIGINAL);

  const root = join(dir, "Typora");
  mkdirSync(join(root, "resources"), { recursive: true });
  const asar = join(root, "resources", "app.asar");
  await pack(src, asar);
  return { root, asar };
}

interface RunResult {
  spawned: boolean;
  status: number | null;
  out: string;
  spawnError?: string;
}

function runHack(args: string[]): RunResult {
  const r = spawnSync(process.execPath, [TSX_CLI, "src/hack.ts", ...args], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    windowsHide: true,
  });
  return {
    spawned: !r.error,
    status: r.status,
    out: `${r.stdout ?? ""}${r.stderr ?? ""}`,
    spawnError: r.error?.message,
  };
}

test("--dry-run：打印计划、退出码 0，且不改 app.asar、不建备份", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hapora-dryrun-"));
  try {
    const { root, asar } = await fakeTyporaInstall(dir);
    const before = sha256(asar);

    const { spawned, status, out, spawnError } = runHack(["--dry-run", "--dir", root]);
    if (!spawned) {
      // 受限执行环境里连子进程都起不来（实测 spawnSync node.exe EBUSY）。
      // 这类环境（沙箱 / 杀软拦截）无法做端到端验证，但 CI 上可以，故只跳过不掩盖。
      t.skip(`本环境无法启动子进程：${spawnError}`);
      return;
    }
    assert.equal(status, 0, `退出码应为 0；输出：\n${out}`);
    assert.match(out, /dry-run/);
    assert.match(out, new RegExp(ENTRY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(out, /自校验基准/);
    assert.match(out, /未执行：落盘/);

    assert.equal(sha256(asar), before, "dry-run 不得改写 app.asar");
    assert.equal(existsSync(`${asar}.hapora-orig.bak`), false, "dry-run 不得创建备份");
    assert.equal(existsSync(join(root, "resources", "app.asar.hapora-write-test")), false, "写入探测必须清理干净");
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("--dry-run 也遵守「--dir 无效即报错、不回退自动探测」", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hapora-dryrun-bad-"));
  try {
    const { spawned, status, out, spawnError } = runHack(["--dry-run", "--dir", dir]);
    if (!spawned) {
      t.skip(`本环境无法启动子进程：${spawnError}`);
      return;
    }
    assert.notEqual(status, 0);
    assert.match(out, /没有 resources\\app\.asar|app\.asar/);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});
