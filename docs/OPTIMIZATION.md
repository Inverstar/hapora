# 优化清单

2026-10-11 对 `src/` 全量通读后的评审结论与待办。只记录**具体可执行的改动**：问题、代码位置、
复现路径、修法、验收判据。已完成验收的部分不在此列。

> **状态（2026-10-12，`develop` 分支）**：P1-1、P1-2、P2-1、P2-2、P2-3、P3-1、P3-2、P3-3、
> P3-4 **均已落地**；§5「可选增强」已收口——`--dry-run` 落地，另两条经复核**不采纳**（理由见 §5）；
> §6「明确不做」保持不变。`pnpm typecheck` 干净，`pnpm test` 55 项（本地受限环境里 2 项端到端
> 用例 skip，CI 上全跑）。
> 真机验收仍按 AGENTS.md 由人在本机执行（Windows/Linux：`pnpm hack --yes` 看日志关键字；
> macOS：探针 + `lastTry` 金丝雀）——这一条无法自动化，不要假装能。

代码规模参考：`src/` 约 3500 行（其中 `platform/darwin-macho.ts` 611、`hack.ts` 约 430、
`platform/darwin-license.ts` 494、`platform/windows.ts` 349、`inject/patch.js` 300）。
`pnpm typecheck` / `pnpm test` 均干净通过。

## 0. 清单总览

| 优先级 | 问题 | 位置 | 工作量 | 状态 |
|---|---|---|---|---|
| **P1-1** | 写许可证失败后不回滚，留下「补丁已生效、许可证缺失」的半成品 | `src/hack.ts:236-292`、`403-406` | 小 | ✅ 已完成 |
| **P1-2** | 备份源是 `install.target` 原样拷贝，特定情形下备份里存的是已打补丁的 asar | `src/hack.ts:218`、`237` | 小 | ✅ 已完成 |
| P2-1 | 更新拦截只覆盖 `electron.net.request` | `src/inject/patch.js:213-241` | 中 | ✅ 已完成 |
| P2-2 | 自校验放行只覆盖 3 个 fs API + 单次 `update()` | `src/inject/patch.js:107-161` | 中 | ✅ 已完成 |
| P2-3 | Windows 许可证写入只有 `reg.exe` 一条路，无回退 | `src/platform/windows.ts:321-328` | 小 | ✅ 已完成 |
| P3-1 | 零自动化测试 | 全项目 | 中 | ✅ 已完成（49 项） |
| P3-2 | 无 `typecheck` 脚本、无 CI、无 `engines` | `package.json` | 小 | ✅ 已完成 |
| P3-3 | 失败时无可交付的诊断信息 | `src/hack.ts:333` | 小 | ✅ 已完成（`--verbose`） |
| P3-4 | README 缺「装了补丁但没激活」排查段 | `README.md` | 小 | ✅ 已完成 |

实施过程中的三个额外发现（不在原清单里，由测试与参考实现逼出来）：

- **`stripPatch(inject(x)) !== x`**：模板文件末尾自带换行 ⇒ 剥离后原文前面多一个空行。
  在 P1-2 之前它只影响「重建原始内容」的边角路径，P1-2 之后直接影响备份内容（备份里会多一个字节，
  `--restore` 还原出来的入口与随包发布的不一致 ⇒ 自校验基准错位）。已修：`loadTemplate()` 把行尾
  归一成 LF 并去掉末尾换行，`stripPatch()` 容忍 CRLF。测试见 `src/patch.test.ts`。
- **`pack()` 返回时包其实还没写完**（上游 API 的坑，全套测试约每 3 次复现 1 次）：
  现象是紧随 `pack()` 的 `readMain()` 抛
  `Unexpected token '\x00', "\x00\x00…" is not valid JSON`——读到了「大小已到位、内容还是零页」的中间态。
  根因在 `@electron/asar`：`lib/disk.js` 的 `writeFilesystem` 最后一句是 `return out.end()`，
  返回的是 `WriteStream` 而不是 promise，所以 `createPackage` 的 promise **在写流关闭之前**就 resolve 了。
  已修：`src/asar.ts` 的 `pack()` 显式等写流 `close`（带超时兜底），再 `fsync` 一次。
  这不只是测试稳定性问题：**成品若没写完就被 `installFiles()` 拷进安装目录，用户拿到的是坏包**，
  而验收会以「自校验失败」收场。
