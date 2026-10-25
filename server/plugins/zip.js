/**
 * 插件 zip 处理共享工具
 *
 * 供「上传安装」（routes/plugins.js upload）与「从商店安装」（install-from-store）
 * 复用。先检查 ZIP central directory 和本地文件头，再用受限的 Node zlib 解压。
 */

const path = require('path');
const fs = require('fs');
const { TextDecoder } = require('util');
const zlib = require('zlib');

const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 1000;
const MAX_ENTRY_BYTES = 40 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_PATH_BYTES = 1024;
const MAX_PATH_DEPTH = 32;
const MAX_EXTRACTED_ENTRIES = 5000;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  return crc >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function validateExtraFields(archive, start, length, name) {
  const end = start + length;
  let cursor = start;
  while (cursor < end) {
    if (cursor + 4 > end) throw new Error(`zip 扩展字段损坏: ${name}`);
    const fieldId = archive.readUInt16LE(cursor);
    const fieldLength = archive.readUInt16LE(cursor + 2);
    cursor += 4;
    if (cursor + fieldLength > end) throw new Error(`zip 扩展字段长度不合法: ${name}`);
    // 防止解压器采用不同于已校验文件名的 Unicode 路径或 ASi Unix 链接目标。
    if (fieldId === 0x0001 || fieldId === 0x7075 || fieldId === 0x756e) {
      throw new Error(`zip 包含不支持的路径或 Unix 扩展字段: ${name}`);
    }
    cursor += fieldLength;
  }
}

