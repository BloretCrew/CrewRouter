'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('public/js/app.js', 'utf8');
const start = source.indexOf('  async generateToolConfig(tool)');
const end = source.indexOf('  async writeDesktopClientConfig()', start);
const method = source.slice(start, end);
let finish;
const sandbox = { window: {}, document: { getElementById: () => { throw new Error('Expired response touched the DOM'); } }, fetch: () => new Promise(resolve => {finish=resolve;}), t: value=>value, alert:()=>{throw new Error('Unexpected alert');} };
const app = vm.runInNewContext(`({ _configKey:{id:1}, closeModals(){this._configRequestId=(this._configRequestId||0)+1;}, ${method} })`,sandbox);
(async () => {
 const pending=app.generateToolConfig('claude');
 app.closeModals();
 finish({ok:true,json:async()=>({env:{ANTHROPIC_BASE_URL:'https://example.com',ANTHROPIC_AUTH_TOKEN:'fixture-key'}})});
 await pending;
 assert.equal(app._desktopClientConfig,undefined);
 console.log('PASS: canceled configuration generation discards late response without restoring secrets');
})().catch(error=>{console.error(error);process.exitCode=1;});