- **`.gitignore` 补齐**：`hapora-debug.log`（`--verbose` 产物）与 `.workbuddy-ai/`（本地工作区数据）。

---

## 1. P1-1：中途失败不留回滚

**状态：✅ 已完成**（`src/hack.ts`）。实现要点：落盘后的「写许可证 + 验收」整段进入 `try`，
任何抛错（含 `writeLicense` 失败）与 `verdict.fatal` 走同一个 `restoreFiles()`；
Mach-O 路线仍分两个批次（二进制走提权、记录文件走用户态）。

### 现状

`doHack` 的执行顺序是：注入 → 打包 → 落盘（`src/hack.ts:236-239`）→ 写许可证（`:288`）
→ 验收（`:309`）。其中「落盘」之后到「验收」之前这一段**没有任何 try/catch**：

```ts
tp.installFiles(jobs, { elevate: opts.elevate });   // :239  asar 已改写
...
tp.writeLicense({ ... });                            // :288  可能抛错
```

而 `main().catch`（`:403-406`）只做一件事：打印 `失败：…` 并置退出码。于是
**`writeLicense` 一旦失败，补丁留在 `app.asar` 里，许可证存储却是空的** —— 正是
`AGENTS.md` 明令要避免的「改了却没激活」半成品种状态（该状态无报错、排查成本极高）。

### 复现路径

已实测：在受限执行环境里 `reg.exe` 不可用时，`pnpm hack` 输出前三行 ✓（注入、备份、落盘）后
抛 `spawnSync reg EPERM` 退出；磁盘上留下「已注入补丁 + 无 SLicense」的状态。
任何让 `writeLicense` 抛错的原因（注册表键被策略锁定、Linux 下 `~/.config/Typora` 不可写、
macOS 下记录文件被占用）都会走同一条路径。

### 修法

把「落盘之后到验收结束」整段纳入事务：失败即回滚。回滚逻辑与 `verdict.fatal` 分支
（`:316-333`）复用同一个函数，避免两份实现漂移。

```ts
// 落盘成功后进入事务区
try {
  tp.writeLicense({ email: config.email, licenseCode: config.licenseCode, now });
  ...
  const verdict = opts.verify ? await verify(install) : null;
  if (!opts.verify || verdict!.activated) { /* 成功返回 */ }
  if (!verdict!.fatal) { /* 未归因：保留改动，现行行为不变 */ }
  fatal = verdict!.detail;
} catch (err) {
  fatal = (err as Error).message;      // writeLicense 失败也按 fatal 处理
}
if (fatal) { await rollback(install, machoRollbackJobs, opts); }
```

注意两点：
- `writeLicense` 失败属于**可归因失败**（改动来自本次运行），必须回滚，不能沿用
  「未归因就保留」的策略；
- Mach-O 路线的回滚要继续遵守「二进制提权批次 / 记录文件用户态批次分开」的约束
  （`AGENTS.md`：记录文件不能混进提权批次，否则被 chown 成 root）。

### 验收判据

1. 让 `writeLicense` 必然失败（如临时把 `HKCU\SOFTWARE\Typora` 设为不可写，或在
   `writeLicense` 里注入一次抛错），跑 `pnpm hack --yes`：
   输出应出现回滚成功，且 `resources/app.asar` 与备份字节等价；
2. 随后 `pnpm hack --status` 显示入口为「（原始）」、`SLicense` 为「（空）」；
3. 正常路径回归：`pnpm hack --yes` 仍输出 `✓ 激活成功：…`。

---

## 2. P1-2：备份可能不是原始的

