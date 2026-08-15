/**
 * 安全沙箱模块
 *
 * 使用 Node.js `vm` 模块替代 `new Function`，在隔离的上下文中执行用户脚本，
 * 防止直接访问全局对象、require、process 等敏感 API。
 *
 * 注意：vm 模块并非绝对安全的沙箱（存在已知的 sandbox escape 漏洞），
 * 但比 `new Function` 安全得多。对于高安全场景应考虑 isolated-vm 等第三方方案。
 */

const vm = require('vm');

// 允许在沙箱中使用的安全全局白名单
const SAFE_GLOBALS = new Set([
  // 基础类型
  'Object', 'Array', 'String', 'Number', 'Boolean',
  'Map', 'Set', 'WeakMap', 'WeakSet',
  'Promise', 'Symbol', 'BigInt',
  // 错误类型
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError',
  'EvalError', 'URIError',
  // 工具
  'Date', 'Math', 'JSON', 'RegExp',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'encodeURI', 'encodeURIComponent', 'decodeURI', 'decodeURIComponent',
  'escape', 'unescape',
  // 常量
  'Infinity', 'NaN', 'undefined', 'null',
  // 控制台（只读访问，限制功能）
  'console',
]);

/**
 * 在沙箱中安全地执行一段同步 JavaScript 代码
 *
 * @param {string} code - 要执行的 JS 代码
 * @param {object} context - 向沙箱中注入的上下文变量
 * @param {object} options
 * @param {number} options.timeout - 超时毫秒数（默认 5000）
 * @param {string} options.filename - 用于错误堆栈的文件名
 * @returns {Promise<any>} 执行结果
 */
async function safeEval(code, context = {}, options = {}) {
  const { timeout = 5000 } = options;

  // 构建沙箱对象：注入自定义上下文 + 安全全局白名单
  const sandbox = { ...context };

  // 禁用危险全局变量
  sandbox.global = undefined;
  sandbox.globalThis = undefined;
  sandbox.process = undefined;
  sandbox.require = undefined;
  sandbox.module = undefined;
  sandbox.exports = undefined;
  sandbox.__dirname = undefined;
  sandbox.__filename = undefined;
  sandbox.Buffer = undefined;
  sandbox.setTimeout = undefined;
  sandbox.setInterval = undefined;
  sandbox.setImmediate = undefined;
  sandbox.clearTimeout = undefined;
  sandbox.clearInterval = undefined;
  sandbox.clearImmediate = undefined;
  sandbox.queueMicrotask = undefined;
  sandbox.WeakRef = undefined;
  sandbox.FinalizationRegistry = undefined;

  // 注入安全的全局对象
  for (const name of SAFE_GLOBALS) {
    if (sandbox[name] === undefined && global[name] !== undefined) {
      sandbox[name] = global[name];
    }
  }

  // console 做安全包装，防止篡改
  if (sandbox.console === undefined || sandbox.console === global.console) {
    const safeConsole = {};
    const safeMethods = ['log', 'warn', 'error', 'info', 'debug'];
    for (const method of safeMethods) {
      if (typeof console[method] === 'function') {
        safeConsole[method] = console[method].bind(console);
      }
    }
    sandbox.console = safeConsole;
  }

  try {
    const script = new vm.Script(code, {
      filename: options.filename || 'sandbox-eval.js',
      lineOffset: 0,
    });

    const result = script.runInNewContext(sandbox, {
      timeout,
      breakOnSigint: true,
    });

    return result;
  } catch (err) {
    // 包装错误，提供友好的错误信息
    if (err instanceof vm.Script['createContext']().constructor) {
      // 不是标准错误路径，直接抛
      throw err;
    }
    throw err;
  }
}

/**
 * 在沙箱中安全执行异步函数体
 *
 * 将 code 包装为 async function() { ... } 并执行
 *
 * @param {string} code - 函数体代码
 * @param {object} context - 注入的上下文变量
 * @param {object} options
 * @param {number} options.timeout - 超时毫秒数（默认 5000）
 * @returns {Promise<any>}
 */
async function safeExecuteAsync(code, context = {}, options = {}) {
  const wrappedCode = `(async function() { ${code} })()`;
  return safeEval(wrappedCode, context, options);
}

/**
 * 安全执行密钥刷新脚本
 *
 * 专门用于 key-refresher，支持 async function(ctx) { ... } 格式
 * 不支持完整 Node.js 模块模式（require/module.exports）
 *
 * @param {string} scriptBody - 脚本代码
 * @param {object} ctx - 上下文 { baseUrl, providerId, providerName, currentKey }
 * @param {object} options
 * @returns {Promise<{key: string, expiresIn?: number}>}
 */
async function safeExecuteKeyScript(scriptBody, ctx = {}, options = {}) {
  const { timeout = 10000 } = options;

  // 检查是否为完整模块模式 —— 此模式不安全，拒绝执行
  const isFullModule = scriptBody.includes('module.exports')
    || scriptBody.includes('require(')
    || scriptBody.includes('require (')
    || (/^\s*(const|let|var)\s+\w+\s*=\s*require\s*\(/m.test(scriptBody));

  if (isFullModule) {
    throw new Error(
      '安全沙箱不支持完整 Node.js 模块模式（require/module.exports）。' +
      '请使用 async function(ctx) { ... } 格式'
    );
  }

  // 尝试多种执行方式
  let result;

  // 1. 尝试作为 async function 体执行
  try {
    const code = `(async function(ctx) { ${scriptBody} })(ctx)`;
    result = await safeEval(code, { ctx }, { timeout, filename: 'key-script-async.js' });
  } catch (e1) {
    // 2. 尝试作为箭头函数或表达式执行
    try {
      const code = `(function(ctx) { return (${scriptBody})(ctx); })(ctx)`;
      result = await safeEval(code, { ctx }, { timeout, filename: 'key-script-expr.js' });
    } catch (e2) {
      // 3. 如果语法错误，尝试作为简单函数执行
      try {
        const code = `(function(ctx) { ${scriptBody} })(ctx)`;
        result = await safeEval(code, { ctx }, { timeout, filename: 'key-script-fn.js' });
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
