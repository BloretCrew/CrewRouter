# Authentication and permissions

## Credentials

| Credential | Sent as | Works on |
| --- | --- | --- |
| API key `sk-...` | `Authorization: Bearer sk-...` or `x-api-key: sk-...` | Gateway, management API, client events |
| OAuth access token `crh_...` | `Authorization: Bearer crh_...` | Gateway and client events only |
| Browser session cookie | `connect.sid` | Console and session-only routes |

API keys take precedence over a session when both are present. An invalid API
key never falls back to the session.

The SDK uses `apiKey` with `authStyle: "bearer"` by default. Set
`authStyle: "x-api-key"` to send `x-api-key` instead.

`oauthToken` is sent as a Bearer token. OAuth tokens cannot access console
management endpoints; they return 401 `oauth_token_not_allowed`.

## API key permissions

The permission catalog is defined in
[`public/js/api-key-permissions.json`](../../public/js/api-key-permissions.json)
and documented in [api-key-permissions.md](../api-key-permissions.md).

Groups:

| Group | Permissions |
| --- | --- |
| Model gateway | `gateway.chat`, `gateway.messages`, `gateway.responses`, `gateway.models` |
| Client events | `events.report`, `events.read` |
| Account and usage | `account.profile.read`, `account.profile.write`, `account.redeem`, `usage.read`, `usage.write` |
| API keys | `keys.read`, `keys.write`, `keys.secret`, `keys.members`, `keys.permissions` |
| Models and providers | `models.read`, `models.write`, `providers.read`, `providers.write` |
| Conversations and prompts | `conversations.read`, `conversations.write`, `prompts.read`, `prompts.write` |
| Notifications and plugins | `notifications.read`, `notifications.write`, `plugins.read`, `plugins.write` |
| Tools | `playground.use`, `agent.use`, `agent.manage` |
| Admin | `admin.users.*`, `admin.teams.*`, `admin.models.*`, `admin.providers.*`, `admin.stats.read`, `admin.audit.read`, `admin.settings.*`, `admin.billing.*`, `admin.plugins.*`, `admin.oauth_clients.*`, `admin.popups.*`, `admin.invites.*`, `admin.cache.*`, `admin.agent.manage` |

Defaults:

- A key created from a browser session gets `gateway.*` when `permissions` is
  omitted.
- A key created by another API key gets `[]` by default and cannot grant
  permissions it does not hold.
- Explicit `permissions: []` creates a key with no permissions.
- Existing keys are backfilled only with missing gateway permissions during the
  upgrade migration; existing permission arrays are not overwritten.

`admin.*` permissions are effective only when the key owner has
`users.is_admin = true`. Otherwise the request returns 403 `admin_required`,
even if the permission id is present.

## Errors

| Status | Code | Meaning |
| --- | --- | --- |
| 401 | `invalid_api_key` | Key does not exist |
| 401 | `key_expired` | Key expired |
| 403 | `key_disabled` | Key disabled |
| 403 | `permission_denied` | Key lacks the required permission |
| 403 | `permission_not_configured` | Route has no permission mapping; API keys are denied by default |
| 403 | `admin_required` | Owner is not an administrator |
| 403 | `session_required` | Route is session-only |

## Session-only endpoints

These routes never accept API keys:

- `/auth/*`
- `/api/2fa/*`
- `/api/passkey/*`
- `/api/setup/*`
- `/api/admin/update/*`
- `/oauth/authorize*`
- `/oauth/authorizations*`
- `/api/user/model-trace/*`

The generated SDK catalog marks them `sdkStatus: "excluded"` with
`exclusion: "session_only"`; `client.call` throws before sending a request.
Use the browser console for these operations.

## CSRF

API-key requests are not cookie-based and skip CSRF validation. The SDK never
sends cookies. Do not mix a browser session cookie with SDK API-key calls.

## Creating a key you can use for management

```ts
const created = await client.keys.create({
  name: 'automation',
  expiresIn: 720,
  permissions: [
    'gateway.chat',
    'gateway.messages',
    'keys.read',
    'usage.read',
  ],
});
```

For admin operations, create the key under an administrator account and grant
the specific `admin.*` permissions. A non-admin key cannot be elevated by adding
`admin.*` ids.
