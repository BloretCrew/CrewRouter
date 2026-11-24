# Embedded server SDK (limited preview)

The embedded form runs CrewRouter in-process inside a Node/Express application. It is not a generally available production SDK and is excluded from the stable client SDK release commitment. Existing limitations below are part of the preview boundary, not implicit support guarantees.
A **preview** is available from `crewrouter/embedded`. It is intentionally
limited; the full feature-preset design is a later phase.

> **License:** GPL-3.0. Embedding links the CrewRouter server code into your
> process. Distributing the combined application triggers GPL-3.0 obligations.

## Preview entry point

```js
const { createCrewRouter } = require('crewrouter/embedded');

const cr = createCrewRouter({
  configPath: './crewrouter.config.json', // or config: { ... }
  session: false,
  features: ['gateway', 'management', 'events'],
  console: false,
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
| `pool` | owned | External pg Pool; `stop()` does not end it |
| `session` | `false` | `false`/`"none"`, `"memory"`, `"pg"`, or an express-session store |
| `features` | `gateway, management, events` | Array of feature ids, or `"all"` |
| `console` | `false` | Serve pages/static and mount console-only routes |
| `oauthRoutes` | `false` | Add or remove the `oauth` feature |
| `migrate` | `false` | Run startup database init/migrations |
| `backgroundTasks` | `false` | Key refresh, key/quota schedulers, message analysis, stats reporter, aggregation |
| `plugins` | `false` | Load the plugin registry |
| `store` | `false` | Initialize the plugin store tables |
| `handleSignals` | `false` | Install SIGINT/SIGTERM handlers |
| `start({ port, host, listen, ... })` | — | `listen: false` performs startup without listening; per-start overrides for `migrate`, `backgroundTasks`, `plugins`, `store`, `handleSignals` |

Feature ids: `gateway`, `management`, `events`, `tools`, `console`, `oauth`,
`plugins`, `public`. Core middleware (body parsing, auth resolution, CSRF,
permissions, `/api/version`, `/api/config`, `/api/instance`) is always mounted.
`public` (i18n) is always mounted. Feature gating applies to non-demo mode;
demo mode uses its own fixture routes.

`createCrewRouter` returns:

| Member | Description |
| --- | --- |
| `app` | Express application |
| `config` | Resolved (frozen) config object |
| `server` | The HTTP server after `start()`, otherwise `null` |
| `start(options?)` | Resolves with the HTTP server |
| `stop()` | Closes HTTP, stops tracked timers, flushes quota data and closes the pool |

## Validation

The preview rejects invalid configurations before loading any CrewRouter module:

- `basePath` → `ERR_CREWROUTER_BASE_PATH_UNSUPPORTED`
- `pool` without a `query()` function → `ERR_CREWROUTER_INVALID_POOL`
- `session` not in `false`/`"none"`/`"memory"`/`"pg"`/store → `ERR_CREWROUTER_INVALID_SESSION`
- `features` not an array or `"all"` → `ERR_CREWROUTER_INVALID_FEATURES`
- A second instance → `ERR_CREWROUTER_MULTIPLE_INSTANCES`

## Limitations

- **Root mount only.** Static assets, cookies, OAuth callbacks and CSRF assume
  `/`. Mounting at `/crewrouter` is not supported; strip the prefix with nginx or
  another reverse proxy.
- **One instance per process.** Config, the pg pool and the plugin registry are
  process globals. A second `createCrewRouter` throws
  `ERR_CREWROUTER_MULTIPLE_INSTANCES`.
- **Configuration and options are frozen on first load.** Pass `config`,
  `configPath`, `pool`, `session`, `features` and `console` when you create the
  instance, before requiring any CrewRouter module. Per-`start` overrides are
  limited to `migrate`, `backgroundTasks`, `plugins`, `store` and
  `handleSignals`.
- **Feature gating is not applied in demo mode.** Demo uses fixture routes for
  the console showcase.
- **Background task shutdown is partial.** Default is off. If enabled, tracked
  timers are cleared on `stop()`, but not every subsystem exposes a stop hook.
- **PostgreSQL required** outside demo mode. For a first-time database, pass
  `migrate: true`.
- **Express 4 hosts.** Express 5 is not validated.

## GA readiness gate

Do not describe the embedded SDK as generally available until all of the
following are true:

- A supported Express/runtime/database matrix is published and exercised in CI.
- Startup failure and repeated start/stop paths close every owned listener, timer,
  and database resource; externally owned pools are never closed by the SDK.
- Background subsystems that can be enabled have documented shutdown guarantees
  and tests proving those guarantees.
- The declared mount-path and multi-instance policies are either supported or
  explicitly accepted as permanent restrictions with dedicated integration
  coverage.
- A production host example is executed in CI, and migration, upgrade, security,
  and GPL distribution guidance is reviewed.
- A release owner approves the compatibility and support commitment.

Until then, keep this package labeled **limited preview**.

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
    session: false,
    features: ['gateway', 'management', 'events'],
    console: false,
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