function readZipDirectory(zipPath) {
  let archive;
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const fd = fs.openSync(zipPath, fs.constants.O_RDONLY | noFollow);
  try {
    const archiveStat = fs.fstatSync(fd);
    if (!archiveStat.isFile() || archiveStat.size > MAX_ARCHIVE_BYTES) {
      throw new Error('zip 文件类型或压缩文件大小不符合限制');
    }
    archive = fs.readFileSync(fd);
    if (archive.length !== archiveStat.size) throw new Error('zip 文件在读取过程中发生变化');
  } finally {
    fs.closeSync(fd);
  }
  if (archive.length < 22) throw new Error('zip 文件格式不完整');

  // EOCD 只能位于最后 22 + 65535 字节；要求注释长度与文件尾严格吻合。
  const minEocdOffset = Math.max(0, archive.length - 22 - 0xffff);
  let eocdOffset = -1;
  for (let offset = archive.length - 22; offset >= minEocdOffset; offset--) {
    if (archive.readUInt32LE(offset) !== 0x06054b50) continue;
    const commentLength = archive.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === archive.length) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error('zip 缺少有效的结束目录');

  const diskNumber = archive.readUInt16LE(eocdOffset + 4);
  const centralDisk = archive.readUInt16LE(eocdOffset + 6);
  const entriesOnDisk = archive.readUInt16LE(eocdOffset + 8);
  const entryCount = archive.readUInt16LE(eocdOffset + 10);
  const centralSize = archive.readUInt32LE(eocdOffset + 12);
  const centralOffset = archive.readUInt32LE(eocdOffset + 16);
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new Error('不支持分卷 zip 包');
  }
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error('不支持 ZIP64 格式');
  }
  if (entryCount === 0) throw new Error('zip 包为空');
  if (entryCount > MAX_ENTRIES) throw new Error('zip 包条目过多');
  if (centralOffset + centralSize !== eocdOffset || centralOffset > archive.length) {
    throw new Error('zip central directory 边界不合法');
  }

  const entries = [];
  const entryTypes = new Map();
  let totalUncompressed = 0;
  let cursor = centralOffset;

  for (let i = 0; i < entryCount; i++) {
    if (cursor + 46 > eocdOffset || archive.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('zip central directory 条目损坏');
    }
    const madeBy = archive.readUInt16LE(cursor + 4);
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const diskStart = archive.readUInt16LE(cursor + 34);
    const externalAttributes = archive.readUInt32LE(cursor + 38);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const recordEnd = cursor + 46 + nameLength + extraLength + commentLength;
    if (recordEnd > eocdOffset || nameLength === 0) throw new Error('zip central directory 条目长度不合法');
    if (diskStart !== 0) throw new Error('不支持分卷 zip 包');
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error('不支持 ZIP64 格式');
    }
    if ((flags & (0x0001 | 0x0020 | 0x0040 | 0x2000)) !== 0) {
      throw new Error('不支持加密或补丁式 zip 条目');
    }
    if (method !== 0 && method !== 8) throw new Error('zip 使用了不支持的压缩算法');
    if (compressedSize > MAX_ARCHIVE_BYTES || uncompressedSize > MAX_ENTRY_BYTES) {
      throw new Error('zip 单个文件超过大小限制');
    }
    if (method === 0 && compressedSize !== uncompressedSize) {
      throw new Error('zip 存储条目的大小信息不一致');
    }
    if (method === 0 && compressedSize === 0 && uncompressedSize !== 0) {
      throw new Error('zip 条目大小信息不合法');
    }
    totalUncompressed += uncompressedSize;
    if (!Number.isSafeInteger(totalUncompressed) || totalUncompressed > MAX_TOTAL_BYTES) {
      throw new Error('zip 解压后总大小超过限制');
    }

    const rawName = archive.subarray(cursor + 46, cursor + 46 + nameLength);
    let name;
    try {
      name = UTF8_DECODER.decode(rawName);
    } catch {
      throw new Error('zip 文件名必须是有效 UTF-8');
    }
    if (!(flags & 0x0800) && rawName.some(byte => byte > 0x7f)) {
      throw new Error('zip 非 ASCII 文件名必须标记为 UTF-8');
    }
    if (Buffer.byteLength(name, 'utf8') > MAX_PATH_BYTES || /[\u0000-\u001f\u007f]/.test(name)) {
      throw new Error('zip 文件名长度或字符不合法');
    }
    if (name.includes('\\') || name.includes(':') || path.isAbsolute(name) || /^[a-z]:/i.test(name)) {
      throw new Error(`非法条目路径: ${name}`);
    }
    validateExtraFields(archive, cursor + 46 + nameLength, extraLength, name);

    const hostOS = madeBy >>> 8;
    const unixMode = externalAttributes >>> 16;
    const unixType = unixMode & 0o170000;
    if ((hostOS === 3 || hostOS === 19) && unixType !== 0 && unixType !== 0o100000 && unixType !== 0o040000) {
      throw new Error(`zip 包含符号链接或特殊文件: ${name}`);
    }
    if (externalAttributes & 0x00000400) {
      throw new Error(`zip 包含重解析点或链接文件: ${name}`);
    }

    const hasTrailingSlash = name.endsWith('/');
    const isUnixDirectory = (hostOS === 3 || hostOS === 19) && unixType === 0o040000;
    const isDosDirectory = hostOS === 0 && (externalAttributes & 0x10) !== 0;
    const isDirectory = hasTrailingSlash || isUnixDirectory || isDosDirectory;
    if ((isDirectory && !hasTrailingSlash) || (unixType === 0o100000 && hasTrailingSlash)) {
      throw new Error(`zip 文件类型与路径不一致: ${name}`);
    }
    const normalizedName = hasTrailingSlash ? name.slice(0, -1) : name;
    const parts = normalizedName.split('/');
    if (!normalizedName || parts.length > MAX_PATH_DEPTH || parts.some(part => !part || part === '.' || part === '..' || Buffer.byteLength(part, 'utf8') > 255)) {
      throw new Error(`非法条目路径: ${name}`);
    }
    if (isDirectory && (compressedSize !== 0 || uncompressedSize !== 0 || archive.readUInt32LE(cursor + 16) !== 0)) {
      throw new Error(`zip 目录条目不得携带文件数据: ${name}`);
    }
    if (entryTypes.has(normalizedName)) throw new Error(`zip 包含重复路径: ${name}`);

    for (let j = 1; j < parts.length; j++) {
      const parent = parts.slice(0, j).join('/');
      if (entryTypes.get(parent) === 'file') throw new Error(`zip 文件路径与目录冲突: ${name}`);
    }
    if (!isDirectory) {
      for (const existing of entryTypes.keys()) {
        if (existing.startsWith(normalizedName + '/')) throw new Error(`zip 文件路径与目录冲突: ${name}`);
      }
    }
    entryTypes.set(normalizedName, isDirectory ? 'directory' : 'file');

    if (localOffset + 30 > centralOffset || archive.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`zip 本地文件头损坏: ${name}`);
    }
    const localFlags = archive.readUInt16LE(localOffset + 6);
    const localMethod = archive.readUInt16LE(localOffset + 8);
    const localCrc = archive.readUInt32LE(localOffset + 14);
    const localCompressedSize = archive.readUInt32LE(localOffset + 18);
    const localUncompressedSize = archive.readUInt32LE(localOffset + 22);
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const localNameStart = localOffset + 30;
    const dataStart = localNameStart + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    const hasDataDescriptor = (flags & 0x0008) !== 0;
    if (localFlags !== flags || localMethod !== method || localNameLength !== rawName.length ||
        localCompressedSize === 0xffffffff || localUncompressedSize === 0xffffffff ||
        (!hasDataDescriptor && (localCrc !== archive.readUInt32LE(cursor + 16) ||
          localCompressedSize !== compressedSize || localUncompressedSize !== uncompressedSize)) ||
        (hasDataDescriptor && ((localCrc !== 0 && localCrc !== archive.readUInt32LE(cursor + 16)) ||
          (localCompressedSize !== 0 && localCompressedSize !== compressedSize) ||
          (localUncompressedSize !== 0 && localUncompressedSize !== uncompressedSize))) ||
        dataStart > centralOffset || dataEnd > centralOffset ||
        !archive.subarray(localNameStart, localNameStart + localNameLength).equals(rawName)) {
      throw new Error(`zip 本地文件头与 central directory 不一致: ${name}`);
    }
    validateExtraFields(archive, localNameStart + localNameLength, localExtraLength, name);

    entries.push({
      name: normalizedName,
      isDirectory,
      method,
      size: uncompressedSize,
      crc32: archive.readUInt32LE(cursor + 16),
      localOffset,
      dataStart,
      dataEnd,
    });
    cursor = recordEnd;
  }
  if (cursor !== centralOffset + centralSize) throw new Error('zip central directory 长度不匹配');

  const byOffset = [...entries].sort((a, b) => a.localOffset - b.localOffset);
  for (let i = 1; i < byOffset.length; i++) {
    if (byOffset[i].localOffset < byOffset[i - 1].dataEnd) {
      throw new Error('zip 条目数据区域重叠');
    }
  }
  return { archive, entries };
}

