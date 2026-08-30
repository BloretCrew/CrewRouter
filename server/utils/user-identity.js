'use strict';

function normalizeEmail(value) {
  if (value === undefined) return undefined;
  if (value === null || String(value).trim() === '') return null;
  const email = String(value).trim().toLowerCase();
  if (email.length > 255 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    const error = new Error('邮箱格式无效');
    error.code = 'invalid_email';
    throw error;
  }
  return email;
}

function isUniqueViolation(error) { return error?.code === '23505'; }
module.exports = { normalizeEmail, isUniqueViolation };
