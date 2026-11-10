'use strict';

// Full-screen terminal engine adapted from Blora-Agent's ratatui visual
// language (theme, canvas, sidebar and dialog chrome), implemented with
// dependency-free ANSI rendering and the SGR mouse hit-map approach.

const { emitKeypressEvents } = require('node:readline');
const { PassThrough } = require('node:stream');
const { StringDecoder } = require('node:string_decoder');
const { clean, cw, width, cut, pad, wrap } = require('../lib/format');
const { createTheme } = require('./theme');

function visibleInput(value) {
  return [...String(value ?? '')].map(ch => /[\x00-\x1f\x7f-\x9f؜‎‏‪-‮⁦-⁩]/u.test(ch) ? ' ' : ch).join('');
}

function inputView(value, position, limit) {
  const chars = [...visibleInput(value)];
  const at = Math.max(0, Math.min(position, chars.length));
  let start = at;
  let caret = 0;
  while (start > 0) {
    const size = cw(chars[start - 1]);
    if (caret + size > Math.max(0, limit - 1)) break;
    start--;
    caret += size;
  }
  return { text: cut(chars.slice(start).join(''), limit), start, caret };
}

function atCell(view, cell) {
  let n = 0;
  let used = 0;
  for (const ch of view.text) {
    const step = cw(ch);
    if (used + step / 2 > cell) break;
    used += step;
    n++;
  }
  return view.start + n;
}

function text(value) {
  return Array.isArray(value) ? value.map(text).join('\n')
    : value == null ? '' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
}

function kindStyle(kind) {
  if (kind === 'heading') return { fg: 'fg', bold: true };
  if (kind === 'muted' || kind === 'mute') return { fg: 'mute' };
  if (kind === 'dim') return { fg: 'dim' };
  if (kind === 'rose') return { fg: 'rose' };
  if (kind === 'sage') return { fg: 'sage' };
  if (kind === 'warning') return { fg: 'amber' };
  if (kind === 'danger') return { fg: 'danger' };
  if (kind === 'label') return { fg: 'dim' };
  if (kind === 'value') return { fg: 'rose', bold: true };
  return { fg: 'fg' };
}

function rowSpans(row) {
  if (Array.isArray(row.spans) && row.spans.length) return row.spans;
  const style = kindStyle(row.kind);
  return [{ text: row.line || '', ...style }];
}

