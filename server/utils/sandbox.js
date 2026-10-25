/**
 * 安全沙箱模块（2026-10-23 加固版）
 *
 * 背景：原实现把宿主的全局对象（Object/String/Promise…）直接注入 vm 上下文，
 * 攻击者可用 `this.constructor.constructor('return process')()` 拿到宿主的
 * Function 构造器，进而拿到 process → fs + child_process 完成 RCE。
 * 2026-10-18 的攻击正是由此进入（artex-i121 / artex-i143 / artex-diag-105）。
 *
 * 加固要点（三条缺一不可，已用真实载荷验证）：
 *   ① 不注入任何宿主对象 —— 用 vm.createContext 自带的独立 realm
 *   ② codeGeneration: { strings: false, wasm: false } —— 禁止在沙箱内从字符串编译代码
 *   ③ 上下文数据 JSON 往返 —— 切断宿主对象引用链，数据在沙箱内重建
 *
 * 验证结论：
 *   旧写法                          → 逃逸成功
 *   仅加 codeGeneration 限制        → 仍可逃逸（因为注入了宿主对象）
 *   三条同时做                      → EvalError 拦截
 *
 * 注意：vm 仍非绝对隔离。真正的高安全场景应使用 isolated-vm 或独立进程 + seccomp。
 * 本模块的目标是消除已知的 constructor 链逃逸，并让沙箱内无法编译新代码。
 */

const vm = require('vm');

const SANDBOX_NAME = 'crewrouter-sandbox';

// 沙箱内可安全收集日志的最大条数（防止内存耗尽）
const MAX_LOG_ENTRIES = 200;
const MAX_LOG_LINE = 4000;
const MAX_CONTEXT_BYTES = 1024 * 1024;
const MAX_RESULT_BYTES = 1024 * 1024;

/**
 * 把上下文数据序列化为 JSON。
 * 函数 / Symbol 直接丢弃；BigInt 转字符串；无法序列化的结构抛错。
 * 这是切断宿主引用链的第一道工序。
 */
function serializeContext(context) {
  if (context === null || context === undefined) return '{}';
  try {
    const json = JSON.stringify(context, (key, value) => {
      if (typeof value === 'function' || typeof value === 'symbol') return undefined;
      if (typeof value === 'bigint') return value.toString();
      if (value instanceof Error) return { name: value.name, message: value.message };
      return value;
    });
    const serialized = json === undefined ? '{}' : json;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_CONTEXT_BYTES) {
      throw new Error(`沙箱上下文超过 ${MAX_CONTEXT_BYTES} 字节`);
    }
    return serialized;
  } catch (error) {
    throw new Error(`沙箱上下文包含无法序列化的数据：${error.message}`);
  }
}

/**
 * 创建一个锁定的 vm 上下文：
 *   - 独立 realm（不继承宿主全局）
 *   - 禁止从字符串生成代码
 *   - 沙箱内 console 只收集日志，不回调宿主函数
 */
