# CrewRouter for DSH

DSH bundle plugin for read-only CrewRouter account insights, visible models, and session summaries. Requests use DSH's standard fetch and CrewRouter's documented HTTP API. The API Key is stored in DSH's credential service; CrewRouter OAuth bearer credentials are not supported for management endpoints.

## Configure

Set the bundle config `baseUrl` to the CrewRouter site root, then store the API Key in the DSH credentials store under `bloret-crew-dsh-crewrouter/default`. Grant `usage.read` for usage and session summaries, and `models.read` for available models. The plugin never needs key-management or admin permissions. The API Key value is never placed in plugin config, tool arguments, or tool results.

Remote CrewRouter addresses must use HTTPS. Plain HTTP is allowed only for loopback development instances. Redirects are rejected; requests time out after 15 seconds and stop reading response bodies above 256 KiB.

The plugin registers three read-only tools: `crewrouter_overview`, `crewrouter_models`, and `crewrouter_sessions`. Session-only operations are not called. Results are capped.

## Install

The CrewRouter CLI contains this bundle and installs its local copy into a selected DSH profile after explicit confirmation. DSH must already be installed and accessible on `PATH`.

```sh
cr dsh-plugin install --profile web
cr dsh-plugin status
cr dsh-plugin uninstall --profile web
```

Requires Node >=20 and DSH >=0.2.2-alpha.3. GPL-3.0; see `LICENSE`. The Host dependencies `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-credentials`, and `@deepseek-ai/schemastery` are resolved from the selected DSH installation at runtime. In a DSH source checkout, run plugin tests with `DSH_INSTALL_ROOT=/path/to/dsh node --test test/*.test.js`.
