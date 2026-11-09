'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

let instance = null;

const UNSUPPORTED_OPTIONS = ['pool', 'session', 'features', 'console', 'oauthRoutes'];

/**
 * Create an in-process CrewRouter instance.
 *
 * This is the preview embedded SDK: one instance per process, root mount only,
 * and configuration must be supplied before any CrewRouter module is loaded.
 *
 * @param {object} options
 * @param {object} [options.config]      Config object (written to a private temp file)
 * @param {string} [options.configPath]  Existing config file
 * @param {boolean} [options.migrate]    Run startup migrations (default false)
 * @param {boolean} [options.backgroundTasks] Start schedulers/key refresh (default false)
 * @param {boolean} [options.plugins]    Load plugins (default false)
 * @param {boolean} [options.store]      Initialize plugin store (default false)
 * @param {boolean} [options.handleSignals] Install SIGINT/SIGTERM handlers (default false)
 * @returns {{ app: import('express').Express, config: object, readonly server: import('node:http').Server|null, start: Function, stop: Function }}
 */
function createCrewRouter(options = {}) {
  if (instance) {
    const error = new Error(
      'ERR_CREWROUTER_MULTIPLE_INSTANCES: only one embedded CrewRouter instance is supported per process',
    );
    error.code = 'ERR_CREWROUTER_MULTIPLE_INSTANCES';
    throw error;
  }
  if (options.basePath) {
    const error = new Error(
      'ERR_CREWROUTER_BASE_PATH_UNSUPPORTED: mount CrewRouter at the root path or strip the prefix with a reverse proxy',
    );
    error.code = 'ERR_CREWROUTER_BASE_PATH_UNSUPPORTED';
    throw error;
  }
  for (const key of UNSUPPORTED_OPTIONS) {
    if (options[key] !== undefined) {
      const error = new Error(
        `ERR_CREWROUTER_UNSUPPORTED_OPTION: "${key}" is not supported by the preview embedded SDK`,
      );
      error.code = 'ERR_CREWROUTER_UNSUPPORTED_OPTION';
      throw error;
    }
  }

  let tempDir = null;
  if (options.configPath) {
    process.env.CR_CONFIG_PATH = path.resolve(options.configPath);
  } else if (options.config) {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewrouter-embedded-'));
    const configPath = path.join(tempDir, 'config.json');
    fs.writeFileSync(configPath, `${JSON.stringify(options.config, null, 2)}\n`, { mode: 0o600 });
    process.env.CR_CONFIG_PATH = configPath;
  }

  // These flags must be set before server/index.js (and therefore config-loader)
  // is required. config-loader freezes its result on first load.
  process.env.CR_EMBEDDED = '1';
  process.env.CR_SKIP_AUTOSTART = '1';

  const app = require('../index');
  const config = require('../config-loader');

  let currentServer = null;
  let started = false;
  let stopped = false;

  const api = {
    app,
    config,
    get server() {
      return currentServer;
    },
    async start(startOptions = {}) {
      if (stopped) {
        const error = new Error('ERR_CREWROUTER_STOPPED: this instance has already been stopped');
        error.code = 'ERR_CREWROUTER_STOPPED';
        throw error;
      }
      if (started) return currentServer;
      started = true;
      currentServer = await app.startServer({
        embedded: true,
        listen: startOptions.listen !== false,
        port: startOptions.port,
        host: startOptions.host,
        migrate: startOptions.migrate !== undefined ? startOptions.migrate : options.migrate === true,
        backgroundTasks: startOptions.backgroundTasks !== undefined
          ? startOptions.backgroundTasks
          : options.backgroundTasks === true,
        plugins: startOptions.plugins !== undefined ? startOptions.plugins : options.plugins === true,
        store: startOptions.store !== undefined ? startOptions.store : options.store === true,
        handleSignals: startOptions.handleSignals !== undefined
          ? startOptions.handleSignals
          : options.handleSignals === true,
      });
      return currentServer;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      try {
        await app.stopServer();
      } finally {
        currentServer = null;
        instance = null;
        if (tempDir) {
          try {
            fs.rmSync(tempDir, { recursive: true, force: true });
          } catch (_) {
            // temp directory cleanup is best-effort
          }
          tempDir = null;
        }
      }
    },
  };

  instance = api;
  return api;
}

module.exports = { createCrewRouter };
