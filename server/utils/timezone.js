/**
 * 应用统一时区：Asia/Shanghai（中国无夏令时，固定 UTC+8）
 */

const APP_TIMEZONE = 'Asia/Shanghai';

/** 确保进程时区为上海，避免 Date 本地化与 SQL 墙钟不一致 */
function ensureProcessTimezone() {
  if (process.env.TZ !== APP_TIMEZONE) {
    process.env.TZ = APP_TIMEZONE;
  }
}

/**
 * 返回 Asia/Shanghai 日历日 YYYY-MM-DD
 * @param {Date|string|number} [date]
 */
function shanghaiDateString(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(date));
}

/**
 * 返回从 today-Shanghai 往前 (days-1) 天的起始日期 YYYY-MM-DD（含首尾共 days 天）
 * @param {number} days
 */
function shanghaiDateRange(days = 30) {
  const end = shanghaiDateString();
  // 用正午 UTC 锚定，加减整天不会跨日错位
  const endUtcNoon = new Date(`${end}T12:00:00Z`);
  const startUtcNoon = new Date(endUtcNoon.getTime() - (Math.max(1, days) - 1) * 86400000);
  const start = startUtcNoon.toISOString().slice(0, 10);
  return { start, end };
}

/**
 * 格式化为上海本地可读时间：YYYY-MM-DD HH:mm:ss
 * @param {Date|string|number|null|undefined} date
 */
function formatShanghaiDateTime(date) {
  if (date == null || date === '') return '';
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(d);
  const get = (type) => parts.find(p => p.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

/**
 * 上海时区当日 00:00:00 对应的 Date（绝对时刻）
 */
function shanghaiStartOfToday() {
  const day = shanghaiDateString();
  return new Date(`${day}T00:00:00+08:00`);
}

module.exports = {
  APP_TIMEZONE,
  ensureProcessTimezone,
  shanghaiDateString,
  shanghaiDateRange,
  formatShanghaiDateTime,
  shanghaiStartOfToday
};
