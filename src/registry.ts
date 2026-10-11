/**
 * Windows 注册表访问。
 *
 * 写入只发生在 HKCU\SOFTWARE\Typora（用户级，永不需要提权）；
 * 读取额外提供两个通用查询（queryValue / queryTree），供 typora.ts 定位安装目录时
 * 读取任意键（App Paths、文件关联、卸载表），这些读取只读、不改动任何东西。
 *
 * 使用 execFile 直接调用 reg.exe，不经过 shell，避免 `#`、`=`、`+`、`/`
 * 这类出现在 SLicense 里的字符被 shell 解析。
 */

import { execFileSync } from "node:child_process";

export const REG_PATH = "HKCU\\SOFTWARE\\Typora";

function reg(args: string[], quiet = false): string {
  return execFileSync("reg", args, {
    encoding: "utf-8",
    windowsHide: true,
    // quiet：查询不存在的键是常态，不能让 reg.exe 的报错漏到用户终端上
    stdio: quiet ? ["ignore", "pipe", "ignore"] : ["ignore", "pipe", "pipe"],
  });
}

/**
 * 读取任意注册表键下的一个值。valueName 为 null 时取该键的默认值。
 * 键或值不存在（或输出无法解析）一律返回 null，不抛错。
 *
 * 注意：默认值的标签在中文 Windows 上是「(默认)」而不是「(Default)」，
 * 所以这里只按 `REG_类型` 取值，不依赖标签文案。
 */
export function queryValue(keyPath: string, valueName: string | null = null): string | null {
  const args =
    valueName === null ? ["query", keyPath, "/ve"] : ["query", keyPath, "/v", valueName];
  try {
    const out = reg(args, true);
    const re = /^\s+(.*?)\s+REG_\w+\s+(.*)$/;
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(re);
      if (m && (valueName === null || m[1] === valueName)) return m[2].trim();
    }
    return null;
  } catch {
    return null;
  }
}

/** 递归查询整棵键树（reg query KEY /s）的原始输出，交给调用方自行解析。失败返回空串。 */
export function queryTree(keyPath: string): string {
  try {
    return reg(["query", keyPath, "/s"], true);
  } catch {
    return "";
  }
}

export function read(key: string): string | null {
  try {
    const out = reg(["query", REG_PATH, "/v", key], true);
    const m = out.match(new RegExp(`${key}\\s+REG_\\w+\\s+(.*)`));
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

/** 「这一条通道是不是被策略挡住」——EPERM/EACCES（拦截）/ENOENT（程序不在 PATH 上）。 */
function isChannelBlocked(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === "EPERM" || code === "EACCES" || code === "ENOENT";
}

/** PowerShell 单引号包裹（内部单引号翻倍）。 */
function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * 回退通道：`reg.exe` 在受限环境（沙箱 / AppLocker / 程序黑名单）下会直接 EPERM，
 * 此时换 PowerShell 的 `New-ItemProperty` 走同一件事（HKCU 是用户级，不需要提权）。
 */
function powershellWrite(key: string, value: string): Error | null {
  const psPath = psQuote(REG_PATH);
  const script =
    `$p = ${psPath}; ` +
    `if (-not (Test-Path $p)) { New-Item -Path $p -Force | Out-Null }; ` +
    `New-ItemProperty -Path $p -Name ${psQuote(key)} -Value ${psQuote(value)} -PropertyType String -Force | Out-Null`;
  try {
    execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf-8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return null;
  } catch (err) {
    return err as Error;
  }
}

/** 两条通道都失败时，把「被策略拦截」与「键不可写」分开说，而不是抛裸的 spawnSync 错误。 */
function writeFailure(key: string, regErr: unknown, psErr: Error): Error {
  const cause = isChannelBlocked(regErr) && isChannelBlocked(psErr)
    ? "reg.exe 与 PowerShell 两条通道都被拒绝（多见于沙箱 / AppLocker / 程序黑名单）"
    : `注册表键不可写（${REG_PATH} 被策略锁定或值被占用）`;
  const one = (e: unknown): string => String((e as Error)?.message ?? e).split("\n")[0]?.trim() ?? "";
  return new Error(
    `写入注册表值 ${key} 失败：${cause}。\n` +
    `  reg.exe：${one(regErr)}\n` +
    `  PowerShell：${one(psErr)}`,
  );
}

export function write(key: string, value: string, type = "REG_SZ"): void {
  try {
    reg(["add", REG_PATH, "/v", key, "/t", type, "/d", value, "/f"]);
    return;
  } catch (regErr) {
    const psErr = powershellWrite(key, value);
    if (!psErr) return;
    throw writeFailure(key, regErr, psErr);
  }
}
