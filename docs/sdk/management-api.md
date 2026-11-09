# Management API

The SDK covers every non-session management route through a generated operation
catalog. The source of truth is [`sdk/contract/operations.json`](../../sdk/contract/operations.json),
generated from the Express routers and the permission catalog. A readable table
is generated at [`docs/api/reference.md`](../api/reference.md).

## Two ways to call

Typed convenience wrappers for common resources:

```ts
await client.keys.list();
await client.keys.create({ name: 'CI', permissions: ['gateway.chat'] });
await client.keys.update(id, { name: 'Renamed' });
await client.keys.delete(id);
await client.keys.getModels(id);
await client.keys.setModels(id, { models: ['claude-fable-5'] });
await client.keys.getConfig(id);

await client.usage.get({ days: 7 });
await client.balance.get();
await client.models.list();
await client.providers.list();

await client.admin.users.list();
await client.admin.models.list();
await client.admin.providers.list();
await client.admin.providers.refreshKey(id);
await client.admin.teams.list();
```

Everything else goes through `call`:

```ts
await client.call('admin.providers.byId.get', { pathParams: { id: 'openai-main' } });
await client.call('admin.models.batchUpdate', { body: { ids: [1, 2], enabled: false } });
await client.call('user.stats.list', { query: { days: 30 } });
```

`client.operations` lists every operation with its method, path, permission,
auth modes and streaming flag:

```ts
const operation = client.operations['admin.users.list'];
// { operationId, method: 'GET', path: '/api/admin/users', permission: 'admin.users.read', ... }
```

## Call options

```ts
await client.call('user.apiKeys.byId.models.update', {
  pathParams: { id: 42 },          // replaces :id in the path
  query: { days: 7, tag: ['a'] },  // arrays become repeated query params
  body: { models: ['claude-fable-5'] },
  headers: { 'x-trace': 'abc' },
  signal: controller.signal,
  timeoutMs: 10_000,
  responseType: 'json',            // json | text | arrayBuffer | stream
});
```

Path parameters are URL-encoded. Missing path parameters throw before the request
is sent. `undefined` and `null` query values are omitted; arrays are appended as
repeated keys.

## Responses

Management responses are returned as the parsed JSON payload:

```ts
const response = await client.keys.list();
response.data;        // parsed JSON
response.status;      // 200
response.headers;     // Headers
response.requestId;   // X-CrewRouter-Request-Id
response.raw;         // undici Response
```

The management API does not use a single response envelope. Some endpoints return
an object, some return an array, and some return `{ success: true }`. The SDK does
not invent a shape; core wrappers are typed where the contract is stable and
`call` returns the raw payload. Use `response.data` as the source of truth.

## Pagination and filters

Pass query parameters through `query`. Common ones include `page`, `pageSize`,
`search`, `days`, `model`, `provider`, `team`, `keyId` and `userId`. The exact
set is endpoint-specific; see [`docs/api/reference.md`](../api/reference.md).

## Uploads and downloads

Multipart uploads accept a `FormData` body (Node 20 provides global `FormData`,
`Blob` and `File`):

```ts
const form = new FormData();
form.append('file', new Blob([buffer]), 'plugin.zip');
await client.call('admin.plugins.upload', { body: form });
```

Downloads use `responseType: 'arrayBuffer'` or `'stream'`:

```ts
const export = await client.call('admin.usageLogs.export', {
  responseType: 'arrayBuffer',
  query: { days: 30 },
});
await fs.promises.writeFile('usage.csv', Buffer.from(export.data));
```

## Permissions

Every operation has a `permission` field (or `null` for public routes). New keys
only receive `gateway.*`; grant management permissions explicitly. Admin
operations require an admin-owned key with the matching `admin.*` permission.
See [authentication.md](./authentication.md).

## Session-only operations

The catalog contains session-only routes for documentation, but they are marked
`excluded` / `session_only` and `call` refuses to send them. They require a
browser session and cannot be used by an API key, even an administrator's key.

## Alias paths

CrewRouter mounts the gateway router at both `/v1` and `/api`. The catalog keeps
the canonical path and records the other as an alias. Gateway completions and
models use `/v1`; cache and other management operations use `/api`. Generated
operation IDs never collide with alias entries.

## Drift and escape hatch

`npm run sdk:generate` regenerates the catalog; `npm run sdk:check` fails if the
committed catalog is stale. If a new route has not yet been included in a
published SDK version, use the raw escape hatch:

```ts
await client.raw({ method: 'POST', path: '/api/new/route', body: { ... } });
```
