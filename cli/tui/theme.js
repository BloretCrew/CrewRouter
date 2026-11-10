'use strict';

// Palette values copied from Blora-Agent's crates/blora-tui/src/theme.rs,
// which mirrors @bloret-crew/blora-design theme tokens.

const PALETTES = {
  coral: {
    zh: '珊瑚',
    about: '深靛灰与柔和珊瑚红',
    dark: { bg: '17161C', raised: '2C2931', select: '3A363F', fg: 'F8F2F4', dim: 'A1979D', mute: '786F75', rose: 'D18A94', sage: '86A399', amber: 'BBA27B', danger: 'D27779', line: '413C41' },
    light: { bg: 'FAF7F8', raised: 'F4ECEE', select: 'E9DEE1', fg: '303143', dim: '555565', mute: '74717C', rose: '9F5964', sage: '5B756B', amber: '806C4F', danger: '9E5559', line: 'D9D2D6' },
  },
  indigo: {
    zh: '靛蓝',
    about: '冷灰基底与沉静蓝',
    dark: { bg: '12151B', raised: '252A34', select: '313743', fg: 'F3F5F8', dim: '959CA8', mute: '6D7581', rose: '8FA8CF', sage: '84A79E', amber: 'C3A477', danger: 'D1848A', line: '3A414C' },
    light: { bg: 'F4F5F8', raised: 'ECEEF5', select: 'E0E4ED', fg: '191D26', dim: '454C5B', mute: '687080', rose: '405D87', sage: '55756F', amber: 'AF8A55', danger: 'A74B52', line: 'D2D6DF' },
  },
  graphite: {
    zh: '石墨',
    about: '冷灰界面与低饱和钢蓝',
    dark: { bg: '111316', raised: '24282E', select: '30353D', fg: 'F3F4F6', dim: '979EA8', mute: '6F7782', rose: '91A5B7', sage: '86A399', amber: 'BDA67E', danger: 'C9898D', line: '3B4149' },
    light: { bg: 'F6F7F8', raised: 'F0F2F4', select: 'E3E6EA', fg: '171A1F', dim: '414751', mute: '68707C', rose: '4F6578', sage: '5B756B', amber: '806C4F', danger: '9B5E63', line: 'D3D7DC' },
  },
  mono: {
    zh: '单色',
    about: '纯中性灰与近黑主色',
    dark: { bg: '111110', raised: '242422', select: '30302D', fg: 'FAFAF9', dim: '9A9A94', mute: '71716C', rose: 'D8DADD', sage: 'A0AAA5', amber: 'B0A58F', danger: 'B99699', line: '3B3B38' },
    light: { bg: 'FAFAF9', raised: 'F3F3F1', select: 'E8E8E5', fg: '111110', dim: '454542', mute: '6F6F69', rose: '34363A', sage: '616D67', amber: '756A58', danger: '815C60', line: 'D8D8D3' },
  },
  circuit: {
    zh: '电路',
    about: '碳灰界面与克制青色',
    dark: { bg: '101414', raised: '232A2A', select: '303838', fg: 'F1F4F4', dim: '929D9D', mute: '697575', rose: '7FADAF', sage: '7DA394', amber: 'BAA27B', danger: 'C98286', line: '394242' },
    light: { bg: 'F4F5F5', raised: 'ECEEEE', select: 'DDE1E1', fg: '161A1A', dim: '414848', mute: '687171', rose: '3E6C70', sage: '4F7368', amber: '7D6C52', danger: '995D61', line: 'CDD2D2' },
  },
  dusk: {
    zh: '暮色',
    about: '暮色灰紫',
    dark: { bg: '151317', raised: '2A262E', select: '38333D', fg: 'F5F2F6', dim: '9E95A2', mute: '756C79', rose: 'A9A1BA', sage: '82A097', amber: 'B6A078', danger: 'C6818A', line: '403A44' },
    light: { bg: 'F7F6F8', raised: 'F0EEF2', select: 'E4E1E7', fg: '1D1B20', dim: '4B4750', mute: '716C76', rose: '675F78', sage: '5D746C', amber: '806C4F', danger: '995F68', line: 'D6D1D9' },
  },
};

const BASIC = {
  dark: { bg: 40, raised: 40, select: 100, fg: 97, dim: 37, mute: 90, rose: 91, sage: 92, amber: 93, danger: 91, line: 90 },
  light: { bg: 107, raised: 107, select: 47, fg: 30, dim: 37, mute: 90, rose: 31, sage: 32, amber: 33, danger: 31, line: 37 },
};

