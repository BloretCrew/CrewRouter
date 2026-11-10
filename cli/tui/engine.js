'use strict';

// Full-screen terminal engine adapted from Blora-Warden's tui-pages.js
// (GPL-3.0-or-later), trimmed to CrewRouter management pages. It keeps the
// original immediate-mode hit map, SGR mouse handling and modal primitives.

const { emitKeypressEvents } = require('node:readline');
const { PassThrough } = require('node:stream');
const { StringDecoder } = require('node:string_decoder');
const { clean, width, cut, pad, wrap } = require('../lib/format');

function cw(ch) {
  const cp = ch.codePointAt(0);
  if (/\p{Mark}/u.test(ch) || cp === 0x200d || cp === 0xfe0f) return 0;
  return cp >= 0x1100 && (
    cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe10 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd)
  ) ? 2 : 1;
}

function visibleInput(value) {
  return [...String(value ?? '')].map(ch => /[\x00-\x1f\x7f-\x9f؜‎‏‪-‮⁦-⁩]/u.test(ch) ? ' ' : ch).join('');
}
function inputView(value, position, limit) {
  const chars = [...visibleInput(value)];
  const at = Math.max(0, Math.min(position, chars.length));
  let start = at, caret = 0;
  while (start > 0) {
    const size = cw(chars[start - 1]);
    if (caret + size > Math.max(0, limit - 1)) break;
    start--;
    caret += size;
  }
  return { text: cut(chars.slice(start).join(''), limit), start, caret };
}
function atCell(view, cell) {
  let n = 0, w = 0;
  for (const ch of view.text) { const x = cw(ch); if (w + x / 2 > cell) break; w += x; n++; }
  return view.start + n;
}
function text(value) {
  return Array.isArray(value) ? value.map(text).join('\n')
    : value == null ? '' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
}