async function runPagedTui({
  input = process.stdin,
  output = process.stdout,
  env = process.env,
  api,
  pages,
  authenticate,
  onSessionReset = () => {},
  timers = {},
  title = 'CrewRouter',
  refreshMs = 10000,
  headerRight = null,
  sidebarFooter = null,
} = {}) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') throw new Error('TUI 需要交互式终端。');
  if (typeof api !== 'function' || !Array.isArray(pages) || !pages.length) throw new Error('页面或 API 未配置。');

  const theme = createTheme(env);
  const paint = theme.paint;
  const oldRaw = Boolean(input.isRaw);
  const wasFlowing = input.readableFlowing === true;
  const pageStates = new Map(pages.map(page => [page.id, {
    data: null, loading: false, refreshing: false, lastUpdated: null, error: null,
    scroll: 0, selected: 0, tabIndex: 0, tabViews: {}, cache: null, version: 0,
  }]));
  let active = 0;
  let focus = 'menu';
  let compactMenu = false;
  let busy = false;
  let closed = false;
  const onSignal = () => { closed = true; };
  process.once('SIGTERM', onSignal);
  process.once('SIGHUP', onSignal);
  let authenticated = false;
  let status = '正在连接…';
  let modal = null;
  let hit = {};
  let sequence = 0;
  let rerender = null;
  let pageTimer = null;
  let refreshInterval = Math.min(Math.max(Number(refreshMs) || 10000, 2000), 60000);
  const state = () => pageStates.get(pages[active].id);

  function currentTab(page = pages[active], st = state()) {
    return Array.isArray(page.tabs) && page.tabs.length ? page.tabs[Math.max(0, Math.min(page.tabs.length - 1, st.tabIndex || 0))] : null;
  }
  function rememberTab(st, page = pages[active]) {
    const tab = currentTab(page, st);
    if (tab) st.tabViews[tab.id] = { scroll: st.scroll, selected: st.selected };
  }
  function restoreTab(st, page = pages[active]) {
    const tab = currentTab(page, st);
    const view = tab ? st.tabViews[tab.id] : null;
    st.scroll = view?.scroll || 0;
    st.selected = view?.selected || 0;
    st.cache = null;
  }
  function switchTab(index) {
    const page = pages[active];
    const st = state();
    if (!page.tabs?.length) return;
    rememberTab(st, page);
    st.tabIndex = (index + page.tabs.length) % page.tabs.length;
    restoreTab(st, page);
    st.version++;
    render();
  }
  function tabLine(page, st, available) {
    const tabs = page.tabs || [];
    const activeTab = currentTab(page, st);
    if (!tabs.length) return null;
    const index = tabs.indexOf(activeTab);
    const labels = tabs.map((tab, i) => i === index ? `[ ${tab.label} ]` : `  ${tab.label}  `);
    const all = labels.join(' ');
    if (width(all) <= available) return { text: all, labels, index };
    return { text: cut(`‹ ${activeTab.label} ${index + 1}/${tabs.length} ›`, available), labels: null, index };
  }
  function schedule() { if (!rerender && !closed) rerender = setImmediate(() => { rerender = null; render(); }); }

  function wrapRow(label, inner, indent) {
    const room = Math.max(1, inner - indent);
    return wrap(clean(label), room);
  }

  function rowsFor(page, data, w, st) {
    const tab = currentTab(page, st);
    if (st.cache && st.cache.width === w && st.cache.version === st.version && st.cache.tab === (tab ? tab.id : null)) return st.cache.rows;
    const rows = [];
    const add = (line, kind = 'text', action = null, indent = 2) => rows.push({ line, kind, action, indent });
    const addSpans = (spans, kind = 'text', action = null, indent = 0) => rows.push({ spans, kind, action, indent });
    if (page.description) {
      for (const line of wrap(page.description, Math.max(1, w - 2))) add(line, 'mute', null, 1);
    }
    if (st.loading) add('正在加载，请稍候…', 'dim');
    if (st.error) {
      for (const line of wrap(`加载失败：${st.error}。按 r 重试。`, Math.max(1, w - 2))) add(line, 'warning', null, 1);
    }
    if (data) {
      const sections = (Array.isArray(data.sections) ? data.sections : []).filter(section => !tab || !section.tab || section.tab === tab.id);
      const actions = (Array.isArray(data.actions) ? data.actions : []).filter(action => !tab || !action.tab || action.tab === tab.id);
      let first = true;
      for (const section of sections) {
        if (!first) add('', 'text', null, 0);
        first = false;
        if (section.title) addSpans([{ text: '▸ ', fg: 'rose' }, { text: clean(section.title), fg: 'fg', bold: true }], 'heading', null, 0);
        if (section.description) {
          for (const line of wrap(section.description, Math.max(1, w - 4))) add(line, 'mute', null, 2);
        }
        const cards = Array.isArray(section.cards) ? section.cards : [];
        if (cards.length) {
          const count = w >= 68 ? 3 : w >= 44 ? 2 : 1;
          for (let start = 0; start < cards.length; start += count) {
            const group = cards.slice(start, start + count);
            const gap = 2;
            const cell = Math.max(8, Math.floor((w - gap * (group.length - 1)) / group.length));
            const spans = [];
            const details = [];
            group.forEach((card, index) => {
              if (index) spans.push({ text: ' '.repeat(gap), fg: 'fg' });
              const label = clean(text(card.label));
              const value = clean(text(card.value));
              const labelWidth = Math.max(6, Math.min(cell - 3, width(label)));
              const shortLabel = cut(label, labelWidth);
              spans.push({ text: shortLabel, fg: 'dim' });
              spans.push({ text: '  ', fg: 'fg' });
              spans.push({ text: cut(value, Math.max(1, cell - width(shortLabel) - 2)), fg: 'rose', bold: true });
              details.push({ text: cut(clean(text(card.detail)), cell), fg: 'mute' });
            });
            addSpans(spans, 'text', null, 0);
            if (details.some(item => item.text)) {
              const detailSpans = [];
              details.forEach((item, index) => {
                if (index) detailSpans.push({ text: ' '.repeat(gap), fg: 'fg' });
                detailSpans.push({ text: pad(item.text, cell), fg: 'mute' });
              });
              addSpans(detailSpans, 'muted', null, 0);
            }
          }
        }
        for (const entry of section.rows || []) {
          const row = typeof entry === 'string' ? { label: entry } : entry;
          if (!row) continue;
          const action = typeof row.run === 'function' && !row.disabled ? row : null;
          const lines = wrapRow(row.label || '', w, 2);
          lines.forEach((line, index) => {
            add(line, 'text', index === 0 ? action : null, action ? 0 : 2);
          });
          if (row.detail) {
            for (const line of wrap(text(row.detail), Math.max(1, w - 6))) add(line, 'mute', null, 4);
          }
        }
      }
      if (actions.length) {
        if (!first) add('', 'text', null, 0);
        addSpans([{ text: '▸ ', fg: 'rose' }, { text: '操作', fg: 'dim', bold: true }], 'heading', null, 0);
        for (const action of actions) {
          if (!action || !action.label) continue;
          add(action.label, action.disabled ? 'dim' : 'text', action.disabled ? null : action, 0);
        }
      }
    }
    if (!data && !st.loading && !st.error) add('尚无数据。', 'mute');
    st.cache = { width: w, version: st.version, tab: tab ? tab.id : null, rows };
    return rows;
  }

  function paintSpans(spans, available, painter, baseBg, forcedBg = null, forcedBold = false) {
    let used = 0;
    let out = '';
    const positions = [];
    for (const span of spans) {
      if (used >= available) break;
      const value = cut(clean(span.text ?? ''), available - used);
      if (!value) continue;
      const bg = forcedBg || span.bg || baseBg;
      positions.push({ start: used, end: used + width(value) - 1, span });
      out += painter(value, span.fg || 'fg', bg, forcedBold || span.bold === true, span.deco || '');
      used += width(value);
    }
    if (used < available) out += painter(' '.repeat(available - used), 'fg', forcedBg || baseBg);
    return { text: out, positions };
  }

  function headerChunks(innerW, page) {
    const right = typeof headerRight === 'function' ? clean(headerRight() || '') : (authenticated ? '已连接' : '连接中');
    const rightW = Math.min(width(right), Math.max(0, Math.floor(innerW / 2)));
    const leftW = Math.max(0, innerW - rightW - (rightW ? 1 : 0));
    const spans = [];
    if (hit.compact) spans.push({ text: '[菜单]', fg: 'rose', bold: true, action: 'menu' });
    else spans.push({ text: '✦ CrewRouter', fg: 'rose', bold: true });
    spans.push({ text: hit.compact ? '  ' : '  ·  ', fg: 'mute' });
    spans.push({ text: page.label, fg: 'fg', bold: true });
    if (!hit.compact) {
      spans.push({ text: '  ·  ', fg: 'mute' });
      const footer = typeof sidebarFooter === 'function' ? sidebarFooter() : null;
      spans.push({ text: (footer && footer[0]) || 'local', fg: 'sage' });
    }
    return { spans, leftW, right, rightW };
  }

  function render() {
    if (closed) return;
    if (rerender) { clearImmediate(rerender); rerender = null; }
    const cols = Math.max(1, output.columns || 80);
    const height = Math.max(1, output.rows || 24);
    const st = state();
    const page = pages[active];
    const side = cols >= 100 && height >= 18 ? 28 : 0;
    const compact = side === 0;
    const mainX = side;
    const mainW = Math.max(1, cols - side - (side ? 1 : 0));
    const padding = mainW >= 60 ? 2 : Math.max(1, Math.min(2, Math.floor(mainW / 20)));
    const innerX = mainX + padding;
    const innerW = Math.max(1, mainW - padding * 2);
    const dimBackground = Boolean(modal);
    const ui = dimBackground ? theme.dimmed : paint;
    hit = { cols, height, compact, side, innerX, innerW, rows: [], tabSpans: [], modal: null, footer: {} };

    const lines = Array.from({ length: height }, () => ui(' '.repeat(cols), 'fg', 'bg'));
    function fillAnsi(styled, target) {
      const missing = Math.max(0, target - width(clean(styled)));
      return styled + ui(' '.repeat(missing), 'fg', 'bg');
    }
    function put(lineIndex, left, right) {
      if (lineIndex < 0 || lineIndex >= height) return;
      const leftText = pad(left || '', side || 0);
      const rightText = fillAnsi(right || '', Math.max(0, cols - (side || 0) - (side ? 1 : 0)));
      lines[lineIndex] = side
        ? ui(leftText, 'fg', 'raised') + ui('│', 'line', 'raised') + rightText
        : rightText;
    }
    function sidebarText(lineIndex) {
      if (!side) return '';
      if (lineIndex === 0) return '  ✦ CrewRouter';
      if (lineIndex >= 2 && lineIndex - 2 < pages.length) {
        const index = lineIndex - 2;
        return `${index === active ? '›' : ' '} ${pageLabelAt(index)}`;
      }
      const footer = typeof sidebarFooter === 'function' ? sidebarFooter() : null;
      if (lineIndex === height - 2) return `  ${footer && footer[0] ? footer[0] : 'local'}`;
      if (lineIndex === height - 1) return `  ${footer && footer[1] ? footer[1] : (authenticated ? '已连接' : '未登录')}`;
      return '';
    }
    function pageLabelAt(index) { return pages[index] ? pages[index].label : ''; }

    const header = headerChunks(innerW, page);
    const headerSpans = paintSpans(header.spans, header.leftW, ui, 'bg');
    let headerLine = headerSpans.text;
    if (header.rightW) {
      headerLine += ui(' ', 'fg', 'bg');
      headerLine += ui(pad(header.right, header.rightW), 'sage', 'bg');
    }
    if (compact && headerSpans.positions.length) {
      const menu = headerSpans.positions.find(item => item.span && item.span.action === 'menu');
      if (menu) hit.menu = { start: innerX + menu.start + 1, end: innerX + menu.end + 1, y: 1 };
    }
    const leftPad = ui(' '.repeat(padding), 'fg', 'bg');
    if (side) {
      for (let index = 0; index < pages.length; index++) {
        const lineIndex = 2 + index;
        if (lineIndex < height - 2) hit.rows.push({ y: lineIndex + 1, type: 'page', index });
      }
    }
    put(0, sidebarText(0), leftPad + headerLine + leftPad);
    put(1, sidebarText(1), leftPad + ui('─'.repeat(innerW), 'line', 'bg') + leftPad);

    let contentStart = 2;
    if (compactMenu) {
      for (let i = contentStart; i < height - 2; i++) {
        const index = i - contentStart;
        const menuPage = pages[index];
        const selected = index === active;
        const label = menuPage ? `${selected ? '›' : ' '} ${menuPage.label}` : '';
        const textLine = pad(label, innerW);
        put(i, sidebarText(i), leftPad + ui(textLine, selected ? 'rose' : 'dim', selected ? 'select' : 'bg', selected) + leftPad);
        if (menuPage) hit.rows.push({ y: i + 1, type: 'page', index });
      }
    } else {
      const tabs = tabLine(page, st, innerW);
      if (tabs) {
        const spans = tabs.labels
          ? tabs.labels.map((label, index) => ({ text: `${label}${index < tabs.labels.length - 1 ? ' ' : ''}`, fg: index === tabs.index ? 'rose' : 'mute', bold: index === tabs.index, tab: index }))
          : [{ text: tabs.text, fg: 'mute' }];
        const painted = paintSpans(spans, innerW, ui, 'bg');
        for (const pos of painted.positions) {
          if (pos.span.tab !== undefined) hit.tabSpans.push({ start: innerX + pos.start + 1, end: innerX + pos.end + 1, index: pos.span.tab });
        }
        put(contentStart, sidebarText(contentStart), leftPad + painted.text + leftPad);
        contentStart += 1;
      }
      const body = Math.max(0, height - 2 - contentStart);
      const list = rowsFor(page, st.data, innerW, st);
      const maxScroll = Math.max(0, list.length - body);
      st.scroll = Math.max(0, Math.min(st.scroll, maxScroll));
      if (focus === 'content' && !list[st.selected]?.action) {
        const first = list.findIndex(row => row.action);
        if (first >= 0) st.selected = first;
      }
      const start = st.scroll;
      for (let i = 0; i < body; i++) {
        const row = list[start + i];
        let content = '';
        if (row) {
          const chosen = focus === 'content' && st.selected === start + i && row.action;
          const indent = row.action ? 0 : (row.indent ?? 2);
          const prefix = row.action ? (chosen ? '❯ ' : '  ') : ' '.repeat(indent);
          const spans = [{ text: prefix, fg: row.action ? 'rose' : 'fg' }, ...rowSpans(row)];
          const painted = paintSpans(spans, innerW, ui, chosen ? 'select' : 'bg', chosen ? 'select' : null);
          content = painted.text;
          if (row.action) hit.rows.push({ y: contentStart + i + 1, type: 'action', index: start + i, start: innerX + 1, end: innerX + innerW });
        } else {
          content = ui(' '.repeat(innerW), 'fg', 'bg');
        }
        put(contentStart + i, sidebarText(contentStart + i), leftPad + content + leftPad);
      }
      hit.contentRange = { start: contentStart, end: contentStart + body - 1, height: body };
    }

    const freshness = st.lastUpdated ? `更新 ${new Date(st.lastUpdated).toLocaleTimeString('zh-CN', { hour12: false })}${Date.now() - st.lastUpdated > 30000 ? ' · 可能过期' : ''}` : '';
    const info = st.loading ? '正在加载…' : st.refreshing ? '正在刷新…' : busy ? status || '正在处理…' : status;
    const statusText = [info, freshness].filter(Boolean).join('  ·  ');
    put(height - 2, sidebarText(height - 2), leftPad + ui(pad(statusText, innerW), 'mute', 'bg') + leftPad);
    const hints = [
      { text: '↑↓ 选择', fg: 'mute' },
      { text: '  Tab 区域', fg: 'mute' },
      ...(page.tabs?.length ? [{ text: '  ←→ 子页', fg: 'mute' }] : []),
      { text: '  Enter 打开', fg: 'mute' },
      { text: '  r 刷新', fg: 'mute', action: 'refresh' },
      { text: '  s 服务', fg: 'mute', action: 'service' },
      { text: '  q 退出', fg: 'mute', action: 'quit' },
    ];
    const hintLine = paintSpans(hints, innerW, ui, 'bg');
    for (const pos of hintLine.positions) {
      if (pos.span.action === 'refresh') hit.footer.refresh = { start: innerX + pos.start + 1, end: innerX + pos.end + 1 };
      if (pos.span.action === 'service') hit.footer.service = { start: innerX + pos.start + 1, end: innerX + pos.end + 1 };
      if (pos.span.action === 'quit') hit.footer.quit = { start: innerX + pos.start + 1, end: innerX + pos.end + 1 };
    }
    put(height - 1, sidebarText(height - 1), leftPad + hintLine.text + leftPad);

    let overlay = '';
    let cursor = '\x1b[?25l';
    if (modal) {
      const rendered = renderDialog(cols, height);
      overlay = rendered.overlay;
      if (rendered.cursor) cursor = rendered.cursor;
    }
    output.write('\x1b[?25l\x1b[H' + lines.join('\r\n') + '\x1b[J' + overlay + cursor);
  }

  function dialogGeometry(cols, height) {
    const preferred = modal.width || (modal.type === 'show' ? 72 : modal.type === 'form' ? 66 : 62);
    const width = modal.fullscreen ? Math.max(20, cols - 2) : Math.min(Math.max(24, preferred), Math.max(24, cols - 4));
    let desired = modal.height || 10;
    if (modal.type === 'choose') desired = Math.max(9, 6 + Math.min(10, Array.isArray(modal.options) ? modal.options.length : 0) + Math.min(5, wrap(modal.description || '', Math.max(1, width - 6)).length));
    else if (modal.type === 'form') desired = Math.max(10, 8 + (modal.fields?.length || 0) * 2);
    else if (modal.type === 'input') desired = 9;
    else if (modal.type === 'confirm') desired = 9;
    else if (modal.type === 'show') desired = 13;
    const dialogHeight = modal.minimized ? 3 : (modal.fullscreen ? Math.max(5, height - 2) : Math.min(Math.max(7, desired), Math.max(7, height - 2)));
    const left = Math.max(1, Math.floor((cols - width) / 2) + 1);
    const top = Math.max(1, Math.floor((height - dialogHeight) / 2) + 1);
    return { left, top, width, height: dialogHeight, innerW: Math.max(1, width - 4), bodyH: Math.max(0, dialogHeight - 4) };
  }

  function dialogRow(geometry, row, spans, bg = 'bg', forceBold = false) {
    const painted = paintSpans(spans, geometry.innerW, paint, bg, null, forceBold);
    return paint('│', 'line', 'bg') + painted.text + paint('│', 'line', 'bg');
  }

  function renderDialog(cols, height) {
    const geometry = dialogGeometry(cols, height);
    const { left, top, width: boxWidth, height: dialogHeight, innerW, bodyH } = geometry;
    hit.modal = {
      left, top, width: boxWidth, height: dialogHeight, innerW,
      trafficLights: [], hintButtons: [], optionRows: [], fieldRows: [], inputRow: null, inputStart: null, inputView: null,
    };
    const rows = Array.from({ length: dialogHeight }, () => '');
    rows[0] = paint(`╭${'─'.repeat(Math.max(0, boxWidth - 2))}╮`, 'line', 'bg');
    rows[dialogHeight - 1] = paint(`╰${'─'.repeat(Math.max(0, boxWidth - 2))}╯`, 'line', 'bg');
    const titleDots = [['●', 'danger', 'close'], ['●', 'amber', 'minimize'], ['●', 'sage', 'fullscreen']];
    const titleSpans = [{ text: ' ', fg: 'fg' }];
    const dotXs = [];
    titleDots.forEach(([glyph, color, action], index) => {
      if (index) titleSpans.push({ text: ' ', fg: 'fg' });
      dotXs.push(2 + index * 2);
      titleSpans.push({ text: glyph, fg: color, action });
    });
    titleSpans.push({ text: '  ', fg: 'fg' });
    titleSpans.push({ text: cut(clean(modal.title || ''), Math.max(0, innerW - 9)), fg: 'dim' });
    rows[1] = dialogRow(geometry, 1, titleSpans, 'bg');
    dotXs.forEach((x, index) => {
      hit.modal.trafficLights.push({ start: left + x, end: left + x + 1, y: top + 1, action: titleDots[index][2] });
    });
    for (let i = 2; i < dialogHeight - 1; i++) rows[i] = dialogRow(geometry, i, [{ text: '', fg: 'fg' }], 'bg');

    if (modal.minimized) {
      return {
        overlay: rows.map((line, index) => `\x1b[${top + index};${left}H${line}`).join(''),
        cursor: null,
      };
    }

    const bodyX = left + 1;
    const bodyY = top + 2;
    let rowIndex = 0;
    const descriptionLines = wrap(clean(modal.description || ''), innerW);
    const putBody = (spans, bg = 'bg') => {
      if (rowIndex >= bodyH) return false;
      rows[2 + rowIndex] = dialogRow(geometry, 2 + rowIndex, spans, bg);
      rowIndex++;
      return true;
    };
    if (descriptionLines.some(line => line)) {
      for (const line of descriptionLines) {
        if (!putBody([{ text: line, fg: 'dim' }])) break;
      }
      if (modal.type !== 'show') putBody([{ text: '', fg: 'fg' }]);
    }

    let cursor = null;
    if (modal.type === 'choose') {
      const options = Array.isArray(modal.options) ? modal.options : [];
      const available = Math.max(1, bodyH - rowIndex);
      modal.scroll = Math.max(0, Math.min(modal.scroll, Math.max(0, options.length - available)));
      if (modal.selected < modal.scroll) modal.scroll = modal.selected;
      if (modal.selected >= modal.scroll + available) modal.scroll = modal.selected - available + 1;
      for (let i = modal.scroll; i < Math.min(options.length, modal.scroll + available); i++) {
        const selected = i === modal.selected;
        const label = clean(options[i].label || options[i].value || '');
        if (!putBody([{ text: selected ? '❯ ' : '  ', fg: 'rose' }, { text: cut(label, innerW - 2), fg: selected ? 'fg' : 'dim' }], selected ? 'select' : 'bg')) break;
        hit.modal.optionRows.push({ y: bodyY + rowIndex - 1, index: i });
      }
    } else if (modal.type === 'input') {
      const shown = modal.secret ? '•'.repeat([...modal.value].length) : modal.value;
      hit.modal.inputView = inputView(shown, modal.position, Math.max(1, innerW - 3));
      if (putBody([{ text: '❯ ', fg: 'rose' }, { text: hit.modal.inputView.text, fg: 'fg' }], 'raised')) {
        hit.modal.inputRow = bodyY + rowIndex - 1;
        hit.modal.inputStart = bodyX + 2;
        cursor = `\x1b[${hit.modal.inputRow};${bodyX + 2 + hit.modal.inputView.caret}H\x1b[?25h`;
      }
    } else if (modal.type === 'form') {
      const fields = Array.isArray(modal.fields) ? modal.fields : [];
      const fieldStart = rowIndex;
      const availableRows = Math.max(1, bodyH - fieldStart);
      const selectedLine = Math.max(0, modal.selected) * 2;
      modal.scroll = Math.max(0, Math.min(modal.scroll, Math.max(0, fields.length * 2 - availableRows)));
      if (selectedLine < modal.scroll) modal.scroll = selectedLine;
      if (selectedLine >= modal.scroll + availableRows) modal.scroll = selectedLine - availableRows + 2;
      let fieldRows = 0;
      for (let index = 0; index < fields.length; index++) {
        const field = fields[index];
        if (fieldRows >= availableRows) break;
        const selected = index === modal.selected;
        const label = clean(field.label || field.name || '');
        if (!putBody([{ text: selected ? '❯ ' : '  ', fg: 'rose' }, { text: cut(label, innerW - 2), fg: selected ? 'fg' : 'dim', bold: selected }], selected ? 'select' : 'bg')) break;
        hit.modal.fieldRows.push({ y: bodyY + rowIndex - 1, index, kind: 'label' });
        fieldRows++;
        if (fieldRows >= availableRows) break;
        const raw = modal.values[index];
        const shown = field.secret ? '•'.repeat([...String(raw)].length)
          : field.type === 'boolean' ? (raw ? '(•) 是' : '( ) 否')
            : field.options ? (field.options.find(option => option.value === raw)?.label ?? String(raw))
              : String(raw);
        const prefix = field.options || field.type === 'boolean' ? '  ' : '    ';
        if (!putBody([{ text: prefix, fg: 'fg' }, { text: cut(shown, Math.max(1, innerW - width(prefix))), fg: 'fg' }], selected ? 'raised' : 'bg')) break;
        hit.modal.fieldRows.push({ y: bodyY + rowIndex - 1, index, kind: 'value' });
        fieldRows++;
        if (selected && !field.options && field.type !== 'boolean') {
          const view = inputView(shown, modal.positions[index], Math.max(1, innerW - width(prefix)));
          modal.fieldView = view;
          cursor = `\x1b[${bodyY + rowIndex - 1};${bodyX + width(prefix) + view.caret}H\x1b[?25h`;
        }
      }
    } else if (modal.type === 'confirm') {
      putBody([{ text: '', fg: 'fg' }]);
    } else if (modal.type === 'show') {
      const lines = wrap(clean(modal.description || ''), innerW);
      const available = Math.max(1, bodyH);
      modal.scroll = Math.max(0, Math.min(modal.scroll, Math.max(0, lines.length - available)));
      for (let i = modal.scroll; i < Math.min(lines.length, modal.scroll + available); i++) {
        if (!putBody([{ text: lines[i], fg: 'fg' }])) break;
      }
    }

    const hintSpans = [];
    const hintAction = (value, action, fg = 'mute') => hintSpans.push({ text: value, fg, action });
    if (modal.type === 'choose') {
      hintAction('↑↓ 选择  ·  Enter ', 'none');
      hintAction('确认', 'ok', 'sage');
      hintAction('  ·  Esc 关闭', 'cancel');
    } else if (modal.type === 'input') {
      hintAction('Enter ', 'none');
      hintAction('确定', 'ok', 'sage');
      hintAction('  ·  Esc ', 'none');
      hintAction('取消', 'cancel');
    } else if (modal.type === 'form') {
      hintAction('↑↓ 选择 · Enter 下一项 · Space 切换 · Esc ', 'none');
      hintAction('取消', 'cancel');
    } else if (modal.type === 'confirm') {
      hintAction('Enter / y ', 'none');
      hintAction('确认', 'ok', 'sage');
      hintAction('  ·  n / Esc ', 'none');
      hintAction('取消', 'cancel');
    } else {
      hintAction('PgUp/PgDn 滚动 · Esc ', 'none');
      hintAction('关闭', 'cancel');
    }
    rows[dialogHeight - 2] = dialogRow(geometry, dialogHeight - 2, hintSpans, 'bg');
    let hintUsed = 0;
    for (const span of hintSpans) {
      if (span.action && span.action !== 'none') {
        hit.modal.hintButtons.push({ start: left + 1 + hintUsed, end: left + hintUsed + width(span.text), action: span.action });
      }
      hintUsed += width(span.text);
    }
    hit.modal.body = { x: bodyX, y: bodyY, width: innerW, height: bodyH };

    return {
      overlay: rows.map((line, index) => `\x1b[${top + index};${left}H${line}`).join(''),
      cursor,
    };
  }

  function closeModal(value) {
    if (!modal) return;
    const current = modal;
    modal = null;
    current.resolve(value);
    render();
  }

  function dialog(spec) {
    return new Promise(resolve => {
      if (closed) { resolve(null); return; }
      modal = {
        ...spec,
        resolve,
        scroll: 0,
        selected: 0,
        minimized: false,
        fullscreen: false,
        followSelection: spec.type === 'form',
        position: [...String(spec.value || '')].length,
        positions: (spec.values || []).map(value => [...String(value)].length),
      };
      render();
    });
  }
  async function ask(question, { description = '', secret = false, defaultValue = '' } = {}) {
    return dialog({ type: 'input', title: question, description, value: String(defaultValue ?? ''), secret });
  }
  async function form(question, fields, { description = '', submitLabel = '保存' } = {}) {
    const values = fields.map(field => field.value ?? (field.type === 'boolean' ? false : ''));
    const result = await dialog({ type: 'form', title: question, description, fields, values, submitLabel });
    return result === null ? null : Object.fromEntries(fields.map((field, index) => [field.name, result[index]]));
  }
  async function confirm(question, description) {
    return (await dialog({ type: 'confirm', title: question, description: text(description) })) === true;
  }
  async function show(question, value) {
    const result = await dialog({ type: 'show', title: question, description: text(value) });
    if (result === null) throw Object.assign(new Error('已取消'), { cancelled: true });
  }
  async function choose(question, options, { description = '' } = {}) {
    if (!options || !options.length) { await show(question, '暂无可选项。'); return null; }
    const index = await dialog({ type: 'choose', title: question, description, options });
    return index === null ? null : options[index]?.value;
  }
  function notify(message) { status = clean(message).replace(/\n/g, ' '); schedule(); }
  function resetSession() {
    sequence++;
    if (pageTimer) { (timers.clearInterval || clearInterval)(pageTimer); pageTimer = null; }
    for (const st of pageStates.values()) {
      Object.assign(st, { data: null, loading: false, refreshing: false, lastUpdated: null, error: null, scroll: 0, selected: 0, tabIndex: 0, tabViews: {}, cache: null });
      st.version++;
    }
    onSessionReset();
  }
  async function load(index = active, { automatic = false } = {}) {
    const page = pages[index];
    const st = pageStates.get(page.id);
    const generation = ++sequence;
    const oldWidth = Math.max(1, hit.innerW || 80);
    const oldSelection = automatic && st.data ? rowsFor(page, st.data, oldWidth, st)[st.selected]?.line : null;
    const oldScroll = st.scroll;
    st.generation = generation;
    if (automatic) st.refreshing = true; else { st.loading = true; st.error = null; st.version++; }
    render();
    const mustDefer = () => automatic && (active !== index || focus !== 'menu' || busy || modal);
    try {
      const result = await page.load(api, ctx);
      if (closed || generation !== sequence || mustDefer()) return;
      st.data = result;
      st.lastUpdated = Date.now();
      st.error = null;
      st.version++;
      st.cache = null;
      if (automatic && oldSelection) {
        const newRows = rowsFor(page, result, oldWidth, st);
        const selected = newRows.findIndex(row => row.action && row.line === oldSelection);
        st.selected = selected >= 0 ? selected : 0;
        st.scroll = oldScroll;
      } else if (!automatic) {
        st.scroll = 0;
        st.selected = 0;
      }
    } catch (error) {
      if (closed || generation !== sequence || mustDefer()) return;
      if (error && error.statusCode === 401 && authenticated) {
        await beginAuthentication('会话已失效，请重新登录。');
        return;
      }
      st.error = error && error.message ? error.message : '请求失败';
      st.version++;
    } finally {
      if (st.generation === generation) {
        st.loading = false;
        st.refreshing = false;
        st.version++;
        if (active === index) render();
      }
    }
  }

  function startPagePolling() {
    if (pageTimer) (timers.clearInterval || clearInterval)(pageTimer);
    pageTimer = (timers.setInterval || setInterval)(() => {
      if (closed || !authenticated) return;
      const st = state();
      if (!busy && !modal && focus === 'menu' && !st.loading && !st.refreshing) void load(active, { automatic: true });
      else render();
    }, refreshInterval);
    if (pageTimer && typeof pageTimer.unref === 'function') pageTimer.unref();
  }

  async function navigate(id) {
    const next = pages.findIndex(page => page.id === id);
    if (next < 0) { notify('页面不可用'); return; }
    rememberTab(state());
    active = next;
    focus = pages[next].tabs?.length ? 'tabs' : 'content';
    status = '已连接';
    compactMenu = false;
    const st = state();
    restoreTab(st, pages[next]);
    if (!st.data) await load(next);
    else render();
  }

  async function beginAuthentication(message) {
    authenticated = false;
    resetSession();
    status = message;
    if (await authenticate(ctx)) {
      authenticated = true;
      status = '已连接';
      startPagePolling();
      await load(active);
    } else closed = true;
  }
  async function relogin(message = '请重新登录。') { await beginAuthentication(message); }
  async function logout() {
    try { await api('/auth/logout', { method: 'GET', raw: true }); } catch (_) { /* best effort */ }
    await beginAuthentication('已退出当前登录，请重新登录。');
  }
  const ctx = { api, ask, form, confirm, show, choose, notify, navigate, openPage: navigate, relogin, logout, refresh: () => load(active) };

  async function execute(action) {
    if (!action || typeof action.run !== 'function' || busy) return;
    busy = true;
    status = '正在处理…';
    render();
    try {
      await action.run(ctx);
    } catch (error) {
      if (error && error.cancelled) status = '已取消';
      else if (error && error.statusCode === 401) {
        await beginAuthentication('会话已失效，请重新登录。');
      } else {
        status = `操作失败：${clean(error && error.message ? error.message : '请求失败')}`;
        try { await show('操作失败', status); } catch (dialogError) { if (!dialogError?.cancelled) throw dialogError; }
      }
    } finally {
      busy = false;
      if (status === '正在处理…') status = '操作完成';
      render();
    }
  }

  function chooseDelta(delta) {
    if (!modal?.options?.length) return;
    modal.selected = Math.max(0, Math.min(modal.options.length - 1, modal.selected + delta));
    modal.followSelection = true;
  }

  function modalResult() {
    if (!modal) return null;
    if (modal.type === 'input') return modal.value;
    if (modal.type === 'choose') return modal.selected;
    if (modal.type === 'form') return modal.values;
    return true;
  }

  function onKey(str, key = {}) {
    if (key.ctrl && key.name === 'c') { if (modal) closeModal(null); else closed = true; return; }
    if (modal) {
      if (key.name === 'escape') { closeModal(null); return; }
      if (modal.minimized) {
        if (key.name === 'return' || str === ' ') { modal.minimized = false; render(); }
        return;
      }
      if (modal.type === 'confirm') {
        if (key.name === 'return' || str === 'y') { closeModal(true); return; }
        if (key.name === 'n') { closeModal(false); return; }
      } else if (modal.type === 'form') {
        if (key.name === 'pageup' || key.name === 'pagedown') { modal.followSelection = false; modal.scroll = Math.max(0, modal.scroll + (key.name === 'pageup' ? -2 : 2)); }
        else if (key.name === 'up' || key.name === 'down' || key.name === 'tab') {
          modal.selected = Math.max(0, Math.min(modal.fields.length - 1, modal.selected + (key.name === 'up' ? -1 : 1)));
          modal.followSelection = true;
        } else if (key.name === 'return') {
          if (modal.selected < modal.fields.length - 1) { modal.selected++; modal.followSelection = true; }
          else { closeModal(modal.values); return; }
        } else {
          const field = modal.fields[modal.selected];
          const current = modal.values[modal.selected];
          if (field?.type === 'boolean' && (str === ' ' || key.name === 'left' || key.name === 'right')) modal.values[modal.selected] = !current;
          else if (field?.options?.length && (str === ' ' || key.name === 'left' || key.name === 'right')) {
            const index = field.options.findIndex(option => option.value === current);
            modal.values[modal.selected] = field.options[(index + 1) % field.options.length].value;
          } else {
            const chars = [...String(current)];
            let pos = modal.positions[modal.selected];
            if (key.name === 'left') pos = Math.max(0, pos - 1);
            else if (key.name === 'right') pos = Math.min(chars.length, pos + 1);
            else if (key.name === 'home' || key.ctrl && key.name === 'a') pos = 0;
            else if (key.name === 'end' || key.ctrl && key.name === 'e') pos = chars.length;
            else if (key.name === 'backspace' && pos > 0) chars.splice(--pos, 1);
            else if (key.name === 'delete' && pos < chars.length) chars.splice(pos, 1);
            else if (key.ctrl && key.name === 'u') { chars.length = 0; pos = 0; }
            else if (str && !key.ctrl && !key.meta && !key.sequence?.startsWith('\x1b')) {
              const added = [...clean(str).replace(/\n/g, '')].slice(0, Math.max(0, 32768 - chars.length));
              chars.splice(pos, 0, ...added);
              pos += added.length;
            }
            modal.values[modal.selected] = chars.join('');
            modal.positions[modal.selected] = pos;
          }
        }
      } else if (modal.type === 'choose') {
        if (key.name === 'up' || key.name === 'down') chooseDelta(key.name === 'up' ? -1 : 1);
        else if (key.name === 'return') closeModal(modal.selected);
        else if (['pageup', 'pagedown'].includes(key.name)) {
          const step = Math.max(1, (hit.modal?.body?.height || 4) - 1);
          modal.scroll = Math.max(0, modal.scroll + (key.name === 'pageup' ? -step : step));
        }
      } else if (modal.type === 'input') {
        if (key.name === 'return') { closeModal(modal.value); return; }
        const chars = [...modal.value];
        let pos = modal.position;
        if (key.name === 'left') pos = Math.max(0, pos - 1);
        else if (key.name === 'right') pos = Math.min(chars.length, pos + 1);
        else if (key.name === 'home' || key.ctrl && key.name === 'a') pos = 0;
        else if (key.name === 'end' || key.ctrl && key.name === 'e') pos = chars.length;
        else if (key.name === 'backspace' && pos > 0) chars.splice(--pos, 1);
        else if (key.name === 'delete' && pos < chars.length) chars.splice(pos, 1);
        else if (key.ctrl && key.name === 'u') { chars.length = 0; pos = 0; }
        else if (str && !key.ctrl && !key.meta && !key.sequence?.startsWith('\x1b')) {
          const added = [...clean(str).replace(/\n/g, '')].slice(0, Math.max(0, 32768 - chars.length));
          chars.splice(pos, 0, ...added);
          pos += added.length;
        }
        modal.value = chars.join('');
        modal.position = pos;
      } else if (modal.type === 'show') {
        if (['pageup', 'pagedown', 'up', 'down'].includes(key.name)) {
          const step = key.name === 'pageup' || key.name === 'pagedown' ? Math.max(1, (hit.modal?.body?.height || 4) - 1) : 1;
          modal.scroll = Math.max(0, modal.scroll + (['up', 'pageup'].includes(key.name) ? -step : step));
        }
      }
      render();
      return;
    }
    if (busy) return;
    const st = state();
    const w = Math.max(1, hit.innerW || 80);
    const rows = rowsFor(pages[active], st.data, w, st);
    if (key.name === 'q') { closed = true; return; }
    if (key.name === 'r') { void load(); return; }
    if (key.name === 's') { void navigate('service'); return; }
    if (key.name === 'tab') {
      if (focus === 'menu') { if (!focusTabs()) focusContent(); }
      else if (focus === 'tabs') focusContent();
      else focus = 'menu';
    } else if (key.name === 'left') {
      if (focus === 'tabs') switchTab(st.tabIndex - 1);
      else if (focus === 'content' && pages[active].tabs?.length) focusTabs();
      else focus = 'menu';
    } else if (key.name === 'right') {
      if (focus === 'tabs') switchTab(st.tabIndex + 1);
      else if (focus === 'menu') { if (!focusTabs()) focusContent(); }
    } else if (key.name === 'up' || key.name === 'down') {
      const delta = key.name === 'up' ? -1 : 1;
      if (focus === 'menu') {
        rememberTab(st);
        active = Math.max(0, Math.min(pages.length - 1, active + delta));
        const next = state();
        restoreTab(next, pages[active]);
        if (!next.data && !next.loading) void load(active);
      } else if (focus === 'content') {
        let index = st.selected + delta;
        while (index >= 0 && index < rows.length && !rows[index].action) index += delta;
        if (index >= 0 && index < rows.length) {
          st.selected = index;
          const bodyH = hit.contentRange?.height || 1;
          if (index < st.scroll) st.scroll = index;
          else if (index >= st.scroll + bodyH) st.scroll = index - bodyH + 1;
        } else st.scroll = Math.max(0, st.scroll + delta);
      }
    } else if (key.name === 'pageup' || key.name === 'pagedown') {
      focus = 'content';
      const bodyH = hit.contentRange?.height || 1;
      st.scroll = Math.max(0, st.scroll + (key.name === 'pageup' ? -1 : 1) * Math.max(1, bodyH - 1));
    } else if (key.name === 'return') {
      if (focus === 'menu') { if (!focusTabs()) focusContent(); }
      else if (focus === 'tabs') focusContent();
      else activateRow(st.selected);
    }
    render();
  }

  function focusTabs() {
    compactMenu = false;
    if (!pages[active].tabs?.length) return false;
    focus = 'tabs';
    render();
    return true;
  }
  function focusContent() {
    compactMenu = false;
    focus = 'content';
    const st = state();
    const w = Math.max(1, hit.innerW || 80);
    const rows = rowsFor(pages[active], st.data, w, st);
    if (!rows[st.selected]?.action) {
      const first = rows.findIndex(row => row.action);
      if (first >= 0) st.selected = first;
    }
    const bodyH = hit.contentRange?.height || 1;
    if (rows[st.selected]?.action) {
      if (st.selected < st.scroll) st.scroll = st.selected;
      else if (st.selected >= st.scroll + bodyH) st.scroll = Math.max(0, st.selected - bodyH + 1);
    }
  }
  function activatePage(index) { if (index < 0 || index >= pages.length || busy) return; void navigate(pages[index].id); }
  function activateRow(index) {
    const st = state();
    const w = Math.max(1, hit.innerW || 80);
    const row = rowsFor(pages[active], st.data, w, st)[index];
    if (!row?.action) return;
    st.selected = index;
    void execute(row.action);
  }

  function closeFromHint(action) {
    if (action === 'ok') { closeModal(modalResult()); return; }
    closeModal(null);
  }

  function onMouse(code, x, y, final) {
    if (final !== 'M' || (code & 60) || x < 1 || y < 1 || x > hit.cols || y > hit.height) return;
    const wheel = code === 64 || code === 65;
    const press = code === 0;
    const direction = code === 64 ? -1 : 1;
    if (!wheel && !press) return;
    if (modal) {
      const box = hit.modal;
      if (!box) return;
      if (press) {
        const dot = box.trafficLights.find(item => y === item.y && x >= item.start && x <= item.end);
        if (dot) {
          if (dot.action === 'close') closeModal(null);
          else if (dot.action === 'minimize') { modal.minimized = !modal.minimized; render(); }
          else if (dot.action === 'fullscreen') { if (modal.minimized) { modal.minimized = false; modal.fullscreen = true; } else modal.fullscreen = !modal.fullscreen; render(); }
          return;
        }
      }
      if (modal.minimized) return;
      if (wheel && x >= box.left && x < box.left + box.width && y >= box.top && y < box.top + box.height) {
        if (modal.type === 'choose') chooseDelta(direction * 3);
        else { modal.scroll = Math.max(0, modal.scroll + direction * 3); }
        render();
        return;
      }
      if (press) {
        const hint = box.hintButtons.find(item => y === box.top + box.height - 2 && x >= item.start && x <= item.end);
        if (hint) { closeFromHint(hint.action); return; }
        const option = box.optionRows.find(item => y === item.y);
        if (option && modal.type === 'choose') { modal.selected = option.index; closeModal(option.index); return; }
        const field = box.fieldRows.find(item => y === item.y);
        if (field && modal.type === 'form') {
          modal.selected = field.index;
          const spec = modal.fields[field.index];
          if (spec.type === 'boolean') modal.values[field.index] = !modal.values[field.index];
          else if (spec.options?.length) {
            const current = spec.options.findIndex(option => option.value === modal.values[field.index]);
            modal.values[field.index] = spec.options[(current + 1) % spec.options.length].value;
          } else if (field.kind === 'value' && modal.fieldView) {
            modal.positions[field.index] = atCell(modal.fieldView, Math.max(0, x - (box.body.x + 4)));
          }
          render();
          return;
        }
        if (modal.type === 'input' && y === box.inputRow && x >= box.inputStart) {
          modal.position = atCell(box.inputView, x - box.inputStart);
          render();
          return;
        }
      }
      return;
    }
    if (busy) return;
    if (press && hit.compact && hit.menu && y === 1 && x >= hit.menu.start && x <= hit.menu.end) {
      compactMenu = !compactMenu;
      focus = 'menu';
      render();
      return;
    }
    if (press && y === 3 && hit.tabSpans.length) {
      const tab = hit.tabSpans.find(item => x >= item.start && x <= item.end);
      if (tab) { switchTab(tab.index); return; }
    }
    if (press && y === hit.height) {
      if (hit.footer.quit && x >= hit.footer.quit.start && x <= hit.footer.quit.end) { closed = true; return; }
      if (hit.footer.service && x >= hit.footer.service.start && x <= hit.footer.service.end) { void navigate('service'); return; }
      if (hit.footer.refresh && x >= hit.footer.refresh.start && x <= hit.footer.refresh.end) { void load(); return; }
    }
    const row = hit.rows.find(item => item.y === y && (item.type === 'page' ? (hit.compact ? compactMenu : x <= hit.side) : x >= item.start));
    if (wheel) {
      if ((hit.compact && compactMenu) || (!hit.compact && x <= hit.side)) {
        const next = Math.max(0, Math.min(pages.length - 1, active + direction));
        activatePage(next);
      } else {
        focus = 'content';
        state().scroll = Math.max(0, state().scroll + direction * 3);
        render();
      }
    } else if (row?.type === 'page') activatePage(row.index);
    else if (row?.type === 'action') { focus = 'content'; activateRow(row.index); }
    else if (press && y >= 3 && y <= hit.height - 2 && (!hit.side || x > hit.side)) { focus = 'content'; render(); }
  }

  const keyboard = new PassThrough();
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let timer = null;
  let afterEscape = false;
  let escapeTail = '';
  let escapeTailTimer = null;
  let discardMouse = false;
  let discardTimer = null;
  function beginMouseDiscard() {
    discardMouse = true;
    clearTimeout(discardTimer);
    discardTimer = setTimeout(() => { discardMouse = false; }, 2000);
  }
  function filter(value) {
    buffer += value;
    clearTimeout(timer);
    while (buffer) {
      const index = buffer.indexOf('\x1b');
      if (index < 0) { keyboard.write(buffer); buffer = ''; break; }
      if (index > 0) { keyboard.write(buffer.slice(0, index)); buffer = buffer.slice(index); }
      if ('\x1b[<'.startsWith(buffer)) break;
      if (buffer.startsWith('\x1b[<')) {
        const match = /^\x1b\[<(\d{1,3});(\d{1,5});(\d{1,5})([Mm])/.exec(buffer);
        if (match) {
          buffer = buffer.slice(match[0].length);
          onMouse(Number(match[1]), Number(match[2]), Number(match[3]), match[4]);
          continue;
        }
        if (/^\x1b\[<[0-9;]{0,16}$/.test(buffer)) break;
        const end = buffer.search(/[Mm]/);
        buffer = end < 0 ? '' : buffer.slice(end + 1);
        if (end < 0) beginMouseDiscard();
        continue;
      }
      keyboard.write(buffer.slice(0, 1));
      buffer = buffer.slice(1);
    }
    if (buffer) {
      timer = setTimeout(() => {
        const rest = buffer;
        buffer = '';
        if (rest === '\x1b') { afterEscape = true; onKey('\x1b', { name: 'escape', sequence: '\x1b' }); }
        else if (rest.startsWith('\x1b[<')) beginMouseDiscard();
        else keyboard.write(rest);
      }, buffer === '\x1b' ? 100 : 150);
    }
  }
  function feed(value) {
    if (discardMouse) {
      const end = value.search(/[^0-9;]/);
      if (end < 0) { beginMouseDiscard(); return; }
      const rest = value.slice(end + (value[end] === 'M' || value[end] === 'm' ? 1 : 0));
      discardMouse = false;
      clearTimeout(discardTimer);
      if (rest) feed(rest);
      return;
    }
    if (!afterEscape) { filter(value); return; }
    escapeTail += value;
    clearTimeout(escapeTailTimer);
    const match = /^\[<(\d{1,3});(\d{1,5});(\d{1,5})[Mm]/.exec(escapeTail);
    if (match) {
      const rest = escapeTail.slice(match[0].length);
      escapeTail = '';
      afterEscape = false;
      if (rest) filter(rest);
      return;
    }
    if (escapeTail === '[' || /^\[<[0-9;]{0,16}$/.test(escapeTail)) {
      escapeTailTimer = setTimeout(() => {
        const rest = escapeTail;
        escapeTail = '';
        afterEscape = false;
        if (rest.startsWith('[<')) beginMouseDiscard();
        else if (rest) filter(rest);
      }, 2000);
      return;
    }
    const rest = escapeTail;
    escapeTail = '';
    afterEscape = false;
    if (rest) filter(rest);
  }
  const onData = chunk => feed(typeof chunk === 'string' ? chunk : decoder.write(chunk));
  const onEnd = () => { closed = true; if (modal) closeModal(null); };
  const onResize = () => render();

  try {
    emitKeypressEvents(keyboard);
    keyboard.on('keypress', onKey);
    input.setRawMode(true);
    input.on('data', onData);
    input.on('end', onEnd);
    output.on('resize', onResize);
    input.resume();
    output.write(`\x1b]0;${clean(title)}\x07\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h${theme.osc}`);
    render();
    authenticated = await authenticate(ctx);
    if (authenticated && !closed) {
      status = '已连接';
      startPagePolling();
      await load(active);
    }
    while (!closed && authenticated) await new Promise(resolve => {
      const interval = (timers.setInterval || setInterval)(() => {
        if (closed) { (timers.clearInterval || clearInterval)(interval); resolve(); }
      }, 50);
      if (interval && typeof interval.unref === 'function') interval.unref();
    });
  } finally {
    closed = true;
    sequence++;
    if (modal) closeModal(null);
    if (rerender) clearImmediate(rerender);
    clearTimeout(timer);
    clearTimeout(escapeTailTimer);
    clearTimeout(discardTimer);
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGHUP', onSignal);
    if (pageTimer) (timers.clearInterval || clearInterval)(pageTimer);
    input.off('data', onData);
    input.off('end', onEnd);
    output.off('resize', onResize);
    keyboard.off('keypress', onKey);
    keyboard.destroy();
    try { input.setRawMode(oldRaw); } catch (_) {}
    if (!wasFlowing) input.pause();
    output.write(`${theme.resetOsc}\x1b[?1000l\x1b[?1006l\x1b[0m\x1b[?25h\x1b[?1049l\x1b]0;\x07`);
  }
}

module.exports = { runPagedTui, width, cut, pad, wrap, clean, inputView, atCell };