**状态：✅ 已完成**（`src/hack.ts` + 新文件 `src/backup.ts`）。实现要点：备份源改为
「解包 → 写回 `stripPatch` 后的入口 → 重新打包」（与成品共用一次解包），落盘前对备份内容断言
「不含补丁」；`planAsarBackup` 增加「备份里是补丁版 ⇒ 视为不可用，重建」这一态，
并单独成文件以便单测（`src/backup.test.ts` 覆盖首次/一致/已补丁/损坏/换入口/升级六种矩阵）。
**与原清单的偏差**：原清单说「备份里是补丁版 ⇒ 报错退出」（spec 里也是这么写的），
实现改为「重建备份」。理由：`stripPatch` 能精确还原原始入口，重建后的备份一定可用，
比直接失败更少让用户卡住；且报错退出会让「备份坏了」这个状态永远修不好。
spec `module-hack-cli.md` 的边界条件已同步。

### 现状

```ts
const source = backupState === "kept" ? install.backup : install.target;   // :218
...
if (backupState !== "kept") jobs.push({ from: install.target, to: install.backup });  // :237
```

备份的是 `install.target` 的**原样字节**。当「备份文件不存在」且「当前 asar 已注入补丁」
两个条件同时成立时，备份里存的就是**已打补丁的 asar**，此后 `pnpm hack --restore`
还原出来的仍是补丁版（表面上「回滚成功」，实际状态没变）。

`doHack` 里的 `if (isPatched(original)) throw` 挡不住这条路径 —— 因为 `original` 是
`stripPatch()` 之后的内容，恒为未补丁。

### 触发场景

用户手动删掉 `.bak`、安装目录被复制/迁移时漏掉备份、或早期版本的工具没有留备份。

### 修法

备份源不再裸拷 target，而是**先把入口还原成原始内容再打包**：

```ts
// 备份源 = 解包 → 写回 stripPatch 后的入口 → 重新打包
if (backupState !== "kept") {
  const pristine = join(work, "pristine.asar");
  await unpack(install.target, join(work, "unpacked-pristine"));
  writeFileSync(join(work, "unpacked-pristine", entryName), stripPatch(readEntry(install.target, entryName)));
  await pack(join(work, "unpacked-pristine"), pristine);
  jobs.push({ from: pristine, to: install.backup });
}
```

并补一条落盘后断言（防御性，成本极低）：

```ts
if (!isPatched(readEntry(install.backup, readMain(install.backup)))) { /* ok */ }
else throw new Error("备份内容为已补丁版本，拒绝继续");
```

### 验收判据

1. 构造状态：删除 `app.asar.hapora-orig.bak`（此时 `app.asar` 已注入补丁），
   跑 `pnpm hack --yes` → 新生成的备份里入口必须是「（原始）」；
2. `pnpm hack --restore` 后 `pnpm hack --status` 显示入口为「（原始）」；
3. 原本就没有备份的正常首次运行，行为不变（仍提示「已备份原始 app.asar」）。

---

## 3. P2：补丁防线的覆盖面

**状态：✅ 3.1 / 3.2 / 3.3 均已完成。**

三条防线都只覆盖了「当前版本实际走的那条通道」。版本无关是设计目标，但**通道无关**还没有做到；
上游换通道时，现状是「静默失效 + 靠验收兜住」，建议把覆盖面补齐。

### 3.1 更新拦截只覆盖 `electron.net.request`

**状态：✅ 已完成**。`https.request` / `http.request` / 全局 `fetch` 三条通道都做了
同一个窄匹配（只认 `/releases/*.json`，其余流量一律透传；`fetch` 返回最小 Response 形态，
不依赖全局 `Response` 是否存在）。`electron.net.request` 的行为与文案不变。

`src/inject/patch.js:213-241` 只 hook 了 `net.request`。若上游改用 `fetch` / `net.fetch` /
`https.request` 做更新检查，拦截失效 → 自动升级会覆盖 `app.asar` → 补丁被静默冲掉
（用户感知为「某天突然回到未激活」）。

