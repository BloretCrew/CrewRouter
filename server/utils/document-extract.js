'use strict';

/**
 * 将上传的文档提取为纯文本。只支持文本型 PDF、DOCX、XLSX 与常见文本格式；
 * 旧版 .doc/.xls 与扫描版 PDF 明确拒绝或标记。
 */

const MAX_EXTRACTED_CHARS = 120000;
const MAX_PDF_PAGES = 100;
const MAX_XLSX_SHEETS = 20;
const MAX_XLSX_ROWS = 5000;
const MAX_XLSX_COLS = 200;
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.csv', '.json', '.yaml', '.yml', '.log']);
const TEXT_MIMES = new Set([
  'text/plain', 'text/markdown', 'text/csv', 'application/json',
  'application/yaml', 'application/x-yaml', 'text/yaml'
]);

class ExtractError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function startsWith(buffer, signature) {
  if (buffer.length < signature.length) return false;
  return signature.every((byte, index) => buffer[index] === byte);
}

function sniffImageMime(buffer) {
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47])) return 'image/png';
  if (startsWith(buffer, [0xff, 0xd8])) return 'image/jpeg';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF'
      && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buffer.toString('ascii', 0, 6) === 'GIF87a' || buffer.toString('ascii', 0, 6) === 'GIF89a') return 'image/gif';
  return '';
}

function isZip(buffer) {
  return startsWith(buffer, [0x50, 0x4b, 0x03, 0x04])
    || startsWith(buffer, [0x50, 0x4b, 0x05, 0x06])
    || startsWith(buffer, [0x50, 0x4b, 0x07, 0x08]);
}

function decodeText(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return null;
  const withoutBom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
    ? buffer.subarray(3) : buffer;
  if (withoutBom.includes(0)) return null;
  const decoders = ['utf-8', 'gb18030'];
  for (const encoding of decoders) {
    try {
      const text = new TextDecoder(encoding, { fatal: true }).decode(withoutBom);
      return text.replace(/\r\n?/g, '\n');
    } catch (_) { /* 尝试下一个编码 */ }
  }
  return null;
}

function limitText(text) {
  const normalized = String(text || '').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
  if (normalized.length <= MAX_EXTRACTED_CHARS) {
    return { text: normalized, truncated: false };
  }
  return { text: normalized.slice(0, MAX_EXTRACTED_CHARS), truncated: true };
}

async function extractPdfText(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const document = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    useWorkerFetch: false,
    verbosity: 0
  }).promise;
  try {
    const pages = [];
    const warnings = [];
    const total = Math.min(document.numPages, MAX_PDF_PAGES);
    if (document.numPages > MAX_PDF_PAGES) warnings.push('page_limit');
    for (let pageNumber = 1; pageNumber <= total; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .map(item => (item && typeof item.str === 'string' ? item.str : ''))
        .filter(Boolean)
        .join(' ');
      pages.push(text);
      page.cleanup();
    }
    const joined = pages.join('\n\n').trim();
    if (joined.length < 20) warnings.push('scanned_pdf');
    return { text: joined, warnings, meta: { pages: document.numPages } };
  } finally {
    await document.destroy();
  }
}

async function extractDocxText(buffer) {
  const mammoth = require('mammoth');
  const result = await mammoth.extractRawText({ buffer });
  return {
    text: result.value || '',
    warnings: Array.isArray(result.messages) && result.messages.length ? ['docx_warnings'] : [],
    meta: {}
  };
}

