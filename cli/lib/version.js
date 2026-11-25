'use strict';

const path = require('node:path');

function loadPackageVersion() {
  for (const candidate of [path.resolve(__dirname, '../../package.json'), path.resolve(__dirname, '../package.json')]) {
    try { return require(candidate).version; } catch (error) { if (error.code !== 'MODULE_NOT_FOUND' || !error.message.includes(candidate)) throw error; }
  }
  return '27.0.0-beta.2';
}

module.exports = { version: loadPackageVersion() };
