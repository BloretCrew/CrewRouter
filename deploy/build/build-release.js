/**
 * 完整构建流水线
 *
 * 执行顺序：bundle → obfuscate → package
 * 产物在 dist/ 目录中
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DIST = path.join(ROOT, 'dist');

function run(cmd, opts = {}) {
  console.log(`\n[build] $ ${cmd}`);
  execSync(cmd, { cwd: ROOT, stdio: 'inherit', ...opts });
}

/** 混淆步骤需要更大调用栈，避免 javascript-obfuscator 栈溢出 */
function runObfuscate() {
  const cmd = 'node --stack-size=65500 deploy/build/obfuscate.js';
  console.log(`\n[build] $ ${cmd}`);
  execSync(cmd, { cwd: ROOT, stdio: 'inherit' });
}

function copyDir(src, dest) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

async function build() {
  const startTime = Date.now();
  const mode = process.argv[2] || 'release'; // 'release' | 'saas'

  console.log(`[build] 构建模式: ${mode}`);
  console.log(`[build] 目标目录: ${DIST}`);

  // 清理 dist/
  if (fs.existsSync(DIST)) {
    fs.rmSync(DIST, { recursive: true });
  }
  fs.mkdirSync(DIST, { recursive: true });

  // Step 1: esbuild 打包（脚本位于 deploy/build/，cwd 为项目根目录）
  console.log('\n=== Step 1: esbuild 打包 ===');
  run('node deploy/build/bundle.js');

  // Step 2: 混淆（仅 release 模式）
  if (mode === 'release') {
    console.log('\n=== Step 2: 代码混淆 ===');
    runObfuscate();

    // 使用混淆后的版本作为最终入口
    const obfFile = path.join(DIST, 'server.obf.js');
    const finalFile = path.join(DIST, 'server.js');
    if (fs.existsSync(obfFile)) {
      fs.unlinkSync(finalFile);
      fs.renameSync(obfFile, finalFile);
      console.log('[build] 已将混淆版本设为最终入口');
    }
  } else {
    console.log('\n=== Step 2: 跳过混淆（SaaS 模式） ===');
    // SaaS 模式使用压缩版本
    runObfuscate();
    const minFile = path.join(DIST, 'server.min.js');
    const finalFile = path.join(DIST, 'server.js');
    if (fs.existsSync(minFile)) {
      fs.unlinkSync(finalFile);
      fs.renameSync(minFile, finalFile);
      console.log('[build] 已将压缩版本设为最终入口');
    }
  }

  // Step 3: 复制静态资源
  console.log('\n=== Step 3: 复制静态资源 ===');
  const publicSrc = path.join(ROOT, 'public');
  const publicDest = path.join(DIST, 'public');
  copyDir(publicSrc, publicDest);
  console.log(`[build] 已复制 public/ → dist/public/`);

  // Step 3.5: 复制 i18n 语言目录（服务端磁盘回退用）
  const langSrc = path.join(ROOT, 'lang');
  if (fs.existsSync(langSrc)) {
    const langDest = path.join(DIST, 'lang');
    fs.rmSync(langDest, { recursive: true, force: true });
    copyDir(langSrc, langDest);
    console.log(`[build] 已复制 lang/ → dist/lang/`);
  }

  // Step 4: 生成精简的 package.json（仅生产依赖）
  console.log('\n=== Step 4: 生成生产 package.json ===');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const prodPkg = {
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    main: 'server.js',
    scripts: {
      start: 'node server.js',
    },
    dependencies: pkg.dependencies,
    engines: pkg.engines,
  };
  fs.writeFileSync(path.join(DIST, 'package.json'), JSON.stringify(prodPkg, null, 2));
  console.log('[build] 已生成 dist/package.json');

  // Step 5: 复制 config 模板
  console.log('\n=== Step 5: 复制配置文件 ===');
  const exampleSrc = path.join(ROOT, 'config.example.json');
  fs.copyFileSync(exampleSrc, path.join(DIST, 'config.example.json'));

  // Step 6: 清理临时文件
  console.log('\n=== Step 6: 清理 ===');
  const tempFiles = ['metafile.json', 'server.obf.js', 'server.min.js'];
  for (const f of tempFiles) {
    const fp = path.join(DIST, f);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }

  // 统计
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  const distSize = getDirSize(DIST);
  console.log(`\n[build] 构建完成！`);
  console.log(`[build] 模式: ${mode}`);
  console.log(`[build] 耗时: ${duration}s`);
  console.log(`[build] 产物大小: ${(distSize / 1024 / 1024).toFixed(2)} MB`);
  console.log(`[build] 输出目录: ${DIST}`);
}

function getDirSize(dir) {
  let size = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      size += getDirSize(fp);
    } else {
      size += fs.statSync(fp).size;
    }
  }
  return size;
}

build().catch(err => {
  console.error('[build] 构建失败:', err);
  process.exit(1);
});