async function extractXlsxText(buffer) {
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const lines = [];
  const warnings = [];
  const sheets = workbook.worksheets.slice(0, MAX_XLSX_SHEETS);
  if (workbook.worksheets.length > MAX_XLSX_SHEETS) warnings.push('sheet_limit');
  for (const sheet of sheets) {
    lines.push(`# ${sheet.name}`);
    const rowCount = Math.min(sheet.rowCount || 0, MAX_XLSX_ROWS);
    const columnCount = Math.min(sheet.columnCount || 0, MAX_XLSX_COLS);
    if ((sheet.rowCount || 0) > MAX_XLSX_ROWS || (sheet.columnCount || 0) > MAX_XLSX_COLS) {
      warnings.push('cell_limit');
    }
    for (let rowNumber = 1; rowNumber <= rowCount; rowNumber += 1) {
      const row = sheet.getRow(rowNumber);
      const cells = [];
      for (let column = 1; column <= columnCount; column += 1) {
        const cell = row.getCell(column);
        cells.push(cell && cell.text != null ? String(cell.text) : '');
      }
      while (cells.length && cells[cells.length - 1] === '') cells.pop();
      if (cells.length) lines.push(cells.join('\t'));
      if (lines.join('\n').length > MAX_EXTRACTED_CHARS) {
        warnings.push('char_limit');
        break;
      }
    }
    if (lines.join('\n').length > MAX_EXTRACTED_CHARS) break;
  }
  return { text: lines.join('\n'), warnings: [...new Set(warnings)], meta: { sheets: workbook.worksheets.length } };
}

/**
 * 根据魔数判断附件类型并提取文本。
 * @returns {Promise<{ok:boolean, code?:string, error?:string, kind?:string, mime?:string,
 *   text?:string, truncated?:boolean, warnings?:string[], meta?:object}>}
 */
async function extractDocumentText({ bytes, filename = '', mime = '' } = {}) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) {
    return { ok: false, code: 'empty_file', error: '文件为空' };
  }
  const imageMime = sniffImageMime(bytes);
  if (imageMime) {
    return { ok: true, kind: 'image', mime: imageMime, text: '', truncated: false, warnings: [], meta: {} };
  }
  const lowerName = String(filename || '').toLowerCase();
  const lowerMime = String(mime || '').toLowerCase();
  if (lowerName.endsWith('.doc') || lowerName.endsWith('.xls')) {
    return { ok: false, code: 'legacy_office_unsupported', error: '旧版 .doc/.xls 不支持，请另存为 .docx/.xlsx' };
  }
  try {
    if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) {
      const result = await extractPdfText(bytes);
      const limited = limitText(result.text);
      return {
        ok: true, kind: 'document', mime: 'application/pdf',
        text: limited.text, truncated: limited.truncated,
        warnings: result.warnings, meta: result.meta
      };
    }
    if (isZip(bytes)) {
      if (lowerName.endsWith('.docx') || lowerMime.includes('wordprocessingml')) {
        const result = await extractDocxText(bytes);
        const limited = limitText(result.text);
        return {
          ok: true, kind: 'document', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          text: limited.text, truncated: limited.truncated, warnings: result.warnings, meta: result.meta
        };
      }
      if (lowerName.endsWith('.xlsx') || lowerMime.includes('spreadsheetml')) {
        const result = await extractXlsxText(bytes);
        const limited = limitText(result.text);
        return {
          ok: true, kind: 'document', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          text: limited.text, truncated: limited.truncated, warnings: result.warnings, meta: result.meta
        };
      }
      return { ok: false, code: 'unsupported_zip', error: '不支持的压缩文件类型，请上传 .docx 或 .xlsx' };
    }
    const extension = lowerName.includes('.') ? lowerName.slice(lowerName.lastIndexOf('.')) : '';
    const text = decodeText(bytes);
    if (text !== null && (TEXT_EXTENSIONS.has(extension) || TEXT_MIMES.has(lowerMime) || !extension)) {
      const limited = limitText(text);
      return {
        ok: true, kind: 'document', mime: lowerMime || 'text/plain',
        text: limited.text, truncated: limited.truncated, warnings: [], meta: {}
      };
    }
    return { ok: false, code: 'unsupported_type', error: '不支持的文件类型' };
  } catch (error) {
    if (error instanceof ExtractError) {
      return { ok: false, code: error.code, error: error.message };
    }
    return { ok: false, code: 'extract_failed', error: `解析失败: ${error.message || '未知错误'}` };
  }
}

module.exports = {
  MAX_EXTRACTED_CHARS,
  MAX_PDF_PAGES,
  MAX_XLSX_SHEETS,
  MAX_XLSX_ROWS,
  MAX_XLSX_COLS,
  sniffImageMime,
  decodeText,
  limitText,
  extractDocumentText
};