function inflateRawBounded(data, maxOutputLength) {
  return new Promise((resolve, reject) => {
    zlib.inflateRaw(data, { maxOutputLength }, (err, result) => {
      if (err) return reject(new Error('zip deflate 数据无效或超出解压限制'));
      resolve(result);
    });
  });
}

async function readZipEntryData(archive, entry, maxBytes = MAX_ENTRY_BYTES) {
  if (!entry || entry.isDirectory || entry.size > maxBytes) throw new Error('zip 文件超过读取大小限制');
  const compressedData = archive.subarray(entry.dataStart, entry.dataEnd);
  const data = entry.method === 0
    ? compressedData
    : await inflateRawBounded(compressedData, Math.max(1, entry.size + 1));
  if (data.length !== entry.size || crc32(data) !== entry.crc32) {
    throw new Error(`zip 文件数据校验失败: ${entry.name}`);
  }
  return data;
}

async function readZipManifest(zipPath, pluginId) {
  try {
    const { archive, entries } = readZipDirectory(zipPath);
    const target = entries.find(entry => entry.name === 'plugin.json' && !entry.isDirectory)
      || entries.find(entry => entry.name === `${pluginId}/plugin.json` && !entry.isDirectory)
      || entries.find(entry => /(^|\/)plugin\.json$/.test(entry.name) && !entry.isDirectory);
    if (!target) return null;
    const data = await readZipEntryData(archive, target, MAX_MANIFEST_BYTES);
    return JSON.parse(UTF8_DECODER.decode(data));
  } catch {
    return null;
  }
}

