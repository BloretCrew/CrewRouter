/**
 * esbuild 打包脚本
 *
 * 将 server/ 目录下所有代码打包为单个 dist/server.js
 * 消除文件结构，为后续混淆做准备
 */

const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, 'dist');
const OUT_FILE = path.join(OUT_DIR, 'server.js');

async function bundle() {
  console.log(`[bundle] 开始打包 server/ ...`);

  // 确保输出目录存在
  if (!fs.existsSync(OUT_DIR)) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  }

  // 所有 npm 依赖都作为外部模块：
  // 1) 运行时仍由 node_modules 提供（Docker 会 npm install --omit=dev）
  // 2) 打包产物只含业务代码，体积小，后续混淆才能稳定完成
  // 3) 避免把第三方库一起混淆导致栈溢出与兼容性问题
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const depNames = [
    ...Object.keys(packageJson.dependencies || {}),
    ...Object.keys(packageJson.devDependencies || {}),
  ];
  // 同时排除子路径 require（如 'uuid/v4'）与 node 内置
  const externalModules = [
    ...depNames,
    ...depNames.map((name) => `${name}/*`),
    // 忽略前端静态文件
    '../public/*',
    '../../public/*',
  ];

  try {
    const result = await esbuild.build({
      entryPoints: [path.join(ROOT, 'server', 'index.js')],
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'cjs',
      outfile: OUT_FILE,
      // packages: 'external' 让所有 node_modules 保持 require()，不打进产物
      packages: 'external',
      external: externalModules,
      // 解析 config-loader 中的动态 require
      resolveExtensions: ['.js', '.json'],
      banner: {
        js: `// CrewRouter - Built Release\n// This file is auto-generated and obfuscated. Do not modify.`,
      },
      minify: false, // 混淆步骤单独处理
      sourcemap: false,
      metafile: true,
      logLevel: 'info',
    });

    // 输出打包统计
    const text = await esbuild.analyzeMetafile(result.metafile);
    console.log('[bundle] 打包完成');

    // 保存打包信息
    fs.writeFileSync(
      path.join(OUT_DIR, 'metafile.json'),
      JSON.stringify(result.metafile, null, 2)
    );

    console.log(`[bundle] 输出: ${OUT_FILE}`);
    console.log(`[bundle] 文件大小: ${(fs.statSync(OUT_FILE).size / 1024).toFixed(1)} KB`);

  } catch (err) {
    console.error('[bundle] 打包失败:', err.message);
    process.exit(1);
  }
}

bundle();
