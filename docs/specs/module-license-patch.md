# Spec — 注入补丁（`src/inject/patch.js` + `src/patch.ts`）

> **适用范围：仅 asar 路线（Windows / Linux 的 Electron 版）**。
> macOS 版是原生应用、没有可注入的入口，走「伪造许可证记录文件」路线
> （见 spec `module-platform.md` 与 `docs/researches/activation-mac.md`）。

## 要构建什么

- 目标：一段被注入到 Typora 明文入口**最前面**的代码，使被改动过的程序仍能通过自校验，
  并让许可证链路在无服务端的情况下判定为「已激活、已续期、无更新」。
- 约束：不依赖任何 Typora 版本相关的常量——入口名、基准哈希、文件长度、版本号、指纹全部现算。

## 行为

### 1. 自校验放行（两层，互为兜底）

Typora 启动约 1s 后会：读 `<asar>/package.json` 取 `main` → 读该文件 → sha256 → 与内置基准比对，
不一致就记录 `[LC] Integrity check failed` 并退出。补丁做两件事：

- **(a) 读取层**：包装 `fs.readFileSync` / `fs.readFile` / `fs.promises.readFile` / `fs.createReadStream`，
  当路径规范化后等于 `path.join(__dirname, <入口名>)` 时，返回**随包发布的入口原文**
  （打包时以 base64 内嵌；流式读取返回内容为该原文的 `Readable`）。这样无论校验用什么算法、
  怎么比对，都会算出基准值。
- **(b) 哈希层**：包装 `crypto.createHash` 与 `crypto.subtle.digest`。判定按**累积内容**做
  （不是单次 `update()` 的实参）：把每次 `update()` 的数据追加进内部缓冲，累积长度一旦超过
  `SELF_LEN` 立即放弃缓冲（内存有界），在 `digest()` 时判断累积内容是否「字节长度等于补丁后入口
  文件的长度」且「包含补丁标记 `/* === hapora license patch === */`」，命中则返回随包发布内容的 sha256。
  这样流式分块哈希（`createReadStream` → `hash.update(chunk)`）同样认得出自己。
- 判定输入统一用 `asBuffer()` 归一（string / Buffer / ArrayBuffer / TypedArray），
  否则 `subtle.digest('SHA-256', arrayBuffer)` 这类调用永远判不中。
- 两层各自单独都足以通过校验（已实测），同时保留是为了在未知版本上互相兜底。
- 其余哈希调用（如机器指纹）必须原样透传。

### 2. 许可证解密接管

- 包装 `crypto.publicDecrypt`。
- 先调用原实现：若返回的文本以 `{` 开头（真实许可证 JSON），原样返回。
- 否则（抛错或返回非 JSON）返回本地构造的许可证 JSON：
  `deviceId` / `fingerprint` / `email` / `license` / `version` / `date` / `type`。
- `fingerprint` **必须逐字符等于客户端自己算出来的那一份**，否则整份载荷被拒（详见研究报告 §4.1）：
  `Base64(SHA256(MachineGuid + "typora"))[0..10].replace(/[/=+-]/g, "a")`，
  `MachineGuid` 来自 `HKLM\SOFTWARE\Microsoft\Cryptography`（先试 `native-reg`，失败回退 `reg.exe`）。
  末尾那次 `.replace()` 不能省——base64 前缀里出现 `+` `/` `=` 的概率约一半，
  省掉它会让补丁在一半的机器上静默失效。
- `version` 取当前 Typora 版本（读同目录 `package.json`）。
- `email` / `license` 来自配置（见 `module-hack-cli.md`）。

### 3. 续期 / 激活 / 反激活接管

- 包装 `electron.net.request`。
- URL 命中 `/api/client/` 时，返回一个假 `ClientRequest`，其 `end()` 之后异步 `emit("response", res)`，
  `res` 是 `stream.Readable`，携带 `statusCode = 200`、`statusMessage`、`headers`，body 为
  `{"success":true,"code":1,"msg":"<base64(许可证标记)>"}`。
- 其余 URL 原样透传给原实现。

### 4. 更新检查接管（四条通道）

- 同一个 `net.request` 包装内，URL 命中 `/releases/*.json` 时，返回 body 为
  `{"name":"typora","version":"<当前版本>","releaseNoteLink":"","download":"","downloadCN":"","alternatives":{}}`
  的假响应，使客户端认为已是最新。
- **通道无关**：更新检查换通道（`https.request` / `http.request` / 全局 `fetch`）时同样拦得住——
  上游换通道而补丁没跟上，自动更新会覆盖 `app.asar`，表现为「某天突然回到未激活」。
  - `https.request` / `http.request`：窄匹配 `/releases/*.json`，命中则返回假 `ClientRequest`
    （带 `on` / `end` / `write` / `abort` / `destroy` / `setTimeout` 等最小面），
    `http.request(url, cb)` 的 `cb` 注册为 `response` 监听；其余 URL 原样透传。
  - 全局 `fetch`：命中同样 URL 时返回最小 Response 形态（`ok` / `status` / `headers.get` /
    `json()` / `text()` / `clone()`），**不依赖全局 `Response` 是否存在**；其余原样透传。
  - 三条新通道只匹配 `/releases/*.json`（许可证接口仍只由 `electron.net` 接管），
    其余流量一律透传，避免影响页面与其它网络请求。

