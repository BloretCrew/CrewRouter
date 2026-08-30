'use strict';

const MONEY_SCALE = 6;
const MONEY_FACTOR = 10n ** BigInt(MONEY_SCALE);

function expandExponential(value) {
  const text = String(value).trim();
  if (!/[eE]/.test(text)) return text;
  const match = text.match(/^([+-]?)(\d+)(?:\.(\d*))?[eE]([+-]?\d+)$/);
  if (!match) throw new TypeError(`无效金额: ${text}`);
  const sign = match[1];
  const digits = match[2] + (match[3] || '');
  const decimalAt = match[2].length + Number(match[4]);
  if (decimalAt <= 0) return `${sign}0.${'0'.repeat(-decimalAt)}${digits}`;
  if (decimalAt >= digits.length) return `${sign}${digits}${'0'.repeat(decimalAt - digits.length)}`;
  return `${sign}${digits.slice(0, decimalAt)}.${digits.slice(decimalAt)}`;
}

function toMoneyMicros(value) {
  if (typeof value === 'bigint') return value;
  if (value === null || value === undefined || value === '') return 0n;
  if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('金额必须是有限数字');

  const text = expandExponential(value);
  const match = text.match(/^([+-]?)(\d+)(?:\.(\d*))?$/);
  if (!match) throw new TypeError(`无效金额: ${text}`);
  const negative = match[1] === '-';
  const fraction = match[3] || '';
  const kept = fraction.slice(0, MONEY_SCALE).padEnd(MONEY_SCALE, '0');
  const discarded = fraction.slice(MONEY_SCALE);
  let micros = BigInt(match[2]) * MONEY_FACTOR + BigInt(kept || '0');
  if (discarded && discarded[0] >= '5') micros += 1n;
  return negative ? -micros : micros;
}

function moneyMicrosToString(micros) {
  const value = typeof micros === 'bigint' ? micros : BigInt(micros);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / MONEY_FACTOR;
  const fraction = String(absolute % MONEY_FACTOR).padStart(MONEY_SCALE, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

function moneyToString(value) {
  return moneyMicrosToString(toMoneyMicros(value));
}

function moneyToApiNumber(value) {
  return Number(moneyToString(value));
}

function addMoney(left, right) {
  return moneyMicrosToString(toMoneyMicros(left) + toMoneyMicros(right));
}

function subtractMoney(left, right) {
  return moneyMicrosToString(toMoneyMicros(left) - toMoneyMicros(right));
}

function compareMoney(left, right) {
  const a = toMoneyMicros(left);
  const b = toMoneyMicros(right);
  return a === b ? 0 : (a < b ? -1 : 1);
}

function minMoney(left, right) {
  return compareMoney(left, right) <= 0 ? moneyToString(left) : moneyToString(right);
}

module.exports = {
  MONEY_SCALE,
  MONEY_FACTOR,
  toMoneyMicros,
  moneyMicrosToString,
  moneyToString,
  moneyToApiNumber,
  addMoney,
  subtractMoney,
  compareMoney,
  minMoney,
};