建议：在 `RELEASE_JSON` 判定之外，再补 `https.request` / `http.request` 与全局 `fetch`
的窄匹配拦截（**只匹配 `/releases/*.json`，其余流量一律透传**），并保持
「electron 不可用时静默降级」的现有策略。

### 3.2 自校验放行只覆盖 3 个 fs API + 单次 `update()`

**状态：✅ 已完成**。补 `fs.createReadStream`（命中入口路径时返回原始内容的流）；
`createHash` 改为**累积缓冲**判定（`digest()` 时按累积内容认自己，分块 `update` 不再 miss；
累积超过 `SELF_LEN` 立即放弃缓冲，内存有界）；`crypto.subtle.digest('SHA-256', …)` 同构放行。
另加 `asBuffer()` 统一 string / Buffer / ArrayBuffer / TypedArray 的判定输入。

`src/inject/patch.js` 的读取层 hook 了 `readFileSync` / `readFile` / `promises.readFile`
（`:107-130`），哈希层 hook 了 `crypto.createHash`（`:142-161`）。未覆盖：

- `fs.createReadStream` / `fs.promises.open().read()`；
- 分块 `update()`（现有 `looksLikeSelf` 只判断单次传入的数据，流式分块必 miss）；
- `crypto.subtle.digest`（WebCrypto）。

建议：
1. 补 `createReadStream` 的 hook（命中入口路径时返回原始内容的流）；
2. `createHash` 的判定改为**累积缓冲**：把 `update()` 的数据追加进内部 buffer，
   在 `digest()` 时判断累积内容是否为「自己」，而不是只看某一块；
3. `crypto.subtle.digest('SHA-256', data)` 加同构放行（可选，成本低）。

### 3.3 Windows 许可证写入只有一条路

**状态：✅ 已完成**。`src/registry.ts` 的 `write()` 在 `reg.exe` 失败后回退到
`powershell -NoProfile -NonInteractive` 的 `New-ItemProperty`；两条都失败时抛出的错误会区分
「两条通道都被策略拒绝（沙箱 / AppLocker / 程序黑名单）」与「注册表键不可写」，并附两条通道的首行报错，
不再把裸的 `spawnSync reg EPERM` 直接甩给用户。

`src/platform/windows.ts:321-328` 直接调 `reg.exe`（`src/registry.ts` 用 `execFile`）。
在受限环境（沙箱、AppLocker、程序黑名单）下直接 `EPERM`，且没有替代通道。

建议：加 `powershell -NoProfile -Command "Set-ItemProperty ..."` 作为回退；两条路都失败时，
输出可诊断的明确错误（区分「被策略拦截」与「注册表键不可写」），而不是裸的 `spawnSync reg EPERM`。

---

## 4. P3：工程化

### 4.1 单元测试（最高优先）

**状态：✅ 已完成**（55 项，`pnpm test`）。落点与建议的表格一一对应：
`src/asar-stage.test.ts`（打包步骤：备份源必须是「入口已还原」的包）、
`src/hack-dry-run.test.ts`（`--dry-run` 的端到端契约，见 §5）、
`src/patch.test.ts`（inject / stripPatch / 长度回填 / 基准 sha256 / CRLF 互逆）、
`src/inject/patch.test.ts`（从 patch.js 源码里抽出 `machineId` / `fingerprint` 跑，
含「末尾替换不可省」的撞库断言）、`src/backup.test.ts`（备份矩阵，用真实 asar 在临时目录跑）、
`src/platform/linux.test.ts`（指纹 + hex 编解码）、
`src/platform/darwin-license.test.ts`（bplist 编解码 / int marker / real / CBC-非-ECB / 记录往返）、
`src/platform/darwin-macho.test.ts`（合成 thin + fat fixture 的符号定位、等长补丁、结构异常）。

项目零测试，但有一批**不需要 Typora 就能测**的纯函数，而且恰好覆盖 `AGENTS.md` 里
「踩错就静默失效」的那几个坑：