## 输入 / 输出

- 输入（模板占位符，由 `src/patch.ts` 渲染，每个在全文件只出现一次）：
  - `__HAPORA_SELF_SHA256__` → 入口原文的 sha256（64 位十六进制）
  - `__HAPORA_SELF_B64__` → 入口原文的 base64
  - `__HAPORA_SELF_LEN__` → 补丁后入口文件的字节长度，定宽 8 位
  - `__HAPORA_ENTRY__` → 入口文件名（相对 asar 根）
  - `__HAPORA_MARKER__` → 许可证标记明文（同时用作许可证值）
  - `__HAPORA_LICENSE_KEY__` / `__HAPORA_EMAIL__` → 伪造载荷里的序列号与邮箱
- 输出：改写后的入口源码（字符串）。
- 运行期输出：`typora.log` 中的 `[L] pass` / `[watch L] hasL: true` / `[renewLicense]: license renewed`。

## 约束

- 语法锁定 ES5：只用 `var` 与 `function`，不用箭头函数、模板串、`const`/`let`。
- 注入位置固定为文件最前面（若以 `"use strict"` 开头则插在其后），不依赖入口里的任何语句形式。
- 占位符全文件各出现一次；`src/patch.ts` 渲染前校验模板包含全部占位符，渲染后校验长度占位符只出现一次。
- 长度回填必须定宽：先 8 个 `0`，量出长度后替换成同宽数字。
- 注入代码整体包在 IIFE 内，且除 Hook 安装外不产生全局副作用。
- 不引入任何新依赖：只用 Node/Electron 内置模块。

## 边界条件

- `crypto.publicDecrypt` 收到空 Buffer / 非法 Base64 / 长度不符的密文 → 落回伪造载荷。
- `MachineGuid` 读不到 → 指纹退化为 `SHA256("typora")` 的前 10 位；**客户端会因指纹对不上而拒绝**，
  表现为 `no info` / `onUnfillLicense` / `hasL: false`（不会报错，也不会崩）。这是已知的失败模式，
  不是可以忽略的降级。
- `fingerprint` 只要与客户端算出的值差一个字符（例如漏了末尾的 `.replace(/[/=+-]/g, "a")`），
  整份载荷就会被拒；`email` / `date` / `version` / 许可证号则完全不校验。
- `native-reg` 不可用 → 回退到 `reg.exe`；两者都失败 → 空串。
- `electron.net` 不可用 → 静默跳过网络接管（不影响本地激活）。
- `http` / `https` / 全局 `fetch` 任一不可用 → 该通道静默降级（其余通道照常），
  且不得因此抛错中断补丁安装。
- 自校验走 `createReadStream`、分块 `hash.update()` 或 `crypto.subtle.digest` 时同样放行
  （读取层覆盖到流，哈希层按累积内容判定）。
- 请求在 `end()` 之前被 `abort()`/`destroy()` → 不发出响应，避免幽灵事件。
- 入口文件以 URL 对象 / Buffer 形式传给 fs read → 路径匹配按字符串处理，不命中则原样透传。
- 更新检查拿到的 URL 不属于上述两类（例如 `file://` 资源）→ 原样透传，不能影响页面加载。

## 验收标准

- [x] 注入后 `typora.log` 出现 `[L] pass` 与 `[watch L] hasL: true`。
- [x] 注入后不出现 `Integrity check failed`（自校验放行生效）。
- [x] 单独关闭读取层、或单独关闭哈希层，校验仍然通过（两层各自充分）。
- [x] 两层同时关闭时校验失败并退出（证明上面两条不是假阳性）。
- [x] 出现 `[renewLicense]: license renewed`，且不出现 `unfill due to renew fail`。
- [x] 启动后 `checkForUpdates` 不再产生任何更新提示。
- [x] 主窗口无 `UNREGISTERED` 水印，许可证对话框显示「已使用以下序列号激活」。
- [x] 在用户持有真实许可证的机器上，`publicDecrypt` 返回真实 JSON 时行为不变（原样放行）。
- [x] （无需 Typora）`pnpm test` 里的补丁测试全绿：`stripPatch(inject(x)) === x`、
  长度回填不改变字节数、基准 sha256 等于原文哈希、指纹末尾替换不可省。
- [ ] **（真机）通道覆盖回归**：把自校验的读取改成 `fs.createReadStream`、或改成
      `createHash` 分块 `update()` 后重新注入，`typora.log` 仍出现 `[watch L] hasL: true`
      且不出现 `Integrity check failed`（证明新增的读取层/累积哈希层确实生效）。
- [ ] **（真机）更新通道回归**：`pnpm hack --yes` 后启动 Typora，检查更新不应提示有新版本
      （`electron.net` 路径的既有判据不变；新增的 http/https/fetch 通道需要上游换通道时才有机会实测）。

## 完成定义

- 如何判定已完成：以上清单全部勾选，且把入口文件整体换个位置注入（不依赖任何原语句）后仍能通过验收。