function palette(env) {
  const setting = String(env.CR_COLOR_SCHEME || env.BLORA_COLOR_SCHEME || 'auto').toLowerCase();
  const plain = Object.hasOwn(env, 'NO_COLOR') || env.TERM === 'dumb' || ['plain', 'none', 'off'].includes(setting);
  const light = ['light', 'dawn', 'day'].includes(setting) || (!['dark', 'night'].includes(setting) && ['7', '15'].includes(String(env.COLORFGBG || '').split(';').at(-1)));
  const rgb = /^(truecolor|24bit)$/i.test(env.COLORTERM || '') || /direct|truecolor/i.test(env.TERM || '');
  const c256 = /256color/i.test(env.TERM || '');
  const colors = light
    ? { bg: 'FAF7F8', raised: 'F4ECEE', select: 'E9DEE1', fg: '303143', dim: '555565', rose: '9F5964', amber: '806C4F', danger: '9E5559', line: 'D9D2D6' }
    : { bg: '17161C', raised: '2C2931', select: '3A363F', fg: 'F8F2F4', dim: 'A1979D', rose: 'D18A94', amber: 'BBA27B', danger: 'D27779', line: '413C41' };
  const basic = light
    ? { bg: 107, raised: 107, select: 47, fg: 30, dim: 30, rose: 31, amber: 31, danger: 31, line: 37 }
    : { bg: 40, raised: 40, select: 100, fg: 97, dim: 37, rose: 91, amber: 93, danger: 91, line: 90 };
  function code(name, foreground) {
    if (!rgb && !c256) return basic[name];
    const col = colors[name].match(/../g).map(x => parseInt(x, 16));
    if (rgb) return `${foreground ? 38 : 48};2;${col.join(';')}`;
    const levels = [0, 95, 135, 175, 215, 255];
    let best = 16, dist = Infinity;
    for (let i = 16; i < 256; i++) {
      const n = i - 16;
      const a = i < 232 ? [levels[Math.floor(n / 36)], levels[Math.floor(n / 6) % 6], levels[n % 6]] : Array(3).fill(8 + (i - 232) * 10);
      const d = a.reduce((s, v, k) => s + (v - col[k]) ** 2, 0);
      if (d < dist) { dist = d; best = i; }
    }
    return `${foreground ? 38 : 48};5;${best}`;
  }
  const styles = new Map();
  return (s, fg = 'fg', bg = 'bg', bold = false, decoration = '') => {
    if (plain) return s;
    const key = `${fg}:${bg}:${bold}:${decoration}`;
    if (!styles.has(key)) styles.set(key, `\x1b[${bold ? '1;' : ''}${decoration ? `${decoration};` : ''}${code(fg, true)};${code(bg, false)}m`);
    return `${styles.get(key)}${s}\x1b[0m`;
  };
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
  title = 'CrewRouter CLI',
  refreshMs = 10000,
} = {}) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') throw new Error('TUI 需要交互式终端。');
  if (typeof api !== 'function' || !Array.isArray(pages) || !pages.length) throw new Error('页面或 API 未配置。');

  const paint = palette(env);
  const oldRaw = Boolean(input.isRaw);
  const wasFlowing = input.readableFlowing === true;
  const pageStates = new Map(pages.map(page => [page.id, {
    data: null, loading: false, refreshing: false, lastUpdated: null, error: null,
    scroll: 0, selected: 0, tabIndex: 0, tabViews: {}, cache: null, version: 0,
  }]));
  let active = 0;
  let menuStart = 0;
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
    const page = pages[active], st = state();
    if (!page.tabs?.length) return;
    rememberTab(st, page);
    st.tabIndex = (index + page.tabs.length) % page.tabs.length;
    restoreTab(st, page);
    st.version++;
    render();
  }
  function tabText(page, st, available) {
    const tabs = page.tabs || [], activeTab = currentTab(page, st);
    if (!tabs.length) return { text: '─'.repeat(Math.max(0, available)), spans: [] };
    const index = tabs.indexOf(activeTab);
    const all = `子页  ${tabs.map((tab, i) => `${i + 1} ${tab.label}`).join('  ·  ')}`;
    if (width(all) <= available) {
      const spans = [];
      let cursor = 1 + width('子页  ');
      for (const [i, tab] of tabs.entries()) {
        const label = `${i + 1} ${tab.label}`;
        spans.push({ start: cursor, end: cursor + width(label) - 1, index: i });
        cursor += width(label);
        if (i < tabs.length - 1) cursor += width('  ·  ');
      }
      return { text: all, spans };
    }
    return { text: `‹ ${activeTab.label}  ${index + 1}/${tabs.length} ›`, spans: [] };
  }
  function schedule() { if (!rerender && !closed) rerender = setImmediate(() => { rerender = null; render(); }); }

  function rowsFor(page, data, w, st) {
    const tab = currentTab(page, st);
    if (st.cache && st.cache.width === w && st.cache.version === st.version && st.cache.tab === (tab ? tab.id : null)) return st.cache.rows;
    const rows = [];
    const add = (line, kind = 'text', action = null) => rows.push({ line, kind, action });
    add(page.label, 'title');
    if (page.description) for (const line of wrap(page.description, w)) add(line, 'muted');
    add('');
    if (st.loading) add('正在加载，请稍候…', 'muted');
    if (st.error) for (const line of wrap(`加载失败：${st.error}。按 r 重试。`, w)) add(line, 'warning');
    if (data) {
      const actions = (Array.isArray(data.actions) ? data.actions : []).filter(action => !tab || !action.tab || action.tab === tab.id);
      const inner = Math.max(1, w - 4);
      const frame = (value, kind = 'panel', action = null) => add(`│ ${pad(value, inner)} │`, kind, action);
      const panelTop = panelTitle => add(`╭─ ${pad(clean(panelTitle), Math.max(0, w - 4))}╮`, 'panelTitle');
      const panelBottom = () => add(`╰${'─'.repeat(Math.max(0, w - 2))}╯`, 'panelEdge');
      const showSection = section => {
        panelTop(section.title || '');
        if (section.description) for (const line of wrap(section.description, inner)) frame(line, 'panelMuted');
        const cards = Array.isArray(section.cards) ? section.cards : [];
        if (cards.length) {
          const count = inner >= 66 ? 3 : inner >= 42 ? 2 : 1;
          for (let start = 0; start < cards.length; start += count) {
            const group = cards.slice(start, start + count);
            const size = Math.max(4, Math.floor((inner - (group.length - 1)) / group.length));
            const each = fn => frame(group.map(card => pad(fn(card), size)).join(' '));
            each(() => `╭${'─'.repeat(Math.max(0, size - 2))}╮`);
            each(card => `│${pad(clean(text(card.label)), size - 2)}│`);
            each(card => `│${pad(clean(text(card.value)), size - 2)}│`);
            if (group.some(card => card.detail)) each(card => `│${pad(clean(text(card.detail)), size - 2)}│`);
            each(() => `╰${'─'.repeat(Math.max(0, size - 2))}╯`);
          }
        }
        for (const row of section.rows || []) {
          const obj = typeof row === 'string' ? { label: row } : row;
          if (!obj) continue;
          const action = typeof obj.run === 'function' && !obj.disabled ? obj : null;
          const lines = wrap(clean(obj.label || ''), inner);
          lines.forEach((line, i) => frame(`${i ? '  ' : ''}${line}${!i && action ? '  ›' : ''}`, action ? 'panelAction' : 'panel', !i ? action : null));
          if (obj.detail) for (const line of wrap(text(obj.detail), Math.max(1, inner - 2))) frame(`  ${line}`, 'panelMuted');
        }
        if (!(section.rows || []).length && !cards.length) frame('暂无记录', 'panelMuted');
        panelBottom();
        add('');
      };
      const sections = (Array.isArray(data.sections) ? data.sections : []).filter(section => !tab || !section.tab || section.tab === tab.id);
      if (sections.length) showSection(sections[0]);
      if (actions.length) {
        panelTop('操作');
        for (const action of actions) if (action && action.label) frame(`[${clean(action.label)}]`, action.disabled ? 'panelMuted' : 'panelAction', action.disabled ? null : action);
        panelBottom();
        add('');
      }
      for (const section of sections.slice(1)) showSection(section);
    }
    if (!data && !st.loading && !st.error) add('尚无数据。', 'muted');
    st.cache = { width: w, version: st.version, tab: tab ? tab.id : null, rows };
    return rows;
  }

  function render() {
    if (closed) return;
    if (rerender) { clearImmediate(rerender); rerender = null; }
    const cols = Math.max(1, output.columns || 80);
    const height = Math.max(1, output.rows || 24);
    const st = state();
    const page = pages[active];
    const compact = cols < 76;
    const side = compact ? 0 : 24;
    const body = Math.max(0, height - 4);
    const main = Math.max(1, cols - side - (side ? 1 : 0));
    const list = rowsFor(page, st.data, main, st);
    const maxScroll = Math.max(0, list.length - body);
    st.scroll = Math.max(0, Math.min(st.scroll, maxScroll));
    if (focus === 'content' && !list[st.selected]?.action) {
      const first = list.findIndex(row => row.action);
      if (first >= 0) st.selected = first;
    }
    const start = st.scroll;
    const end = Math.min(list.length, start + body);
    const activeTab = currentTab(page, st);
    let header = compact ? `[菜单]  ${page.label}${activeTab ? ` · ${activeTab.label}` : ''}`
      : ` ${title}  ·  ${page.label}${activeTab ? `  /  ${activeTab.label}` : ''}`;
    hit = { cols, height, compact, side, body, rows: [], tabSpans: [], modal: null };
    const tabLine = tabText(page, st, cols);
    hit.tabSpans = tabLine.spans;
    const lines = [
      paint(pad(header, cols), 'rose', 'raised', true),
      paint(pad(tabLine.text, cols), page.tabs?.length ? 'fg' : 'line', 'raised', focus === 'tabs'),
    ];
    if (active < menuStart) menuStart = active;
    if (active >= menuStart + body) menuStart = Math.max(0, active - body + 1);
    for (let i = 0; i < body; i++) {
      const pageIndex = i + menuStart;
      const pageRow = pages[pageIndex];
      let left = '';
      if (side) {
        const label = pageRow ? `${pageIndex === active ? '›' : ' '} ${pageRow.label}` : '';
        left = paint(pad(label, side), pageIndex === active ? 'fg' : 'dim', pageIndex === active ? 'select' : 'bg', pageIndex === active) + paint('│', 'line');
      }
      if (compact && compactMenu) {
        const rowPage = pages[pageIndex];
        const label = rowPage ? `${pageIndex === active ? '›' : ' '} ${rowPage.label}` : '';
        lines.push(paint(pad(label, cols), pageIndex === active ? 'fg' : 'dim', pageIndex === active ? 'select' : 'bg', pageIndex === active));
        if (rowPage) hit.rows.push({ y: i + 3, type: 'page', index: pageIndex });
        continue;
      }
      if (side && pageRow) hit.rows.push({ y: i + 3, type: 'page', index: pageIndex });
      const row = list[start + i];
      let content = pad(row?.line || '', main);
      if (row) {
        const chosen = focus === 'content' && st.selected === start + i && row.action;
        if (chosen) content = content.startsWith('│ ') ? '│›' + content.slice(2) : '›' + content.slice(1);
        const isPanel = row.kind.startsWith('panel');
        content = paint(content,
          row.kind === 'toolFailed' ? 'danger' : row.kind === 'warning' ? 'amber' : row.kind === 'title' || row.kind === 'section' || row.kind === 'panelTitle' ? 'rose' : row.kind === 'muted' || row.kind === 'panelMuted' || row.kind === 'panelEdge' ? 'dim' : 'fg',
          chosen ? 'select' : isPanel ? 'raised' : 'bg',
          row.kind === 'title' || row.kind === 'section' || row.kind === 'panelTitle' || chosen);
        if (row.action) {
          const base = side ? side + 2 : 1;
          hit.rows.push({ y: i + 3, type: 'action', index: start + i, start: base, end: cols });
        }
      } else content = paint(content);
      lines.push(left + content);
    }
    const info = st.loading ? '正在加载…' : st.refreshing ? '正在刷新…' : busy ? status || '正在处理…' : status;
    const freshness = st.lastUpdated ? `更新 ${new Date(st.lastUpdated).toLocaleTimeString('zh-CN', { hour12: false })}${Date.now() - st.lastUpdated > 30000 ? '（可能过期）' : ''}` : '';
    const infoText = `${freshness}${freshness && info ? ' · ' : ''}${info || ''}${list.length > body ? `   ${start + 1}-${end}/${list.length}` : ''}`;
    const refresh = '[刷新]', service = '[服务]', quit = '[退出]';
    lines.push(paint(pad(infoText, Math.max(0, cols - width(refresh) - width(service) - width(quit) - 2)) + refresh + ' ' + service + ' ' + quit, 'dim', 'raised'));
    const hints = compact
      ? '点击菜单或方向键导航 · Enter 打开 · 滚轮滚动 · q 退出'
      : focus === 'tabs' ? '←→ 切换子页 · Enter 打开 · Tab 下一区域 · Esc 返回导航'
        : '↑↓ 选择 · Tab 切换区域 · ←→ 子页 · Enter 打开 · 滚轮滚动 · 点击可用';
    lines.push(paint(pad(hints, cols), 'dim', 'raised'));
    hit.refreshStart = Math.max(1, cols - width(refresh) - width(service) - width(quit) - 1);
    hit.serviceStart = Math.max(1, cols - width(service) - width(quit));
    hit.quitStart = Math.max(1, cols - width(quit) + 1);

    let overlay = '';
    let cursor = '\x1b[?25l';
    if (modal) {
      const boxWidth = Math.min(cols, 76);
      const inner = Math.max(1, boxWidth - 4);
      if (!modal.descriptionCache || modal.descriptionCache.width !== inner) {
        modal.descriptionCache = { width: inner, rows: wrap(modal.description || '', inner) };
      }
      const question = modal.descriptionCache.rows;
      const isChoose = modal.type === 'choose';
      const isInput = modal.type === 'input';
      const isForm = modal.type === 'form';
      const isConfirm = modal.type === 'confirm';
      const detail = [];
      for (const line of question) detail.push({ text: line });
      if (isChoose) modal.options.forEach((option, index) => detail.push({ text: `${index === modal.selected ? '›' : ' '} ${clean(option.label)}`, option: index }));
      if (isForm) modal.fields.forEach((field, index) => {
        const raw = modal.values[index];
        const shown = field.secret ? '•'.repeat([...String(raw)].length)
          : field.type === 'boolean' ? (raw ? '是' : '否')
            : field.options ? (field.options.find(option => option.value === raw)?.label ?? String(raw))
              : String(raw);
        detail.push({ text: `${index === modal.selected ? '›' : ' '} ${clean(field.label)}`, field: index });
        const view = inputView(shown, modal.positions[index], Math.max(1, inner - 4));
        detail.push({ text: `    ${view.text}`, field: index, view });
      });
      const compactControls = inner < 16;
      const label = (name, marked = false) => compactControls ? `${name}${marked ? '*' : ''}` : `[${name}${marked ? '*' : ''}]`;
      const confirmButtons = [[label('确认', modal.button === 0), 'ok'], [label('取消', modal.button !== 0), 'cancel']];
      const buttonDefs = isInput ? [[label('确定'), 'ok'], [label('取消'), 'cancel']]
        : isChoose ? [[label('选择'), 'ok'], [label('取消'), 'cancel']]
          : isForm ? [[label(clean(modal.submitLabel || '保存')), 'ok'], [label('取消'), 'cancel']]
            : isConfirm ? confirmButtons : [[label('关闭'), 'ok']];
      const buttonRows = [[]];
      for (const [name, action] of buttonDefs) {
        let row = buttonRows.at(-1);
        const used = row.reduce((n, item) => n + width(item[0]), 0) + Math.max(0, row.length - 1);
        if (row.length && used + 1 + width(name) > inner) { row = []; buttonRows.push(row); }
        row.push([name, action]);
      }
      const available = Math.max(1, Math.min(detail.length || 1, height - 2 - buttonRows.length - (isInput ? 1 : 0)));
      const boxHeight = available + 2 + buttonRows.length + (isInput ? 1 : 0);
      const top = Math.max(1, Math.floor((height - boxHeight) / 2) + 1);
      const left = Math.max(1, Math.floor((cols - boxWidth) / 2) + 1);
      modal.scroll = Math.max(0, Math.min(modal.scroll, Math.max(0, detail.length - available)));
      if ((isChoose || isForm) && modal.followSelection) {
        const selectedLine = isForm ? detail.findIndex(row => row.field === modal.selected && row.view) : question.length + modal.selected;
        if (selectedLine < modal.scroll) modal.scroll = selectedLine;
        if (selectedLine >= modal.scroll + available) modal.scroll = selectedLine - available + 1;
      }
      const border = value => `│ ${pad(value, inner)} │`;
      const titleText = cut(clean(modal.title) + (detail.length > available ? ' ↕ PgUp/PgDn' : ''), Math.max(1, boxWidth - 5));
      const listRows = detail.length ? detail.slice(modal.scroll, modal.scroll + available) : [{ text: '' }];
      const parts = [`┌ ${pad(titleText, Math.max(0, boxWidth - 4))}┐`, ...listRows.map(row => border(row.text))];
      let inputRow = 0;
      let inputViewData = null;
      if (isInput) {
        inputRow = top + parts.length;
        const shown = modal.secret ? '•'.repeat([...modal.value].length) : modal.value;
        inputViewData = inputView(shown, modal.position, Math.max(0, inner - 2));
        parts.push(border(`› ${inputViewData.text}`));
      }
      const firstButtonRow = top + parts.length;
      const buttons = [];
      buttonRows.forEach((row, index) => {
        let offset = 0;
        const base = row.map(item => item[0]).join(' ');
        for (const [name, action] of row) {
          const n = width(name);
          if (offset + n <= inner) buttons.push({ row: firstButtonRow + index, start: left + 2 + offset, end: left + 1 + offset + n, action });
          offset += n + 1;
        }
        const hint = isForm ? '  Enter下一项 空格切换' : isConfirm ? '  ←→选择 Enter确定' : '';
        parts.push(border(width(base + hint) <= inner ? base + hint : base));
      });
      parts.push(`└${'─'.repeat(Math.max(0, boxWidth - 2))}┘`);
      overlay = parts.map((line, index) => `\x1b[${top + index};${left}H${paint(pad(line, boxWidth), index === 0 ? 'rose' : 'fg', 'raised', index === 0)}`).join('');
      hit.modal = { left, top, width: boxWidth, height: parts.length, inputRow, buttonRow: firstButtonRow, buttons, descriptionRows: question.length, scroll: modal.scroll, detail, inputView: inputViewData };
      if (isInput) cursor = `\x1b[${inputRow};${Math.min(cols, left + 4 + inputViewData.caret)}H\x1b[?25h`;
      if (isForm) {
        const at = detail.findIndex(row => row.field === modal.selected && row.view);
        if (at >= modal.scroll && at < modal.scroll + available) cursor = `\x1b[${top + 1 + at - modal.scroll};${Math.min(cols, left + 6 + detail[at].view.caret)}H\x1b[?25h`;
      }
    }
    output.write('\x1b[?25l\x1b[H' + lines.slice(0, height).join('\r\n') + '\x1b[J' + overlay + cursor);
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
      modal = { ...spec, resolve, scroll: 0, selected: 0, followSelection: spec.type === 'form', position: [...String(spec.value || '')].length, positions: (spec.values || []).map(value => [...String(value)].length) };
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
    return (await dialog({ type: 'confirm', title: question, description: text(description), button: 1 })) === true;
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
    const page = pages[index], st = pageStates.get(page.id), generation = ++sequence;
    const oldWidth = Math.max(1, hit.cols - (hit.side ? hit.side + 1 : 0));
    const oldSelection = automatic && st.data ? rowsFor(page, st.data, oldWidth, st)[st.selected]?.line : null;
    const oldScroll = st.scroll;
    st.generation = generation;
    if (automatic) st.refreshing = true; else { st.loading = true; st.error = null; st.version++; }
    render();
    const mustDefer = () => automatic && (active !== index || focus !== 'menu' || busy || modal);
    try {
      const result = await page.load(api, ctx);
      if (closed || generation !== sequence || mustDefer()) return;
      st.data = result; st.lastUpdated = Date.now(); st.error = null; st.version++; st.cache = null;
      if (automatic && oldSelection) {
        const newRows = rowsFor(page, result, oldWidth, st);
        const selected = newRows.findIndex(row => row.action && row.line === oldSelection);
        st.selected = selected >= 0 ? selected : 0;
        st.scroll = oldScroll;
      } else if (!automatic) { st.scroll = 0; st.selected = 0; }
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
        st.loading = false; st.refreshing = false; st.version++;
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
    if (!st.data) await load(next); else render();
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
    try { await action.run(ctx); }
    catch (error) {
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
  function onKey(str, key = {}) {
    if (key.ctrl && key.name === 'c') { if (modal) closeModal(null); else closed = true; return; }
    if (modal) {
      if (key.name === 'escape') { closeModal(null); return; }
      if (modal.type === 'confirm') {
        if (key.name === 'left' || key.name === 'right' || key.name === 'tab') modal.button = modal.button === 0 ? 1 : 0;
        else if (key.name === 'return') { closeModal(modal.button === 0); return; }
      } else if (modal.type === 'form') {
        if (key.name === 'pageup' || key.name === 'pagedown') { modal.followSelection = false; modal.scroll = Math.max(0, modal.scroll + (key.name === 'pageup' ? -1 : 1) * Math.max(1, hit.height - 6)); }
        else if (key.name === 'up' || key.name === 'down' || key.name === 'tab') { modal.selected = Math.max(0, Math.min(modal.fields.length - 1, modal.selected + (key.name === 'up' ? -1 : 1))); modal.followSelection = true; }
        else if (key.name === 'return') { if (modal.selected < modal.fields.length - 1) { modal.selected++; modal.followSelection = true; } else { closeModal(modal.values); return; } }
        else {
          const field = modal.fields[modal.selected], current = modal.values[modal.selected];
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
      } else {
        if (key.name === 'return') { closeModal(modal.type === 'input' ? modal.value : modal.type === 'choose' ? modal.selected : true); return; }
        if (modal.type === 'choose' && (key.name === 'up' || key.name === 'down')) chooseDelta(key.name === 'up' ? -1 : 1);
        else if (['pageup', 'pagedown', 'up', 'down'].includes(key.name)) {
          const step = key.name === 'pageup' || key.name === 'pagedown' ? Math.max(1, hit.height - 6) : 1;
          modal.scroll = Math.max(0, modal.scroll + (['up', 'pageup'].includes(key.name) ? -step : step));
        } else if (modal.type === 'input') {
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
        }
      }
      render();
      return;
    }
    if (busy) return;
    const st = state();
    const w = Math.max(1, hit.cols - (hit.side ? hit.side + 1 : 0));
    const rows = rowsFor(pages[active], st.data, w, st);
    if (key.name === 'q') { closed = true; return; }
    if (key.name === 'r') { void load(); return; }
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
          if (index < st.scroll) st.scroll = index;
          else if (index >= st.scroll + hit.body) st.scroll = index - hit.body + 1;
        } else st.scroll = Math.max(0, st.scroll + delta);
      }
    } else if (key.name === 'pageup' || key.name === 'pagedown') {
      focus = 'content';
      st.scroll = Math.max(0, st.scroll + (key.name === 'pageup' ? -1 : 1) * Math.max(1, hit.body - 1));
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
    const w = Math.max(1, hit.cols - (hit.side ? hit.side + 1 : 0));
    const rows = rowsFor(pages[active], st.data, w, st);
    if (!rows[st.selected]?.action) {
      const first = rows.findIndex(row => row.action);
      if (first >= 0) st.selected = first;
    }
    if (rows[st.selected]?.action) {
      if (st.selected < st.scroll) st.scroll = st.selected;
      else if (st.selected >= st.scroll + hit.body) st.scroll = Math.max(0, st.selected - hit.body + 1);
    }
  }
  function activatePage(index) { if (index < 0 || index >= pages.length || busy) return; void navigate(pages[index].id); }
  function activateRow(index) {
    const st = state();
    const w = Math.max(1, hit.cols - (hit.side ? hit.side + 1 : 0));
    const row = rowsFor(pages[active], st.data, w, st)[index];
    if (!row?.action) return;
    st.selected = index;
    void execute(row.action);
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
      if (wheel && x >= box.left && x < box.left + box.width && y >= box.top && y < box.top + box.height) {
        if (modal.type === 'choose') chooseDelta(direction * 3);
        else { modal.followSelection = false; modal.scroll = Math.max(0, modal.scroll + direction * 3); }
      } else if (press) {
        const button = box.buttons.find(item => y === item.row && x >= item.start && x <= item.end);
        if (button) {
          if (button.action === 'cancel') closeModal(null);
          else closeModal(modal.type === 'input' ? modal.value : modal.type === 'choose' ? modal.selected : modal.type === 'form' ? modal.values : true);
          return;
        }
        if (modal.type === 'input' && y === box.inputRow && x >= box.left + 4 && box.inputView) modal.position = atCell(box.inputView, x - (box.left + 4));
        if ((modal.type === 'choose' || modal.type === 'form') && y > box.top && y < box.buttonRow) {
          const line = box.detail[y - box.top - 1 + modal.scroll];
          const index = modal.type === 'choose' ? line?.option : line?.field;
          if (modal.type === 'choose' && index >= 0 && index < modal.options.length) { modal.selected = index; closeModal(index); return; }
          if (modal.type === 'form' && index >= 0 && index < modal.fields.length) {
            modal.selected = index;
            modal.followSelection = true;
            const field = modal.fields[index];
            if (field.type === 'boolean') modal.values[index] = !modal.values[index];
            else if (field.options?.length) {
              const current = field.options.findIndex(option => option.value === modal.values[index]);
              modal.values[index] = field.options[(current + 1) % field.options.length].value;
            } else if (line.view) modal.positions[index] = atCell(line.view, Math.max(0, x - (box.left + 6)));
          }
        }
      }
      render();
      return;
    }
    if (busy) return;
    if (press && y === 2 && hit.tabSpans.length) {
      const tab = hit.tabSpans.find(item => x >= item.start && x <= item.end);
      if (tab) { switchTab(tab.index); return; }
    }
    if (press && hit.compact && y === 1 && x <= 6) { compactMenu = !compactMenu; focus = 'menu'; render(); return; }
    if (press && y === hit.height - 1) {
      if (x >= hit.quitStart) { closed = true; return; }
      if (x >= hit.serviceStart) { void navigate('service'); return; }
      if (x >= hit.refreshStart) { void load(); return; }
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
    else if (press && y >= 3 && y < 3 + hit.body && (!hit.side || x > hit.side)) { focus = 'content'; render(); }
  }

  const keyboard = new PassThrough();
  const decoder = new StringDecoder('utf8');
  let buffer = '', timer = null, afterEscape = false, escapeTail = '', escapeTailTimer = null, discardMouse = false, discardTimer = null;
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
    output.write('\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h');
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
    output.write('\x1b[?1000l\x1b[?1006l\x1b[0m\x1b[?25h\x1b[?1049l');
  }
}

module.exports = { runPagedTui, palette, width, cut, pad, wrap, clean, inputView, atCell };