function parseScheme(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (['auto'].includes(raw)) return 'auto';
  if (['dark', 'night'].includes(raw)) return 'dark';
  if (['light', 'dawn', 'day'].includes(raw)) return 'light';
  if (['plain', 'none', 'off'].includes(raw)) return 'plain';
  return null;
}

function parsePalette(value) {
  const raw = String(value || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(PALETTES, raw) ? raw : null;
}

function detect(env = process.env) {
  let palette = 'coral';
  let scheme = 'auto';
  const preference = String(env.CR_THEME || env.BLORA_THEME || '').trim().toLowerCase();
  if (preference) {
    const [left, right] = preference.split('-');
    palette = parsePalette(left) || palette;
    scheme = parseScheme(right || left) || scheme;
  }
  const explicitPalette = parsePalette(env.CR_PALETTE || env.BLORA_PALETTE || '');
  if (explicitPalette) palette = explicitPalette;
  const explicitScheme = parseScheme(env.CR_COLOR_SCHEME || env.BLORA_COLOR_SCHEME || '');
  if (explicitScheme) scheme = explicitScheme;
  if (Object.hasOwn(env, 'NO_COLOR') || env.TERM === 'dumb') scheme = 'plain';
  if (scheme === 'auto') {
    const background = String(env.COLORFGBG || '').split(';').at(-1);
    scheme = ['7', '15'].includes(background) ? 'light' : 'dark';
  }
  const dark = scheme !== 'light';
  return { palette, scheme, dark, colors: PALETTES[palette][dark ? 'dark' : 'light'] };
}

function createTheme(env = process.env) {
  const detected = detect(env);
  const { colors, palette, scheme, dark } = detected;
  const plain = scheme === 'plain';
  const rgb = /^(truecolor|24bit)$/i.test(env.COLORTERM || '') || /direct|truecolor/i.test(env.TERM || '');
  const c256 = /256color/i.test(env.TERM || '');
  const basic = BASIC[dark ? 'dark' : 'light'];

  function code(name, foreground) {
    if (!rgb && !c256) return basic[name] || (foreground ? 37 : 40);
    const hex = colors[name] || colors.fg;
    const col = hex.match(/../g).map(part => parseInt(part, 16));
    if (rgb) return `${foreground ? 38 : 48};2;${col.join(';')}`;
    const levels = [0, 95, 135, 175, 215, 255];
    let best = 16;
    let distance = Infinity;
    for (let i = 16; i < 256; i++) {
      const n = i - 16;
      const candidate = i < 232
        ? [levels[Math.floor(n / 36)], levels[Math.floor(n / 6) % 6], levels[n % 6]]
        : Array(3).fill(8 + (i - 232) * 10);
      const d = candidate.reduce((sum, value, index) => sum + (value - col[index]) ** 2, 0);
      if (d < distance) { distance = d; best = i; }
    }
    return `${foreground ? 38 : 48};5;${best}`;
  }

  const cache = new Map();
  function paint(text, fg = 'fg', bg = 'bg', bold = false, decoration = '') {
    if (plain) return String(text ?? '');
    const key = `${fg}:${bg}:${bold}:${decoration}`;
    if (!cache.has(key)) cache.set(key, `\x1b[${bold ? '1;' : ''}${decoration ? `${decoration};` : ''}${code(fg, true)};${code(bg, false)}m`);
    return `${cache.get(key)}${text}\x1b[0m`;
  }

  function dimmed(text, fg = 'fg', bg = 'bg', bold = false, decoration = '') {
    const mapped = fg === 'rose' || fg === 'sage' || fg === 'amber' || fg === 'danger' ? 'mute' : fg === 'fg' ? 'dim' : 'mute';
    const bgName = bg === 'select' ? 'raised' : bg;
    return paint(text, mapped, bgName, false, '');
  }

  function oscBackground() {
    if (plain) return '\x1b]111\x07';
    return `\x1b]11;#${colors.bg}\x07`;
  }

  function oscCursor() {
    if (plain) return '\x1b]112\x07';
    return `\x1b]12;#${colors.rose}\x07`;
  }

  return {
    palette,
    scheme,
    dark,
    plain,
    colors,
    paint,
    dimmed,
    osc: `${oscBackground()}${oscCursor()}`,
    resetOsc: '\x1b]111\x07\x1b]112\x07',
  };
}

module.exports = { PALETTES, createTheme, detect, parsePalette, parseScheme };
