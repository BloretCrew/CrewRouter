#!/usr/bin/env node
'use strict';

const { printJson, errorPayload, printError, exitCodeFor, describeError } = require('./lib/output');
const { permissionHint } = require('./lib/auth');

const BOOLEAN_FLAGS = new Set([
  'json', 'help', 'yes', 'force', 'follow', 'demo', 'login', 'no-color', 'skip-dsh-plugin',
  'enabled', 'disabled', 'password-stdin', 'api-key-stdin', 'version',
]);

const VALUE_FLAGS = new Set([
  'url', 'profile', 'name', 'username', 'password', 'api-key', 'method',
  'port', 'host', 'config', 'days', 'page', 'page-size', 'lines', 'search',
  'expires-in', 'expiresIn', 'model', 'otp', 'timeout',
]);

function parseArgs(argv) {
  const flags = { _: [] };
  const args = argv.slice();
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    if (value === '--') {
      flags._.push(...args.slice(i + 1));
      break;
    }
    if (value === '-h') { flags.help = true; continue; }
    if (value === '-v') { flags.version = true; continue; }
    if (value === '-y') { flags.yes = true; continue; }
    if (value === '-f') { flags.follow = true; continue; }
    if (value.startsWith('--')) {
      const body = value.slice(2);
      const equal = body.indexOf('=');
      const key = equal >= 0 ? body.slice(0, equal) : body;
      const inline = equal >= 0 ? body.slice(equal + 1) : undefined;
      if (key === 'no-color') { flags.noColor = true; continue; }
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = inline === undefined ? true : inline !== 'false';
        continue;
      }
      if (VALUE_FLAGS.has(key)) {
        const next = inline !== undefined ? inline : args[i + 1];
        if (inline === undefined) {
          if (next === undefined || next.startsWith('-')) {
            flags[key] = true;
          } else {
            flags[key] = next;
            i++;
          }
        } else flags[key] = next;
        continue;
      }
      // Unknown flags are accepted as values so plugins/future flags fail later.
      if (inline !== undefined) flags[key] = inline;
      else if (args[i + 1] && !args[i + 1].startsWith('-')) { flags[key] = args[++i]; }
      else flags[key] = true;
      continue;
    }
    if (value.startsWith('-') && value.length > 1) {
      flags[value.slice(1)] = true;
      continue;
    }
    flags._.push(value);
  }
  return flags;
}

async function dispatch(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.noColor || (!process.stdout.isTTY && !process.env.FORCE_COLOR)) { process.env.NO_COLOR = '1'; delete process.env.FORCE_COLOR; }
  const command = args._[0] || (args.help ? 'help' : args.version ? 'version' : 'tui');
  const json = args.json === true;
  if (command !== 'dsh-plugin' && command !== 'help' && command !== 'version' && command !== 'status' && args['skip-dsh-plugin'] !== true) {
    try { await require('./lib/dsh-plugin').offerFirstRun(); }
    catch (error) { process.stderr.write(`cr: DSH 插件自动安装未完成：${error.message}\n手动重试：cr dsh-plugin install --profile <名称>\n`); }
  }

  try {
    switch (command) {
      case 'tui':
      case 'ui': {
        const { runCliTui } = require('./tui/app');
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
          if (args._[0] === 'tui' || args._[0] === 'ui') {
            throw Object.assign(new Error('TUI 需要交互式终端（TTY）'), { code: 'PARSE_ERROR' });
          }
          const status = require('./lib/commands/status');
          return await status.statusCommand(args, { json });
        }
        return await runCliTui(args);
      }
      case 'status': {
        const status = require('./lib/commands/status');
        return await status.statusCommand(args, { json });
      }
      case 'dsh-plugin': {
        return await require('./lib/dsh-plugin').command(args, { json });
      }
      case 'version': {
        const status = require('./lib/commands/status');
        return await status.versionCommand(args, { json });
      }
      case 'overview': {
        const status = require('./lib/commands/status');
        return await status.overviewCommand(args, { json });
      }
      case 'doctor': {
        const status = require('./lib/commands/status');
        return await status.doctorCommand(args, { json });
      }
      case 'login': {
        const auth = require('./lib/commands/auth');
        return await auth.loginCommand(args, { json });
      }
      case 'logout': {
        const auth = require('./lib/commands/auth');
        return await auth.logoutCommand(args, { json });
      }
      case 'connect': {
        const auth = require('./lib/commands/auth');
        return await auth.connectCommand(args, { json });
      }
      case 'profiles':
      case 'profile': {
        const auth = require('./lib/commands/auth');
        return auth.profilesCommand(args, { json });
      }
      case 'use': {
        const auth = require('./lib/commands/auth');
        return auth.useCommand(args, { json });
      }
      case 'start': {
        const service = require('./lib/commands/service');
        return await service.startCommand(args, { json });
      }
      case 'stop': {
        const service = require('./lib/commands/service');
        return await service.stopCommand(args, { json });
      }
      case 'restart': {
        const service = require('./lib/commands/service');
        return await service.restartCommand(args, { json });
      }
      case 'logs': {
        const service = require('./lib/commands/service');
        return await service.logsCommand(args, { json });
      }
      case 'serve': {
        const service = require('./lib/commands/service');
        return await service.serveCommand(args, { json });
      }
      case 'providers': {
        const resources = require('./lib/commands/resources');
        return await resources.providersCommand(args, { json });
      }
      case 'models': {
        const resources = require('./lib/commands/resources');
        return await resources.modelsCommand(args, { json });
      }
      case 'keys':
      case 'key': {
        const resources = require('./lib/commands/resources');
        return await resources.keysCommand(args, { json });
      }
      case 'usage': {
        const data = require('./lib/commands/data');
        return await data.usageCommand(args, { json });
      }
      case 'sessions':
      case 'session': {
        const data = require('./lib/commands/data');
        return await data.sessionsCommand(args, { json });
      }
      case 'help':
      case '--help': {
        require('./lib/commands/status').printHelp(args._[1]);
        return 0;
      }
      default:
        throw Object.assign(new Error(`未知命令：${command}\n\n${require('./lib/commands/status').HELP_TEXT}`), { code: 'PARSE_ERROR' });
    }
  } catch (error) {
    const code = exitCodeFor(error);
    if (json) printError(error);
    else {
      const hint = permissionHint(error);
      process.stderr.write(`cr: ${describeError(error)}${hint ? `\n${hint}` : ''}\n`);
    }
    return code;
  }
}

if (require.main === module) {
  dispatch().then(code => { process.exitCode = code || 0; });
}

module.exports = { parseArgs, dispatch };
