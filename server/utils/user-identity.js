'use strict';

// Accepts only undefined, null, or strings; undefined is omitted and blank strings clear the column.
function normalizeEmail(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') {
    const error = new TypeError('邮箱必须是字符串、null 或 undefined');
    error.code = 'invalid_email';
    throw error;
  }
  if (value.trim() === '') return null;
  const email = value.trim().toLowerCase();

  if (email.length > 255 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    const error = new Error('邮箱格式无效');
    error.code = 'invalid_email';
    throw error;
  }
  return email;
}

function isUniqueViolation(error) { return error?.code === '23505'; }
module.exports = { normalizeEmail, isUniqueViolation };
