/**
 * 代码混淆脚本
 *
 * 对 esbuild 打包后的 dist/server.js 进行深度混淆
 * 使用 javascript-obfuscator 的高强度配置
 */

const JavaScriptObfuscator = require('javascript-obfuscator');
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', '..', 'dist');
const INPUT_FILE = path.join(OUT_DIR, 'server.js');
const OUTPUT_FILE = path.join(OUT_DIR, 'server.obf.js');
const OUTPUT_MIN_FILE = path.join(OUT_DIR, 'server.min.js');

// 混淆配置（稳定可构建）
//
// 踩坑记录：
// 1) reservedStrings 使用 '.*require.*' / '.*module.*' 会在大文件上
//    触发 Maximum call stack size exceeded（正则过宽 + 大量字符串匹配）。
// 2) controlFlowFlattening + deadCodeInjection + transformObjectKeys 叠加
//    在 ~800KB 产物上易 SIGSEGV / 栈溢出。
// 3) debugProtection / selfDefending 不适合 Node 服务端（干扰进程与健康检查）。
//
// 策略：压缩 + 十六进制标识符 + base64 字符串数组 + 中等控制流扁平化。
const OBFUSCATION_OPTIONS = {
  compact: true,

  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.5,

  deadCodeInjection: false,
  debugProtection: false,
  disableConsoleOutput: false,

  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,
  renameProperties: false,

  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 0.75,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayIndexShift: true,

  selfDefending: false,
  numbersToExpressions: true,
  simplify: true,
  splitStrings: true,
  splitStringsChunkLength: 10,
  transformObjectKeys: false,
  unicodeEscapeSequence: false,

  // 仅保留标识符白名单；不要用过宽的 reservedStrings 正则
  reservedNames: ['require', 'module', 'exports', '__dirname', '__filename'],
  target: 'node',
};

async function obfuscate() {
  console.log('[obfuscate] 开始混淆 ...');

  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`[obfuscate] 输入文件不存在: ${INPUT_FILE}`);
    console.error('[obfuscate] 请先运行 deploy/build/bundle.js');
    process.exit(1);
  }

  const inputCode = fs.readFileSync(INPUT_FILE, 'utf8');
  console.log(`[obfuscate] 输入文件大小: ${(inputCode.length / 1024).toFixed(1)} KB`);

  try {
    const result = JavaScriptObfuscator.obfuscate(inputCode, OBFUSCATION_OPTIONS);
    const obfuscatedCode = result.getObfuscatedCode();

    fs.writeFileSync(OUTPUT_FILE, obfuscatedCode, 'utf8');
    console.log(`[obfuscate] 混淆完成: ${OUTPUT_FILE}`);
    console.log(`[obfuscate] 输出文件大小: ${(obfuscatedCode.length / 1024).toFixed(1)} KB`);
    console.log(`[obfuscate] 膨胀倍数: ${(obfuscatedCode.length / inputCode.length).toFixed(1)}x`);

    // 同时生成一份仅压缩不混淆的版本（用于调试或 SaaS 模式）
    const minResult = JavaScriptObfuscator.obfuscate(inputCode, {
      compact: true,
      controlFlowFlattening: false,
      deadCodeInjection: false,
      stringArray: false,
      renameGlobals: false,
      renameProperties: false,
      selfDefending: false,
      unicodeEscapeSequence: false,
    });
    fs.writeFileSync(OUTPUT_MIN_FILE, minResult.getObfuscatedCode(), 'utf8');
    console.log(`[obfuscate] 压缩版: ${OUTPUT_MIN_FILE} (${(minResult.getObfuscatedCode().length / 1024).toFixed(1)} KB)`);

  } catch (err) {
    console.error('[obfuscate] 混淆失败:', err.message);
    process.exit(1);
  }
}

obfuscate();
