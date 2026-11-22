# CrewRouter for DSH

DSH bundle plugin for read-only CrewRouter account insights, visible models, and session summaries. Requests use DSH's standard fetch and CrewRouter's documented HTTP API. The API Key is stored in DSH's credential service; CrewRouter OAuth bearer credentials are not supported for management endpoints.

## Configure

Set the bundle config `baseUrl` to the CrewRouter site root, then store the API Key in the DSH credentials store under `bloret-crew-dsh-crewrouter/default`. Grant `usage.read` for usage and session summaries, and `models.read` for available models. The plugin never needs key-management or admin permissions. The API Key value is never placed in plugin config, tool arguments, or tool results.

The plugin registers three read-only tools: `crewrouter_overview`, `crewrouter_models`, and `crewrouter_sessions`. Session-only operations are not called. Tool results are capped.

## Install

```sh
dsh plugin --profile <profile> add @bloret-crew/dsh-crewrouter@<version>
```

Requires Node >=20 and a compatible DSH Host (>=0.2.2-alpha.3). GPL-3.0; see `LICENSE`. Runtime integration uses the DSH host's installed `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-credentials`, and `@deepseek-ai/schemastery` packages as peer APIs. The CLI installs its bundled copy via an absolute `file:` package spec, so operation does not depend on a registry-published plugin version.