| 被测对象 | 该钉住的性质 |
|---|---|
| `fingerprint()`（`patch.js`） | `sha256(machineId + "typora")` → base64 前 10 位 → `[/=+-]` 全部替换为 `a`；末尾替换不可省 |
| `inject()` / `stripPatch()`（`patch.ts`） | 长度回填定宽、二次替换后字节数不变、`stripPatch(inject(x)) === x` |
| `licenseValue()` / `formatDate()` | `base64#0#M/D/YYYY` 形状 |
| Linux 许可证编解码（`platform/linux.ts`） | 内容是整段 JSON 的**十六进制**，只有 `SLicense` 键；读写先解/编 hex |
| binary plist 编解码（`platform/darwin-license.ts`） | int marker 低 4 位 = log2(字节数)（4 字节是 `0x12`）；`NS.time` 必须 real 编码 |
| Mach-O 解析（`platform/darwin-macho.ts`） | 用固定 fixture 二进制断言符号定位结果；禁止出现偏移常量 |
| `planAsarBackup` / `planRecordBackup` | 见 P1-2 的场景矩阵（首次 / 已补丁 / 升级后） |

运行时建议用 Node 内置 `node:test`，加 `"test": "tsx --test src/**/*.test.ts"` 即可，不引新依赖。

实际落地时改成了**显式列出测试文件**（`tsx --test src/patch.test.ts …`）：`**` 在 Windows 的
`cmd` 下不会被展开，而 `node --test` 自己的 glob 需要较新的 Node 版本，写死文件名是唯一
在三个平台、所有 Node ≥ 20 上都确定的行为。新增测试文件时记得同步 `package.json`。

### 4.2 typecheck 脚本与 CI

**状态：✅ 已完成**：`package.json` 增加 `typecheck` / `test` 脚本与 `engines.node >= 20`；
`.github/workflows/ci.yml` 在 ubuntu / macos / windows 三个 runner 上跑 `pnpm install --ignore-scripts`
→ `pnpm typecheck` → `pnpm test`（`--ignore-scripts` 是为了绕开仓库已知的 esbuild postinstall 问题）。
真机验收不放进 CI。

- `package.json` 加 `"typecheck": "tsc --noEmit"`（当前 `tsc` 只作为 devDependency 存在，没有脚本入口）；
- 加 `"engines": { "node": ">=20" }`，把 README 里的「Node.js ≥ 20」变成硬约束；
- CI：三个平台各跑一次 `pnpm typecheck` + `pnpm test` 即可（**真机验收无法自动化**，不要假装能）。

### 4.3 诊断信息

**状态：✅ 已完成**（新文件 `src/diag.ts` + `Platform.logPath` 可选能力位）。`--verbose` 才收集，
只在**失败路径**落盘 `hapora-debug.log`（成功不留文件）：平台、安装目录、目标与备份路径、入口名、
自校验基准 sha256、备份状态、补丁点、每次验收探针结果、验收信号文件（Windows/Linux 的 `typora.log`）
末尾 40 行。失败输出里直接给出该文件路径，并提示「可加 --verbose 重跑」。

`src/hack.ts:333` 写着「请把以下信息连同目标文件状态提供给维护者」，但当前没有可提供的载体。
建议加 `--verbose`：把探测到的安装目录、入口名、自校验基准 sha256、备份状态、验收期间
`typora.log` 的本次片段落到仓库内的 `hapora-debug.log`（不入库），失败时提示该文件路径。

### 4.4 README 补「装了补丁但没激活」排查段

**状态：✅ 已完成**：README 增加「出问题怎么排查」段（`--status` 三看 → 日志关键字 →
`--verbose` 取 `hapora-debug.log` → `--restore`），并点出三个静默失效坑。

`AGENTS.md` 里记录的几个静默失效坑（fingerprint 的末尾替换、Linux 的 hex 编码、
plist 的 int marker）目前只在 AGENTS 里。建议在 README 加一个简短的排查段，
给出「先看 `--status`，再看日志关键字」的最小路径。

---

## 5. 可选增强（非缺陷）

**收口结论（2026-10-12）**：一条落地，两条经复核不采纳。

