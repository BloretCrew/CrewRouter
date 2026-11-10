'use strict';

const { ApiError } = require('./client');

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function success(profile, data) {
  return { ok: true, profile: profile || null, data };
}

function errorPayload(error) {
  return {
    ok: false,
    error: {
      message: error && error.message ? error.message : String(error),
      status: error && error.statusCode ? error.statusCode : undefined,
      code: error && error.code ? error.code : undefined,
    },
  };
}

function printError(error) {
  process.stderr.write(`${JSON.stringify(errorPayload(error), null, 2)}\n`);
}

function exitCodeFor(error) {
  if (!error) return 0;
  if (error.code === 'PARSE_ERROR') return 2;
  if (error.statusCode === 401) return 3;
  if (error.statusCode === 403) return 3;
  if (error.code === 'auth_required') return 3;
  if (error.code === 'PORT_IN_USE' || error.code === 'DB_NOT_CONFIGURED' || error.code === 'NOT_OWNER') return 4;
  if (error.exitCode !== undefined) return 4;
  return 1;
}

function describeError(error) {
  let message = error && error.message ? error.message : String(error);
  const hint = error && error.statusCode === 403 && error.body && error.body.code
    ? `（${error.body.code}）`
    : '';
  if (error instanceof ApiError && error.statusCode) {
    message = `${message} [HTTP ${error.statusCode}${hint}]`;
  }
  return message;
}

module.exports = { printJson, success, errorPayload, printError, exitCodeFor, describeError };