function createLockedContext(fetchCapability) {
  const ctx = vm.createContext(Object.create(null), {
    name: SANDBOX_NAME,
    codeGeneration: { strings: false, wasm: false },
    // Promise callbacks are drained under runInContext's execution timeout.
    microtaskMode: 'afterEvaluate',
  });
  if (typeof fetchCapability === 'function') ctx.__sandboxHostFetch = fetchCapability;

  // 在沙箱内部引导：安装收集式 console。
  // 关键：绝不能把宿主 console 传进来 —— console.log.constructor.constructor
  // 同样可以拿到宿主 Function。
  const bootstrap = new vm.Script(`
    (function () {
      var logs = [];
      var MAX = ${MAX_LOG_ENTRIES};
      var MAXLEN = ${MAX_LOG_LINE};
      function record(level) {
        return function () {
          if (logs.length >= MAX) return;
          var parts = [];
          for (var i = 0; i < arguments.length; i++) {
            var v = arguments[i];
            var s;
            try { s = typeof v === 'string' ? v : JSON.stringify(v); }
            catch (e) { s = String(v); }
            if (typeof s !== 'string') s = String(v);
            parts.push(s.length > MAXLEN ? s.slice(0, MAXLEN) + '…' : s);
          }
          logs.push(level + ': ' + parts.join(' '));
        };
      }
      this.__sandboxLogs = logs;
      this.console = {
        log: record('log'),
        info: record('info'),
        warn: record('warn'),
        error: record('error'),
        debug: record('debug'),
      };
      if (typeof this.__sandboxHostFetch === 'function') {
        var hostFetch = this.__sandboxHostFetch;
        delete this.__sandboxHostFetch;
        this.fetch = function (url, init) {
          return new Promise(function (resolve, reject) {
            var initJson;
            try { initJson = JSON.stringify(init || {}); }
            catch (_) { reject(new Error('fetch options must be JSON data')); return; }
            hostFetch(String(url), initJson, function (error, responseJson) {
              if (error) { reject(new Error(String(error))); return; }
              var data;
              try { data = JSON.parse(responseJson); }
              catch (_) { reject(new Error('invalid fetch response')); return; }
              var responseHeaders = data.headers || {};
              resolve({
                ok: !!data.ok,
                status: Number(data.status) || 0,
                statusText: String(data.statusText || ''),
                url: String(data.url || url),
                headers: { get: function (name) {
                  var key = String(name).toLowerCase();
                  for (var headerName of Object.keys(responseHeaders)) {
                    if (headerName.toLowerCase() === key) return String(responseHeaders[headerName]);
                  }
                  return null;
                } },
                text: function () { return Promise.resolve(String(data.body || '')); },
                json: function () {
                  return Promise.resolve().then(function () { return JSON.parse(String(data.body || '')); });
                },
              });
            });
          });
        };
      }
      return true;
    })()
  `);
  bootstrap.runInContext(ctx);
  return ctx;
}

/**
 * 在沙箱中安全地执行一段同步 JavaScript 代码
 *
 * @param {string} code - 要执行的 JS 代码
 * @param {object} context - 向沙箱中注入的上下文变量（会经 JSON 往返重建）
 * @param {object} options
 * @param {number} options.timeout - 超时毫秒数（默认 5000）
 * @param {string} options.filename - 用于错误堆栈的文件名
 * @param {string[]} options.forbidden - 代码中不得出现的子串（快速拒绝）
 * @returns {Promise<any>}
 */
