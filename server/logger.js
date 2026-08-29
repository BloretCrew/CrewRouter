const fs = require('fs');
const path = require('path');

// 日志目录与文件
const logDir = path.join(__dirname, '../log');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const logFileName = `BSTUDIO-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}.log`;
const logStream = fs.createWriteStream(path.join(logDir, logFileName), { flags: 'a' });

function writeToFile(line) {
  logStream.write(line + '\n');
}

function timestamp() {
  const d = new Date();
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function sanitizeUrl(value) {
  if (typeof value !== 'string') return value;
  try {
    const parsed = new URL(value, 'http://localhost');
    parsed.search = '';
    return parsed.href.replace(/^http:\/\/localhost/, '');
  } catch {
    return value.replace(/[?][^\s]*/g, '');
  }
}

function formatArgs(args) {
  return args.map(a => (typeof a === 'object' ? JSON.stringify(a) : sanitizeUrl(String(a)))).join(' ');
}

const Logger = {
  info(...args) {
    const msg = formatArgs(args);
    console.log('\x1b[36m[INFO]\x1b[0m ' + msg);
    writeToFile(`[${timestamp()}] [INFO] ${msg}`);
  },

  success(...args) {
    const msg = formatArgs(args);
    console.log('\x1b[32m[SUCCESS]\x1b[0m ' + msg);
    writeToFile(`[${timestamp()}] [SUCCESS] ${msg}`);
  },

  warn(...args) {
    const msg = formatArgs(args);
    console.log('\x1b[33m[WARN]\x1b[0m ' + msg);
    writeToFile(`[${timestamp()}] [WARN] ${msg}`);
  },

  error(...args) {
    const msg = formatArgs(args);
    console.error('\x1b[31m[ERROR]\x1b[0m ' + msg);
    writeToFile(`[${timestamp()}] [ERROR] ${msg}`);
  },

  debug(...args) {
    const msg = formatArgs(args);
    console.log('\x1b[90m[DEBUG]\x1b[0m ' + msg);
    writeToFile(`[${timestamp()}] [DEBUG] ${msg}`);
  },

  stream(...args) {
    const msg = formatArgs(args);
    console.log('\x1b[96m[STREAM]\x1b[0m ' + msg);
    writeToFile(`[${timestamp()}] [STREAM] ${msg}`);
  },

  request(method, url, status, user, duration, ip, errorMsg) {
    errorMsg = errorMsg || '';
    const methodColors = { GET: '\x1b[32m', POST: '\x1b[33m', PUT: '\x1b[36m', DELETE: '\x1b[31m', PATCH: '\x1b[35m' };
    const mColor = methodColors[method] || '\x1b[37m';
    let sColor = '\x1b[32m';
    if (status >= 500) sColor = '\x1b[31m';
    else if (status >= 400) sColor = '\x1b[33m';
    let uColor = '\x1b[90m';
    if (user !== 'Guest') uColor = '\x1b[35m';

    const errStr = errorMsg ? ('\x1b[31m' + errorMsg + '\x1b[0m') : '';
    const safeUrl = sanitizeUrl(url);
    const consoleLine = mColor + method + '\x1b[0m ' + safeUrl + ' ' + sColor + status + '\x1b[0m ' + uColor + '[' + user + ']\x1b[0m \x1b[36m' + duration + 'ms\x1b[0m \x1b[90m[' + ip + ']\x1b[0m' + errStr;
    console.log(consoleLine);

    const fileLine = '[' + timestamp() + '] [REQUEST] ' + method + ' ' + safeUrl + ' ' + status + ' [' + user + '] ' + duration + 'ms [' + ip + ']' + errorMsg;
    writeToFile(fileLine);
  }
};

module.exports = Logger;