- **`--dry-run`**：**✅ 已完成**。只探测与打包（全程在临时目录），打印将要写入什么——
  入口名、`原始字节 → 注入后字节`、自校验基准 sha256、备份状态、备份与成品的目标路径、
  许可证落点，然后退出；不落盘、不写许可证、不启动 Typora，也不结束正在运行的 Typora
  （因此不需要 `--yes`）。macOS 的 Mach-O 路线做不到「只 stage 不写」（补丁 + 重签是同一次
  事务），那边退化为只读巡检 + 列出计划。
  验收：`src/hack-dry-run.test.ts` 在临时目录里伪造一个「Typora 安装」跑真实 CLI，断言
  退出码 0、`app.asar` 的 sha256 不变、没有生成 `.hapora-orig.bak`、写入探测文件已清理；
  另一条断言 `--dir` 无效时仍报错退出（不回退自动探测）。两种情形下**显式 skip** 而不是假装通过：
  受限环境里子进程起不来（实测 `spawnSync node.exe EBUSY`），以及**非 asar 路线的平台**
  （macOS：伪造的是 `resources/app.asar` 布局，而 macOS 的 `resolve` 只认 `.app` 包；
  Mach-O 路线的 dry-run 是只读巡检，按规矩留真机验证）。CI 的 Windows / Linux 上照常执行。
- **`--verify-deep`**：**❌ 不采纳——原提议的前提不成立**。原提议假设「续期链路（1–12 小时窗口）
  在正常验收时不会被触发」，但实测日志序列显示**每次启动都会续期**：
  `renew` → `[renewLicense]: {…}` → `[L] pass` → `[watch L] hasL: true` →
  `[renewLicense]: license renewed`（`docs/researches/activation-win.md` §3）。也就是说常规验收的
  判据里**已经**要求 `[renewLicense]: license renewed`，`electron.net` 的续期接管本来就在覆盖范围内；
  而「回拨 `IDate` / `lastTry` 强制续期」不会打开任何新路径（客户端没有窗口判断），却会往用户的
  许可证存储里写一个刻意做旧的日期。1–12 小时说的是**服务端**的宽限，不是客户端的触发条件。
- **备份双写**：**❌ 不采纳——P1-2 之后已无必要**。原提议担心 `app.asar.hapora-orig.bak` 会随
  重装/卸载一起消失。P1-2 之后这不是问题：备份缺失时新的备份源是「把当前入口 `stripPatch` 成
  原始内容再打包」得到的包（`src/asar-stage.ts`，`src/asar-stage.test.ts` 与 `src/backup.test.ts`
  钉住），即**备份丢了也能自愈**，且产出的备份与随包发布的原始内容逐字节一致。
  再在用户目录留一份只会多出一个需要清理的残留物。

---

## 6. 明确不做

与既有 ADR 冲突，评审中已被否决的提议：

- **macOS 跨升级自动保活**：与 ADR-012「不引入常驻组件」冲突；现在「升级失效 → 重跑
  `pnpm hack`」的取舍是有意为之。
- **「保证任意版本可用」**：PRD 已声明只能做到「不兼容时安全失败」，不要为了覆盖率
  引入版本 → 常量对照表。
- **通用逆向框架 / GUI**：非目标。

---

## 7. 完成后的回归清单

改完任何一项，按 `AGENTS.md` 的要求跑真机验收：

- Windows / Linux（asar 路线）：`pnpm hack --yes`，日志中同时出现
  `[watch L] hasL: true` 与 `[renewLicense]: license renewed`，且启动 1s 后
  **没有** `Integrity check failed`、**没有** `onUnfillLicense`、进程不退出；
- macOS：`pnpm hack --yes`，探针报「许可证记录保持有效……Typora 存活」，
  `lastTry` 金丝雀在续期窗口之外；
- 两条路线都补跑一次 `pnpm hack --restore` → `pnpm hack --status`，确认回到原始状态
  （macOS 需验证回 `Authority=Developer ID Application`）。