async function safeEval(code, context = {}, options = {}) {
  const { timeout = 5000 } = options;

  if (typeof code !== 'string' || !code.trim()) {
    throw new Error('沙箱代码不能为空');
  }

  // 快速拒绝明显的逃逸写法（纵深防御之一，不依赖它单独生效）
  const forbidden = options.forbidden || [
    'constructor.constructor',
    '.constructor(',
    '__proto__',
    'prototype.constructor',
  ];
  for (const needle of forbidden) {
    if (code.includes(needle)) {
      throw new Error(`沙箱代码包含被禁止的写法：${needle}`);
    }
  }

  const ctx = createLockedContext(options.fetchCapability);

  // 数据在沙箱内用 JSON.parse 重建；解析与复制都在有超时保护的 realm 内完成。
  const contextJson = serializeContext(context);
  ctx.__sandboxContextJson = contextJson;
  const seed = new vm.Script(`
    (() => {
      const data = JSON.parse(this.__sandboxContextJson);
      delete this.__sandboxContextJson;
      if (data && typeof data === 'object') {
        for (const key of Object.keys(data)) {
          if (key === 'console' || key.startsWith('__sandbox')) {
            throw new Error('沙箱上下文包含保留字段');
          }
          if (key === 'ctx' && data[key] && typeof data[key] === 'object'
              && typeof this.fetch === 'function') {
            data[key].fetch = this.fetch;
          }
          this[key] = data[key];
        }
      }
      return true;
    })()
  `);
  seed.runInContext(ctx, { timeout, breakOnSigint: true });

  // Capture the expression result inside the realm. Never inspect an untrusted
  // object, getter, thenable, or error from the host process.
  try {
    const script = new vm.Script(`this.__sandboxRawResult = (${code});`, {
      filename: options.filename || 'sandbox-eval.js',
      lineOffset: 0,
    });
    script.runInContext(ctx, { timeout, breakOnSigint: true });
  } catch (_) {
    throw new Error(`沙箱执行失败或超时（>${timeout}ms）`);
  }

  const finalize = new vm.Script(`
    (async () => {
      try {
        const result = await this.__sandboxRawResult;
        if (typeof result === 'function') {
          this.__sandboxOutput = JSON.stringify({ error: 'function_result' });
          return;
        }
        const serialized = JSON.stringify({ result });
        if (typeof serialized !== 'string' || serialized.length > ${MAX_RESULT_BYTES}) {
          this.__sandboxOutput = JSON.stringify({ error: 'result_too_large' });
          return;
        }
        this.__sandboxOutput = serialized;
      } catch (_) {
        this.__sandboxOutput = JSON.stringify({ error: 'execution_failed' });
      }
    })()
  `);
  try {
    finalize.runInContext(ctx, { timeout, breakOnSigint: true });
    // Poll from the host event loop so a sandboxed, capability-backed async
    // operation can finish. Every VM turn remains individually time-limited;
    // only a primitive JSON string crosses back into the host.
    const readOutput = new vm.Script(`typeof this.__sandboxOutput === 'string' ? this.__sandboxOutput : null`);
    const deadline = Date.now() + timeout;
    let outputText = null;
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      outputText = readOutput.runInContext(ctx, { timeout: remaining, breakOnSigint: true });
      if (typeof outputText === 'string') break;
      await new Promise(resolve => setTimeout(resolve, Math.min(5, remaining)));
    }
    if (typeof outputText !== 'string') {
      throw new Error(`沙箱执行超时或异步任务未在 ${timeout}ms 内结束`);
    }
    const output = JSON.parse(outputText);
    if (output.error === 'function_result') throw new Error('沙箱返回值不能是函数，请返回纯数据');
    if (output.error) throw new Error('沙箱返回值无法序列化或超过大小限制');
    return output.result;
  } catch (error) {
    if (error && error.message && error.message.startsWith('沙箱返回值')) throw error;
    if (error && error.message && error.message.startsWith('沙箱执行超时')) throw error;
    throw new Error(`沙箱执行失败或超时（>${timeout}ms）`);
  }
}

/**
 * 在沙箱中安全执行异步函数体
 */
async function safeExecuteAsync(code, context = {}, options = {}) {
  const wrappedCode = `(async function() { ${code} })()`;
  return safeEval(wrappedCode, context, options);
}

/**
 * 安全执行密钥刷新脚本
 *
 * 支持 async function(ctx) { ... } 格式；拒绝完整 Node 模块模式。
 */
async function safeExecuteKeyScript(scriptBody, ctx = {}, options = {}) {
  const { timeout = 10000 } = options;

  const isFullModule = scriptBody.includes('module.exports')
    || scriptBody.includes('require(')
    || scriptBody.includes('require (')
    || (/^\s*(const|let|var)\s+\w+\s*=\s*require\s*\(/m.test(scriptBody));

  if (isFullModule) {
    throw new Error(
      '安全沙箱不支持完整 Node.js 模块模式（require/module.exports）。'
      + '请使用 async function(ctx) { ... } 格式'
    );
  }

  let result;
  try {
    const code = `(async function(ctx) { ${scriptBody} })(ctx)`;
    result = await safeEval(code, { ctx }, { timeout, filename: 'key-script-async.js', fetchCapability: ctx.fetch });
  } catch (e1) {
    try {
      const code = `(function(ctx) { return (${scriptBody})(ctx); })(ctx)`;
      result = await safeEval(code, { ctx }, { timeout, filename: 'key-script-expr.js', fetchCapability: ctx.fetch });
    } catch (e2) {
      try {
        const code = `(function(ctx) { ${scriptBody} })(ctx)`;
        result = await safeEval(code, { ctx }, { timeout, filename: 'key-script-fn.js', fetchCapability: ctx.fetch });
      } catch (e3) {
        throw new Error(`密钥脚本执行失败: ${e3.message}`);
      }
    }
  }

  return result;
}

module.exports = {
  safeEval,
  safeExecuteAsync,
  safeExecuteKeyScript,
};
