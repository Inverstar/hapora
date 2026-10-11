/* === hapora license patch === */
/*
 * 由 pnpm hack 注入到 Typora 入口文件的最前面（"use strict" 之后，见 src/patch.ts）。
 * 占位符只在下方各出现一次，勿在注释里重复书写。
 */
(function () {
  var fs = require("fs");
  var path = require("path");
  var crypto = require("crypto");
  var EventEmitter = require("events").EventEmitter;
  var G = typeof globalThis !== "undefined" ? globalThis : null;

  var APP_DIR = __dirname;
  var MARKER = "__HAPORA_MARKER__";
  var ENTRY_NAME = "__HAPORA_ENTRY__";
  var SELF_SHA256 = "__HAPORA_SELF_SHA256__";
  var SELF_B64 = "__HAPORA_SELF_B64__";
  var SELF_LEN = parseInt("__HAPORA_SELF_LEN__", 10);
  var LICENSE_KEY = "__HAPORA_LICENSE_KEY__";
  var LICENSE_EMAIL = "__HAPORA_EMAIL__";
  var PATCH_TAG = "/* === hapora license patch === */";

  /* ---------- 0. 环境信息（版本号与机器指纹） ---------- */
  function appVersion() {
    try {
      return JSON.parse(fs.readFileSync(path.join(APP_DIR, "package.json"), "utf8")).version || "0.0.0";
    } catch (e) {
      return "0.0.0";
    }
  }
  function machineId() {
    try {
      var reg = require("native-reg");
      var a = reg.Access;
      var key = reg.openKey(reg.HKEY.LOCAL_MACHINE, "SOFTWARE\\Microsoft\\Cryptography", a.READ, a.WOW64_64KEY);
      var v = reg.getValue(key, null, "MachineGuid");
      reg.closeKey(key);
      if (v) return String(v);
    } catch (e) { /* 回退到 reg.exe */ }
    try {
      var out = require("child_process").execSync(
        'reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid /reg:64',
        { encoding: "utf8", windowsHide: true }
      );
      var m = out.match(/MachineGuid\s+REG_SZ\s+(\S+)/);
      if (m) return m[1];
    } catch (e) { /* 读取失败 */ }
    /* Linux：/etc/machine-id（systemd 标准，Ubuntu / Fedora / Arch 均适用） */
    try {
      var id = require("fs").readFileSync("/etc/machine-id", "utf8").trim();
      if (id && id.length >= 32) return id;
    } catch (e) { /* 回退到 dbus */ }
    try {
      var id = require("fs").readFileSync("/var/lib/dbus/machine-id", "utf8").trim();
      if (id && id.length >= 32) return id;
    } catch (e) { /* 读取失败 */ }
    return "";
  }
  /* 指纹必须是客户端自己算出来的那一份：sha256(MachineGuid + "typora") 的 base64 前 10 位，
   * 再把 [/=+-] 一律换成 "a"（Typora 自己就是这么做的，末尾的 replace 不能省——
   * 少了它，base64 里出现 / + = - 的机器（约一半）会因指纹对不上而拒绝我们伪造的载荷）。 */
  function fingerprint() {
    return crypto.createHash("sha256").update(machineId() + "typora").digest("base64")
      .slice(0, 10).replace(/[/=+-]/g, "a");
  }
  function fakeLicense() {
    return {
      deviceId: "0MA-",
      fingerprint: fingerprint(),
      email: LICENSE_EMAIL,
      license: LICENSE_KEY,
      version: "win|" + appVersion(),
      date: Date.now(),
      type: "",
    };
  }

  /* ---------- 1. 自校验放行 ----------
   * 启动约 1s 后 Typora 会：读 package.json 取 main → 读 main 指向的本文件 →
   * sha256 → 与随包发布的基准比对，不一致就记录 [LC] 并退出。
   * 两层放行：
   *   (a) 读取层——凡是读本文件（readFile* / createReadStream），一律把「随包发布的内容」还回去，
   *       校验自然通过，而且与校验用什么算法、怎么比对无关；
   *   (b) 哈希层——万一读取走的是别的通道，就在 digest（createHash / subtle.digest）上
   *       直接返回基准值兜底；createHash 按**累积内容**判定，分块 update 也认得出自己。
   */
  function normPath(p) {
    try {
      if (p && typeof p === "object" && !Buffer.isBuffer(p) && p.href) p = p.href;
      return String(p).replace(/\\/g, "/").toLowerCase();
    } catch (e) {
      return "";
    }
  }
  var ENTRY_NORM = normPath(path.join(APP_DIR, ENTRY_NAME));
  function isEntry(p) {
    return normPath(p) === ENTRY_NORM;
  }
  var pristine = null;
  function pristineBytes() {
    if (!pristine) pristine = Buffer.from(SELF_B64, "base64");
    return pristine;
  }
  function pristineAs(opt) {
    var enc = typeof opt === "string" ? opt : (opt && opt.encoding) || null;
    return enc ? pristineBytes().toString(enc) : pristineBytes();
  }
  /** 把 string / Buffer / ArrayBuffer / TypedArray 统一成 Buffer（自校验判定用）。 */
  function asBuffer(d) {
    try {
      if (d === null || d === undefined) return null;
      if (typeof d === "string") return Buffer.from(d, "utf8");
      if (Buffer.isBuffer(d)) return d;
      if (typeof ArrayBuffer !== "undefined" && d instanceof ArrayBuffer) return Buffer.from(new Uint8Array(d));
      if (d && typeof d.byteOffset === "number" && d.buffer) return Buffer.from(d.buffer, d.byteOffset, d.byteLength);
      return null;
    } catch (e) {
      return null;
    }
  }

  var origReadFileSync = fs.readFileSync;
  fs.readFileSync = function (p, opt) {
    if (isEntry(p)) return pristineAs(opt);
    return origReadFileSync.apply(this, arguments);
  };

  var origReadFile = fs.readFile;
  fs.readFile = function (p, opt, cb) {
    if (isEntry(p)) {
      if (typeof opt === "function") { cb = opt; opt = null; }
      var v = pristineAs(opt);
      process.nextTick(function () { cb(null, v); });
      return;
    }
    return origReadFile.apply(this, arguments);
  };

  if (fs.promises && typeof fs.promises.readFile === "function") {
    var origPromisesReadFile = fs.promises.readFile;
    fs.promises.readFile = function (p, opt) {
      if (isEntry(p)) return Promise.resolve(pristineAs(opt));
      return origPromisesReadFile.apply(this, arguments);
    };
  }

  /* 流式读取（createReadStream）也要走读取层——否则用流哈希入口文件的版本绕得过放行。 */
  if (typeof fs.createReadStream === "function") {
    var origCreateReadStream = fs.createReadStream;
    fs.createReadStream = function (p, opt) {
      if (isEntry(p)) {
        var Readable = require("stream").Readable;
        var rs = new Readable({ read: function () {} });
        var enc = typeof opt === "string" ? opt : (opt && opt.encoding) || null;
        if (enc) rs.setEncoding(enc);
        process.nextTick(function () {
          rs.push(pristineBytes());
          rs.push(null);
        });
        return rs;
      }
      return origCreateReadStream.apply(this, arguments);
    };
  }

  function looksLikeSelf(d) {
    try {
      var b = asBuffer(d);
      if (!b || b.length !== SELF_LEN) return false;
      return b.indexOf(PATCH_TAG) >= 0;
    } catch (e) {
      return false;
    }
  }
  /** 命中自己时该返回的基准哈希（按调用方要的编码现算）。 */
  function selfDigest(enc) {
    var b = Buffer.from(SELF_SHA256, "hex");
    return enc ? b.toString(String(enc)) : b;
  }

  var origCreateHash = crypto.createHash;
  crypto.createHash = function (alg) {
    var isSha256 = String(alg).toLowerCase() === "sha256";
    var h = origCreateHash.apply(this, arguments);
    /* 累积缓冲：只看单次 update 的数据，流式分块哈希必然 miss。
     * 上限就是 SELF_LEN——累积比「自己」更长即已不可能命中，立即放弃缓冲（内存不会无界增长）。 */
    var acc = isSha256 ? [] : null;
    var total = 0;
    var ou = h.update, od = h.digest;
    h.update = function (d, enc) {
      try {
        if (acc) {
          var plain = !enc || enc === "utf8" || enc === "utf-8" || enc === "latin1" || enc === "binary" || enc === "ascii";
          var b = plain ? asBuffer(d) : null;
          if (!b) {
            acc = null;
          } else {
            total += b.length;
            if (total > SELF_LEN) acc = null;
            else acc.push(b);
          }
        }
      } catch (e) {
        acc = null;
      }
      return ou.apply(this, arguments);
    };
    h.digest = function (enc) {
      try {
        if (acc && looksLikeSelf(Buffer.concat(acc))) return selfDigest(enc);
      } catch (e) { /* 忽略 */ }
      return od.apply(this, arguments);
    };
    return h;
  };

  /* WebCrypto 的 subtle.digest 是同一条自校验链路的可能通道（同构放行，失败静默降级）。 */
  try {
    var subtle = (crypto.webcrypto && crypto.webcrypto.subtle) || crypto.subtle;
    if (subtle && typeof subtle.digest === "function") {
      var origSubtleDigest = subtle.digest;
      subtle.digest = function (alg, data) {
        try {
          if (String(alg).toLowerCase().replace(/[^a-z0-9]/g, "") === "sha256" && looksLikeSelf(data)) {
            var b = Buffer.from(SELF_SHA256, "hex");
            return Promise.resolve(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
          }
        } catch (e) { /* 忽略 */ }
        return origSubtleDigest.apply(subtle, arguments);
      };
    }
  } catch (e) { /* subtle 只读等情形：静默降级 */ }

  /* ---------- 2. 作废激活校验：劫持 publicDecrypt 的返回值 ----------
   * 许可证密文经 publicDecrypt 解密后即为许可证 JSON。
   * 对无法解密的密文直接返回本地构造的许可证载荷，于是任意 SLicense 都能通过本地校验。
   */
  var origPublicDecrypt = crypto.publicDecrypt;
  crypto.publicDecrypt = function () {
    try {
      var out = origPublicDecrypt.apply(this, arguments);
      if (out.toString("utf8").charAt(0) === "{") return out; /* 真实许可证：原样放行 */
    } catch (e) { /* 密文非法（长度不对 / 填充不对）→ 落入伪造载荷 */ }
    return Buffer.from(JSON.stringify(fakeLicense()), "utf8");
  };

  /* ---------- 3. 伪造许可证服务器响应 & 屏蔽更新检查 ---------- */
  var LICENSE_API = /\/api\/client\//;
  var RELEASE_JSON = /\/releases\/[^?#]*\.json/;

  function releaseJsonBody() {
    return JSON.stringify({
      name: "typora",
      version: appVersion(),
      releaseNoteLink: "",
      download: "",
      downloadCN: "",
      alternatives: {},
    });
  }

  function fakeResponse(url, statusCode, body) {
    var Readable = require("stream").Readable;
    var req = new EventEmitter();
    req.url = url;
    req.method = "POST";
    req.aborted = false;
    req.write = function () { return true; };
    req.abort = function () { this.aborted = true; };
    req.destroy = function () { this.aborted = true; };
    req.setHeader = function () {};
    req.getHeader = function () { return null; };
    req.removeHeader = function () {};
    req.followRedirect = function () {};
    req.setTimeout = function () { return this; };
    req.setNoDelay = function () {};
    req.setSocketKeepAlive = function () {};
    req.flushHeaders = function () {};
    req.end = function () {
      var self = this;
      process.nextTick(function () {
        if (self.aborted) return;
        var res = new Readable({ read: function () {} });
        res.statusCode = statusCode;
        res.statusMessage = "OK";
        res.headers = {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
        };
        self.emit("response", res);
        res.push(Buffer.from(body, "utf8"));
        res.push(null);
      });
      return this;
    };
    return req;
  }

  /** fetch 用的最小 Response 形态（不依赖全局 Response 存在与否）。 */
  function fakeFetchResponse(url, body) {
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      url: url,
      headers: {
        get: function (n) { return n && String(n).toLowerCase() === "content-type" ? "application/json" : null; },
      },
      json: function () { return Promise.resolve(JSON.parse(body)); },
      text: function () { return Promise.resolve(body); },
      clone: function () { return this; },
    });
  }

  /** 从 string / URL / Request / http 选项对象里取 URL 文本（取不到返回空串）。 */
  function urlOf(u) {
    try {
      if (!u) return "";
      if (typeof u === "string") return u;
      if (u.url || u.href) return String(u.url || u.href);
      if (u.host || u.hostname) return "https://" + (u.host || u.hostname) + (u.path || "");
      return "";
    } catch (e) {
      return "";
    }
  }

  try {
    var net = require("electron").net;
    if (net && typeof net.request === "function") {
      var origRequest = net.request;
      net.request = function (options) {
        var url = urlOf(options);
        if (LICENSE_API.test(url)) {
          /* 续期 / 激活 / 反激活一律返回成功，msg 供下一次解密使用 */
          return fakeResponse(url, 200, JSON.stringify({
            success: true,
            code: 1,
            msg: Buffer.from(MARKER).toString("base64"),
          }));
        }
        if (RELEASE_JSON.test(url)) {
          /* 更新检查：回报「当前已是最新」，等价于屏蔽更新 */
          return fakeResponse(url, 200, releaseJsonBody());
        }
        return origRequest.apply(net, arguments);
      };
    }
  } catch (e) { /* electron 不可用时静默降级 */ }

  /* 更新检查的通道不止 electron.net：上游若改走 https / http / fetch，放行更新会把
   * app.asar 整个冲掉（表现为「某天突然回到未激活」）。这里对这三条通道做同一个窄匹配
   * ——只认 /releases/*.json，其余流量一律透传。 */
  try {
    var httpMods = [];
    try { httpMods.push(require("https")); } catch (e) { /* 无此模块 */ }
    try { httpMods.push(require("http")); } catch (e) { /* 无此模块 */ }
    for (var mi = 0; mi < httpMods.length; mi++) {
      (function (mod) {
        if (!mod || typeof mod.request !== "function" || mod.__haporaHooked) return;
        var origModRequest = mod.request;
        mod.__haporaHooked = true;
        mod.request = function (options, cb) {
          if (RELEASE_JSON.test(urlOf(options))) {
            var req = fakeResponse(urlOf(options), 200, releaseJsonBody());
            if (typeof cb === "function") req.on("response", cb);
            return req;
          }
          return origModRequest.apply(mod, arguments);
        };
      })(httpMods[mi]);
    }
  } catch (e) { /* 静默降级 */ }

  try {
    if (G && typeof G.fetch === "function") {
      var origFetch = G.fetch;
      G.fetch = function (input) {
        var url = urlOf(input);
        if (RELEASE_JSON.test(url)) return fakeFetchResponse(url, releaseJsonBody());
        return origFetch.apply(G, arguments);
      };
    }
  } catch (e) { /* 静默降级 */ }
})();
/* === end hapora license patch === */
