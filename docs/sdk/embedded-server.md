# Embedded server SDK (planned)

> **Status: Phase 2, not yet available in the 0.1.0 client SDK.** This page
> defines the intended contract so integrators can review it before the refactor
> lands. The runtime entry point below does not exist yet.

The embedded form lets a Node/Express application run the CrewRouter gateway and
management API in-process instead of deploying a separate service.

## Intended entry point

```js
const { createCrewRouter } = require('crewrouter/embedded');

const cr = createCrewRouter({
  configPath: './crewrouter.config.json', // or config: { ... }
  pool: externalPgPool,                   // optional; owned pool is created if omitted
  ownsPool: false,
  session: false,                         // default for embedding
  migrations: false,                      // 'full' | 'schema' | false
  features: ['core', 'gateway', 'management', 'events'],
  console: false,
  plugins: false,
  store: false,
  oauthRoutes: false,
  backgroundTasks: false,
  handleSignals: false,
});

await cr.start({ listen: { port: 0, host: '127.0.0.1' } });
// or mount cr.app in the host Express app:
// app.use('/', cr.app);

await cr.stop();
```

## Why the API is shaped this way

- `createCrewRouter` configures config/pool **before** loading route modules,
  because existing CrewRouter modules read a frozen config and a global pool.
- `start()` is separate from construction so a host can mount the app or perform
  its own readiness checks first.
- `stop()` is explicit: the embedding host owns process signals.
- Features are opt-in: an embedded gateway usually does not need the console,
  plugin store or OAuth authorization server.

## Options

| Option | Embedded default | Description |
| --- | --- | --- |
| `config` | — | Config object. `CR_*` environment variables still override. |
| `configPath` | auto-discovery | JSON config file |
| `pool` | owned | External main PostgreSQL pool |
| `ownsPool` | `false` when `pool` is passed | Whether `stop()` ends the pool |
| `session` | `false` | `pg`, `memory`, an external store, or `false` |
| `migrations` | `false` | `full`, `schema`, or `false` |
| `features` | `core,gateway,management,events` | Mounted feature set |
| `console` | `false` | Static pages, auth, setup, 2FA, passkey, update |
| `plugins` | `false` | Plugin registry and plugin routes |
| `store` | `false` | Plugin store (demo only in CLI) |
| `oauthRoutes` | `false` | `/oauth/*` and `/.well-known/*` authorization server |
| `backgroundTasks` | `false` | Key refresh, schedulers, stats, aggregation |
| `handleSignals` | `false` | Install SIGINT/SIGTERM handlers |
| `basePath` | unsupported | Passing a value throws |

## Feature presets

| Feature | Routes / behavior |
| --- | --- |
| `core` | Body parsing, auth resolution, CSRF, permission middleware, `/api/version`, `/api/config`, `/api/instance` |
| `gateway` | `/v1` and `/api` completions/models/cache |
| `management` | `/api/user/*`, `/api/admin/*`, teams, notifications, conversations, prompts, playground, agent |
| `events` | `/api/client-events` |
| `console` | Static assets, pages, auth, setup, 2FA, passkey, update |
| `oauthRoutes` | OAuth authorization server |
| `plugins` | Plugin admin/public APIs and static assets |
| `store` | Plugin store |

## Lifecycle

1. `createCrewRouter(options)` resolves config, logger, pool and session, then
   builds the Express app. It does not connect to PostgreSQL, start timers or
   listen.
2. `start({ listen? })` optionally runs migrations, initializes edition/plugins,
   starts enabled background tasks and optionally listens.
3. `stop()` closes the HTTP server, stops background tasks in reverse order,
   flushes buffered quota data, and closes the pool if owned. It is idempotent.

## Limitations (first version)

- **Root mount only.** Static assets, cookies, OAuth callbacks and CSRF assume
  `/`. Mounting at `/crewrouter` is not supported; use a reverse proxy to strip
  the prefix.
- **One instance per process.** Config, the pg pool and the plugin registry are
  process globals. A second `createCrewRouter` throws
  `ERR_CREWROUTER_MULTIPLE_INSTANCES`.
- **No host session reuse.** CrewRouter installs its own session middleware, or
  runs without sessions when `session: false`.
- **No session-only routes in API-key mode.** If you disable sessions, routes
  such as 2FA, passkey and setup are not usable; they are part of the `console`
  feature anyway.
- **PostgreSQL required.** Demo mode is the only database-free mode.
- **Express 4 hosts.** Express 5 is not validated in the first version.

## GPL-3.0

The embedded SDK links the CrewRouter server code, which is GPL-3.0. If you
distribute an application that embeds it, the combined work is subject to
GPL-3.0. This is not legal advice; review the license before distributing.
