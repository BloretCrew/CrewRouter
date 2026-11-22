# GitHub Actions OIDC → CrewRouter API（预览）

本功能让可信 GitHub Actions workflow 用短期 OIDC 身份换取 CrewRouter 的短期 Bearer access token，避免把 CrewRouter API Key 存入 GitHub Secrets。

**它只认证到 CrewRouter。** 它不会为 OpenCode Console 签发 OpenCode 凭证，也不会绕过 CrewRouter 上游 Provider 已配置的 OpenCode Console API Key。Console 上游认证仍按现有 provider 的静态 Key 配置。

## 管理端配置

在 `config.json` 启用并精确配置：

```json
{
  "githubActionsOidc": {
    "enabled": true,
    "userId": 7,
    "eventName": "push",
    "audience": "https://router.example.com/oauth/github-actions",
    "repositories": ["acme/private-service"],
    "refs": ["refs/heads/main"],
    "workflows": ["acme/private-service/.github/workflows/crewrouter.yml@refs/heads/main"],
    "subjects": ["repo:acme/private-service:ref:refs/heads/main"]
  }
}
```

要求使用 HTTPS 公网 origin；运行时要求服务实例的 `app.publicOrigin` 已配置且此 audience 必须严格等于 `${app.publicOrigin}/oauth/github-actions`。拒绝 `*`、通配符和宽泛匹配。`eventName` 必须显式设为 `push`、`workflow_dispatch` 或 `schedule`，且运行时 claim 必须完全一致。`userId` 是 CrewRouter 中固定 API Key 所有者：该用户必须有一个启用、未过期且含 `gateway.chat` 权限的 API Key。token 使用该 Key 的既有模型访问、额度、速率限制和策略；该 Key 必须已允许 GitHub Job 请求的模型。

可配置 `CR_GITHUB_ACTIONS_OIDC_ENABLED=true`、`CR_GITHUB_ACTIONS_OIDC_USER_ID=7`、`CR_GITHUB_ACTIONS_OIDC_EVENT_NAME=push`、`CR_GITHUB_ACTIONS_OIDC_AUDIENCE=...`；仓库/ref/workflow/subject 列表在 `config.json` 的对应数组中配置。若 OIDC 没有显式启用、缺 HTTPS public origin/audience 或任一信任列表（repository/ref/workflow/subject）为空，认证端点返回 404（关闭）。

## GitHub Actions workflow

将权限限定在专用 Job；不要为 workflow 顶层赋予 `id-token: write`。不要允许 fork pull request 运行这个获权 Job。部署前由管理员将 repository、ref、完整 workflow_ref、精确 `sub` 和允许的 `eventName` 写入上述白名单。

GitHub 在启用 `id-token: write` 的 Job 中提供 `ACTIONS_ID_TOKEN_REQUEST_URL` 与 `ACTIONS_ID_TOKEN_REQUEST_TOKEN`。它们是 Job 的 runner runtime 凭据；不要将其写入仓库 Secrets，也不要在日志或 artifact 中打印。

```yaml
jobs:
  use-crewrouter:
    if: github.repository == 'acme/private-service' && github.ref == 'refs/heads/main' && github.event_name != 'pull_request'
    permissions:
      contents: read
      id-token: write
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Exchange GitHub OIDC assertion for CrewRouter token
        env:
          CR_BASE_URL: https://router.example.com
        run: |
          set -euo pipefail
          python3 - <<'PY'
          import json, os, urllib.parse, urllib.request
          token_url = os.environ['ACTIONS_ID_TOKEN_REQUEST_URL']
          separator = '&' if '?' in token_url else '?'
          audience = os.environ['CR_BASE_URL'] + '/oauth/github-actions'
          oidc_req = urllib.request.Request(
              token_url + separator + 'audience=' + urllib.parse.quote(audience, safe=''),
              headers={'Authorization': 'bearer ' + os.environ['ACTIONS_ID_TOKEN_REQUEST_TOKEN']})
          oidc = json.load(urllib.request.urlopen(oidc_req))['value']
          print('::add-mask::' + oidc)
          exchange = urllib.request.Request(
              os.environ['CR_BASE_URL'] + '/oauth/github-actions',
              data=json.dumps({'assertion': oidc}).encode(),
              headers={'Content-Type': 'application/json'})
          result = json.load(urllib.request.urlopen(exchange))
          print('::add-mask::' + result['access_token'])
          with open(os.environ['GITHUB_ENV'], 'a') as env_file:
              env_file.write('CREWROUTER_API_KEY=' + result['access_token'] + '\\n')
          del oidc, result
          PY
      - name: Call CrewRouter
        env:
          CR_BASE_URL: https://router.example.com
          MODEL: claude-fable-5
          CREWROUTER_API_KEY: ${{ env.CREWROUTER_API_KEY }}
        run: |
          curl --fail-with-body "$CR_BASE_URL/v1/chat/completions" \
            -H "Authorization: Bearer $CREWROUTER_API_KEY" \
            -H 'Content-Type: application/json' \
            -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"CI task\"}]}"
```

真实 workflow 中优先使用 `actions/github-script`/小型运行器代码获取 token，并通过 runner masking API 隐藏换取的 CrewRouter token；禁止 `set -x`，不要打印 assertion 或响应 JSON。上面仅作协议示意。

## Token 与安全边界

- Endpoint: `POST /oauth/github-actions`, JSON `{ "assertion": "<GitHub OIDC JWT>" }`。
- audience: 必须精确等于 `${app.publicOrigin}/oauth/github-actions`；token issuer 固定为 `https://token.actions.githubusercontent.com`，签名使用 GitHub JWKS 的 RS256 公钥验证。
- 校验 `iss/aud/iat/exp/sub`，要求 assertion 总寿命不超过 10 分钟；再精确匹配 `repository`、`ref`、`workflow_ref`、`sub` 四个 allow-list，并拒绝 pull_request/pull_request_target 事件。
- 成功返回一次性可见的 `crh_...` Bearer token，有效 10 分钟；数据库只保存 SHA-256 token hash，授权绑定到配置的用户和已有 API Key。token scope 是 `gateway:invoke`。
- token 不能刷新；过期后 workflow 必须再次向 GitHub 请求新的 OIDC assertion 换取。短期 token 不记录 assertion 的 claims/仓库名在 oauth_tokens 中；首次签发回落用户现有 API Key lifecycle、停用/过期、额度、速率、模型与策略校验。
- 兑换接口按客户端 IP 限制为每分钟最多 20 次；这只是实例级内存限速，生产仍应配合反向代理/WAF 的分布式限速。请求错误/信任不匹配时不降级到静态 Key。
- 当前只支持 GitHub Actions Job 内运行的 CrewRouter 客户端。部署在 Job 外的常驻 CrewRouter 服务没有该 Job OIDC 身份，不能使用此机制。
- 每个 OIDC access token 消耗现有 OAuth `oauth_tokens` 表；应配置既有 token 过期清理任务/数据库保留策略。不要将 endpoint 暴露给非 HTTPS 公网流量。
