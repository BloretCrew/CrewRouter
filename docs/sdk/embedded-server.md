# Embedded server SDK (preview)

The embedded form runs CrewRouter in-process inside a Node/Express application.
A **preview** is available from `crewrouter/embedded`. It is intentionally
limited; the full feature-preset design is a later phase.

> **License:** GPL-3.0. Embedding links the CrewRouter server code into your
> process. Distributing the combined application triggers GPL-3.0 obligations.

## Preview entry point

```js
const { createCrewRouter } = require('crewrouter/embedded');

const cr = createCrewRouter({
  configPath: './crewrouter.config.json', // or config: { ... }
  migrate: false,
  backgroundTasks: false,
  plugins: false,
  store: false,
  handleSignals: false,
});

const server = await cr.start({ port: 0, host: '127.0.0.1' });
console.log(server.address());

// Mount the Express app in a host if you prefer not to listen here:
// app.use('/', cr.app);

await cr.stop();
```

## Supported options

| Option | Default | Description |
| --- | --- | --- |
| `config` | — | Config object; written to a private temp file before modules load |
| `configPath` | auto-discovery | Existing JSON config file |
| `migrate` | `false` | Run startup database init/migrations |
| `backgroundTasks` | `false` | Key refresh, key/quota schedulers, message analysis, stats reporter, aggregation |
| `plugins` | `false` | Load the plugin registry |
| `store` | `false` | Initialize the plugin store tables |
| `handleSignals` | `false` | Install SIGINT/SIGTERM handlers |
| `start({ port, host, listen, ... })` | — | `listen: false` performs startup without listening; per-start overrides for `migrate`, `backgroundTasks`, `plugins`, `store`, `handleSignals` |

`createCrewRouter` returns:

| Member | Description |
| --- | --- |
| `app` | Express application |
| `config` | Resolved (frozen) config object |
| `server` | The HTTP server after `start()`, otherwise `null` |
| `start(options?)` | Resolves with the HTTP server |
| `stop()` | Closes HTTP, stops tracked timers, flushes quota data and closes the pool |

## Unsupported options (throw)

The preview throws `ERR_CREWROUTER_UNSUPPORTED_OPTION` for:

- `pool` — external pg Pool injection
- `session` — session store selection
- `features` — feature presets
- `console` — console/static page toggling
- `oauthRoutes` — OAuth authorization-server toggling
- `basePath` — sub-path mounting

The full phase-2 design will add these; see the table in the repository plan.

## Limitations

- **Root mount only.** Static assets, cookies, OAuth callbacks and CSRF assume
  `/`. Mounting at `/crewrouter` is not supported; strip the prefix with nginx or
  another reverse proxy.
- **One instance per process.** Config, the pg pool and the plugin registry are
  process globals. A second `createCrewRouter` throws
  `ERR_CREWROUTER_MULTIPLE_INSTANCES`.
- **Configuration is frozen on first load.** Pass `config`/`configPath` when you
  create the instance, before requiring any CrewRouter module.
- **The console is always mounted.** The preview cannot disable static pages,
  auth, setup, 2FA or passkey routes.
- **No external pool.** `stop()` closes the pool created from the config.
- **Background task shutdown is partial.** Default is off. If enabled, tracked
  timers are cleared on `stop()`, but not every subsystem exposes a stop hook.
- **PostgreSQL required** outside demo mode. For a first-time database, pass
  `migrate: true`.
- **Express 4 hosts.** Express 5 is not validated.

## Example: host Express app

```js
const express = require('express');
const { createCrewRouter } = require('crewrouter/embedded');

async function main() {
  const host = express();
  const cr = createCrewRouter({
    config: {
      app: { name: 'My Gateway', host: '127.0.0.1', port: 0, sessionSecret: process.env.SESSION_SECRET },
      database: { host: 'localhost', port: 5432, name: 'crewrouter', user: 'crewrouter', password: process.env.DB_PASSWORD },
      edition: 'personal',
      statsReport: { enabled: false },
      loginReport: { enabled: false },
    },
    migrate: true,
    backgroundTasks: false,
    plugins: false,
    store: false,
    handleSignals: false,
  });

  // Run startup work (migrations, edition, optional plugins/tasks) without
  // listening, then mount the app in the host server.
  await cr.start({ listen: false });

  host.use('/', cr.app);
  const server = host.listen(3000, () => console.log('host listening'));
  process.once('SIGTERM', async () => {
    server.close();
    await cr.stop();
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

## Verification

```bash
npm run test:embedded-sdk
```

The test covers start/serve/stop, one-instance enforcement, `basePath`
rejection and unsupported-option rejection.
