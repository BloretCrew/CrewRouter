'use strict';

/**
 * 保守的 HTML 转文本：不执行脚本，不加载外部资源，只把正文标签转成可读文本。
 * 适合给模型阅读价格页/文档页，不追求完整 DOM 语义。
 */

const MAX_HTML_CHARS = 120000;

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  yen: '¥', euro: '€', pound: '£', copy: '©', reg: '®', trade: '™',
  mdash: '—', ndash: '–', hellip: '…', middot: '·', bull: '•',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', times: '×', divide: '÷'
};

function decodeEntities(text) {
  return String(text).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith('#x')) {
      const code = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    if (lower.startsWith('#')) {
      const code = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, lower) ? NAMED_ENTITIES[lower] : match;
  });
}

function cleanWhitespace(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[  ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function htmlToText(html, { maxChars = MAX_HTML_CHARS } = {}) {
  const source = String(html || '');
  const titleMatch = source.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1].replace(/<[^>]+>/g, '')).trim() : '';
  let text = source
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|canvas)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|hr)\b[^>]*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|header|footer|main|aside|h[1-6]|blockquote|pre|tr|ul|ol|dl|table)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<(td|th)\b[^>]*>/gi, '\t')
    .replace(/<\/(td|th)>/gi, '\t')
    .replace(/<[^>]+>/g, ' ');
  text = decodeEntities(text);
  text = cleanWhitespace(text);
  const truncated = text.length > maxChars;
  return {
    title: title.slice(0, 300),
    text: truncated ? text.slice(0, maxChars) : text,
    truncated
  };
}

function extractLinks(html, baseUrl, { max = 20 } = {}) {
  const source = String(html || '');
  const links = [];
  const seen = new Set();
  let resolvedBase = baseUrl;
  const baseMatch = source.match(/<base\b[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
  if (baseMatch) {
    try {
      resolvedBase = new URL(decodeEntities(String(baseMatch[1] || baseMatch[2] || baseMatch[3] || '').trim()), baseUrl).toString();
    } catch (_) { /* 保留页面 URL */ }
  }
  const pattern = /<a\b[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = pattern.exec(source)) && links.length < max) {
    const raw = decodeEntities(String(match[1] || match[2] || match[3] || '').trim());
    if (!raw || raw.startsWith('#') || /^(?:javascript|mailto|tel|data):/i.test(raw)) continue;
    let url;
    try { url = new URL(raw, resolvedBase); } catch (_) { continue; }
    if (!/^https?:$/.test(url.protocol)) continue;
    url.hash = '';
    const href = url.toString();
    if (seen.has(href)) continue;
    seen.add(href);
    const text = cleanWhitespace(decodeEntities(String(match[4] || '').replace(/<[^>]+>/g, ' '))).slice(0, 200);
    links.push({ url: href, text: text || href });
  }
  return links;
}

module.exports = { MAX_HTML_CHARS, decodeEntities, htmlToText, extractLinks };