function inspectExtractedTree(rootDir, expectedEntries) {
  const rootStat = fs.lstatSync(rootDir);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('解压目标必须是普通目录');
  let entryCount = 0;
  let totalBytes = 0;
  const expectedFiles = new Map(expectedEntries.filter(entry => !entry.isDirectory).map(entry => [entry.name, entry.size]));
  const extractedFiles = new Set();

  const walk = (dir, relativeDir = '') => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const relativePath = relativeDir ? `${relativeDir}/${name}` : name;
      const stat = fs.lstatSync(full);
      entryCount++;
      if (entryCount > MAX_EXTRACTED_ENTRIES) throw new Error('解压后的文件与目录数量超过限制');
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        throw new Error(`解压结果包含链接或特殊文件: ${path.relative(rootDir, full)}`);
      }
      if (stat.isDirectory()) {
        fs.chmodSync(full, 0o755);
        walk(full, relativePath);
      } else {
        totalBytes += stat.size;
        if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_TOTAL_BYTES) {
          throw new Error('解压后总大小超过限制');
        }
        if (stat.nlink > 1) throw new Error(`解压结果包含硬链接: ${path.relative(rootDir, full)}`);
        if (!expectedFiles.has(relativePath) || expectedFiles.get(relativePath) !== stat.size) {
          throw new Error(`解压结果与 zip 目录不一致: ${relativePath}`);
        }
        // 不保留 ZIP 中可能携带的 setuid/setgid、可写或异常执行权限。
        fs.chmodSync(full, 0o644);
        extractedFiles.add(relativePath);
      }
    }
  };
  walk(rootDir);
  if (extractedFiles.size !== expectedFiles.size) throw new Error('zip 中部分文件未能完整解压');
}

// 解压前拒绝路径穿越、链接/特殊文件、重复路径和 ZIP bomb；仅写普通文件与目录。
async function extractZipSafe(zipPath, destDir) {
  const { archive, entries } = readZipDirectory(zipPath);
  try {
    const stat = fs.lstatSync(destDir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.readdirSync(destDir).length !== 0) {
      throw new Error('解压目标必须是空的普通目录');
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    fs.mkdirSync(destDir, { recursive: false, mode: 0o700 });
  }

  for (const entry of entries) {
    const target = path.join(destDir, ...entry.name.split('/'));
    if (entry.isDirectory) {
      fs.mkdirSync(target, { recursive: true, mode: 0o700 });
      continue;
    }

    const parent = path.dirname(target);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    const data = await readZipEntryData(archive, entry);
    fs.writeFileSync(target, data, { flag: 'wx', mode: 0o644 });
  }

  inspectExtractedTree(destDir, entries);
  return destDir;
}

// 找到解压目录中合法的 plugin.json；支持根即清单或 <id>/plugin.json 两种布局
function findZipManifest(tmpDir) {
  const tryRead = (dir) => {
    const p = path.join(dir, 'plugin.json');
    if (!fs.existsSync(p)) return null;
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch { return null; }
  };
  const rootManifest = tryRead(tmpDir);
  if (rootManifest) return rootManifest;
  const dirs = fs.readdirSync(tmpDir).filter(name => !name.startsWith('.'));
  for (const name of dirs) {
    const full = path.join(tmpDir, name);
    if (!fs.statSync(full).isDirectory()) continue;
    const m = tryRead(full);
    if (m) return m;
  }
  return null;
}

// 返回实际插件载荷目录：清单 id 匹配的目录，或根即清单时的根
function zipPayloadDir(tmpDir, id) {
  const rootManifest = path.join(tmpDir, 'plugin.json');
  if (fs.existsSync(rootManifest)) return tmpDir;
  const dirs = fs.readdirSync(tmpDir).filter(name => !name.startsWith('.'));
  for (const name of dirs) {
    const full = path.join(tmpDir, name);
    if (!fs.statSync(full).isDirectory()) continue;
    if (name === id && fs.existsSync(path.join(full, 'plugin.json'))) return full;
  }
  // 仅一个目录且含 plugin.json 时容错（目录名与 id 不一致时以清单 id 为准）
  const validDirs = dirs.filter(name => fs.existsSync(path.join(tmpDir, name, 'plugin.json')) && fs.statSync(path.join(tmpDir, name)).isDirectory());
  if (validDirs.length === 1) return path.join(tmpDir, validDirs[0]);
  return null;
}

// 收集目录下全部相对路径（拒绝链接与特殊文件）
function collectDirEntries(dir) {
  const out = [];
  const walk = (cur, rel) => {
    for (const name of fs.readdirSync(cur)) {
      const full = path.join(cur, name);
      const relPath = rel ? path.join(rel, name) : name;
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile())) {
        throw new Error(`插件目录包含链接或特殊文件: ${relPath}`);
      }
      out.push(relPath);
      if (st.isDirectory()) walk(full, relPath);
    }
  };
  walk(dir, '');
  return out;
}

module.exports = { extractZipSafe, readZipManifest, findZipManifest, zipPayloadDir, collectDirEntries };
