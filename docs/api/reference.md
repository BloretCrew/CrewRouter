# CrewRouter API Reference

> Generated from `sdk/contract/operations.json`. Do not edit by hand.

## account

| operationId | Method | Path | Permission | Auth | Streaming |
| --- | --- | --- | --- | --- | --- |
| `user.auditLogs.list` | GET | `/api/user/audit-logs` | `usage.read` | api_key, session | no |
| `user.avatar.create` | POST | `/api/user/avatar` | `account.profile.write` | api_key, session | no |
| `user.balance.list` | GET | `/api/user/balance` | `account.profile.read` | api_key, session | no |
| `user.codeBalances.list` | GET | `/api/user/code-balances` | `account.profile.read` | api_key, session | no |
| `user.contextPressure.list` | GET | `/api/user/context-pressure` | `usage.read` | api_key, session | no |
| `user.currentModel.list` | GET | `/api/user/current-model` | `account.profile.read` | api_key, session | no |
| `user.currentModel.update` | PUT | `/api/user/current-model` | `account.profile.write` | api_key, session | no |
| `user.docsContent.list` | GET | `/api/user/docs-content` | `account.profile.read` | public | no |
| `user.leaderboard.list` | GET | `/api/user/leaderboard` | `usage.read` | api_key, session | no |
| `user.messageStats.list` | GET | `/api/user/message-stats` | `usage.read` | api_key, session | no |
| `user.products.list` | GET | `/api/user/products` | `account.profile.read` | api_key, session | no |
| `user.projectStats.list` | GET | `/api/user/project-stats` | `usage.read` | api_key, session | no |
| `user.redeem` | POST | `/api/user/redeem` | `account.redeem` | api_key, session | no |
| `user.sessions.list` | GET | `/api/user/sessions` | `usage.read` | api_key, session | no |
| `user.sessions.bySessionKey.messages.list` | GET | `/api/user/sessions/:sessionKey/messages` | `usage.read` | api_key, session | no |
| `user.sessions.bySessionKey.summary` | GET | `/api/user/sessions/:sessionKey/summary` | `usage.read` | api_key, session | no |
| `user.sessions.bySessionKey.summary2` | POST | `/api/user/sessions/:sessionKey/summary` | `usage.write` | api_key, session | no |
| `user.sessions.search` | GET | `/api/user/sessions/search` | `usage.read` | api_key, session | no |
| `user.settings.update` | PUT | `/api/user/settings` | `account.profile.write` | api_key, session | no |
| `user.signature.list` | GET | `/api/user/signature` | `account.profile.read` | api_key, session | no |
| `user.signature.update` | PUT | `/api/user/signature` | `account.profile.write` | api_key, session | no |
| `user.stats.list` | GET | `/api/user/stats` | `usage.read` | api_key, session | no |
| `user.stats.filters.list` | GET | `/api/user/stats/filters` | `usage.read` | api_key, session | no |
| `user.stats.latency.list` | GET | `/api/user/stats/latency` | `usage.read` | api_key, session | no |
| `user.stats.multiDimension.list` | GET | `/api/user/stats/multi-dimension` | `usage.read` | api_key, session | no |
| `user.stats.providerQuota.list` | GET | `/api/user/stats/provider-quota` | `usage.read` | api_key, session | no |
| `user.stats.providerQuota.history.list` | GET | `/api/user/stats/provider-quota/history` | `usage.read` | api_key, session | no |
| `user.taskGroups.list` | GET | `/api/user/task-groups` | `usage.read` | api_key, session | no |
| `user.taskTree.list` | GET | `/api/user/task-tree` | `usage.read` | api_key, session | no |
| `user.traceSessions.list` | GET | `/api/user/trace-sessions` | `usage.read` | api_key, session | no |
| `user.traceSessions.byPublicId.get` | GET | `/api/user/trace-sessions/:publicId` | `usage.read` | api_key, session | no |
| `user.traceSessions.byPublicId.export` | GET | `/api/user/trace-sessions/:publicId/export` | `usage.read` | api_key, session | no |
| `user.usage.list` | GET | `/api/user/usage` | `usage.read` | api_key, session | no |
| `user.usage.create` | POST | `/api/user/usage` | `usage.read` | api_key, session | no |
| `user.usageLogs.list` | GET | `/api/user/usage-logs` | `usage.read` | api_key, session | no |
| `user.usageLogs.byId.get` | GET | `/api/user/usage-logs/:id` | `usage.read` | api_key, session | no |
| `user.usageLogs.export` | GET | `/api/user/usage-logs/export` | `usage.read` | api_key, session | no |

## admin

| operationId | Method | Path | Permission | Auth | Streaming |
| --- | --- | --- | --- | --- | --- |
| `admin.agentWeb.list` | GET | `/api/admin/agent-web` | `admin.settings.read` | api_key, session | no |
| `admin.agentWeb.update` | PUT | `/api/admin/agent-web` | `admin.settings.write` | api_key, session | no |
| `admin.agentWeb.test` | POST | `/api/admin/agent-web/test` | `admin.settings.write` | api_key, session | no |
| `admin.auditLogs.list` | GET | `/api/admin/audit-logs` | `admin.audit.read` | api_key, session | no |
| `admin.customInstructions.list` | GET | `/api/admin/custom-instructions` | `admin.audit.read` | api_key, session | no |
| `admin.customInstructions.byFingerprint.get` | GET | `/api/admin/custom-instructions/:fingerprint` | `admin.audit.read` | api_key, session | no |
| `admin.errorLogs.list` | GET | `/api/admin/error-logs` | `admin.audit.read` | api_key, session | no |
| `admin.exportUsage` | GET | `/api/admin/export-usage` | `admin.audit.read` | api_key, session | no |
| `admin.feishuLogin.list` | GET | `/api/admin/feishu-login` | `admin.settings.read` | api_key, session | no |
| `admin.feishuLogin.update` | PUT | `/api/admin/feishu-login` | `admin.settings.write` | api_key, session | no |
| `admin.fetchProxiesUrl` | POST | `/api/admin/fetch-proxies-url` | `admin.providers.write` | api_key, session | no |
| `admin.fusionConfigs.list` | GET | `/api/admin/fusion-configs` | `admin.models.read` | api_key, session | no |
| `admin.fusionConfigs.create` | POST | `/api/admin/fusion-configs` | `admin.models.write` | api_key, session | no |
| `admin.fusionConfigs.byId.delete` | DELETE | `/api/admin/fusion-configs/:id` | `admin.models.write` | api_key, session | no |
| `admin.fusionConfigs.byId.get` | GET | `/api/admin/fusion-configs/:id` | `admin.models.read` | api_key, session | no |
| `admin.fusionConfigs.byId.update` | PUT | `/api/admin/fusion-configs/:id` | `admin.models.write` | api_key, session | no |
| `admin.fusionConfigs.batchDelete` | POST | `/api/admin/fusion-configs/batch-delete` | `admin.models.write` | api_key, session | no |
| `admin.fusionUsage.list` | GET | `/api/admin/fusion-usage` | `admin.stats.read` | api_key, session | no |
| `admin.fusionUsage.stats.list` | GET | `/api/admin/fusion-usage/stats` | `admin.stats.read` | api_key, session | no |
| `admin.importCodex` | POST | `/api/admin/import-codex` | `admin.providers.write` | api_key, session | no |
| `admin.importGrok` | POST | `/api/admin/import-grok` | `admin.providers.write` | api_key, session | no |
| `admin.importOpencode` | POST | `/api/admin/import-opencode` | `admin.providers.write` | api_key, session | no |
| `admin.messageStats.list` | GET | `/api/admin/message-stats` | `admin.stats.read` | api_key, session | no |
| `admin.modelLibrary.list` | GET | `/api/admin/model-library` | `admin.models.read` | api_key, session | no |
| `admin.models.list` | GET | `/api/admin/models` | `admin.models.read` | api_key, session | no |
| `admin.models.create` | POST | `/api/admin/models` | `admin.models.write` | api_key, session | no |
| `admin.models.byId.delete` | DELETE | `/api/admin/models/:id` | `admin.models.write` | api_key, session | no |
| `admin.models.byId.test` | POST | `/api/admin/models/:id/test` | `admin.models.write` | api_key, session | no |
| `admin.models.byId.uptime.list` | GET | `/api/admin/models/:id/uptime` | `admin.models.read` | api_key, session | no |
| `admin.models.batchAdd` | POST | `/api/admin/models/batch-add` | `admin.models.write` | api_key, session | no |
| `admin.models.batchAdjustByReference` | POST | `/api/admin/models/batch-adjust-by-reference` | `admin.models.write` | api_key, session | no |
| `admin.models.batchAdjustByReferencePreview` | POST | `/api/admin/models/batch-adjust-by-reference-preview` | `admin.models.write` | api_key, session | no |
| `admin.models.batchDelete` | POST | `/api/admin/models/batch-delete` | `admin.models.write` | api_key, session | no |
| `admin.models.batchSetPrices` | POST | `/api/admin/models/batch-set-prices` | `admin.models.write` | api_key, session | no |
| `admin.models.batchSetReferencePrices` | POST | `/api/admin/models/batch-set-reference-prices` | `admin.models.write` | api_key, session | no |
| `admin.models.batchSyncCachedPrice` | POST | `/api/admin/models/batch-sync-cached-price` | `admin.models.write` | api_key, session | no |
| `admin.models.batchUpdate` | POST | `/api/admin/models/batch-update` | `admin.models.write` | api_key, session | no |
| `admin.models.batchUpdateDescription` | POST | `/api/admin/models/batch-update-description` | `admin.models.write` | api_key, session | no |
| `admin.models.batchUpdatePrices` | POST | `/api/admin/models/batch-update-prices` | `admin.models.write` | api_key, session | no |
| `admin.models.batchUpdateRatelimit` | POST | `/api/admin/models/batch-update-ratelimit` | `admin.models.write` | api_key, session | no |
| `admin.models.batchUpdateSeries` | POST | `/api/admin/models/batch-update-series` | `admin.models.write` | api_key, session | no |
| `admin.models.testBatch` | POST | `/api/admin/models/test-batch` | `admin.models.write` | api_key, session | no |
| `admin.models.uptime.list` | GET | `/api/admin/models/uptime` | `admin.models.read` | api_key, session | no |
| `admin.oauthClients.list` | GET | `/api/admin/oauth-clients` | `admin.oauth_clients.read` | api_key, session | no |
| `admin.oauthClients.create` | POST | `/api/admin/oauth-clients` | `admin.oauth_clients.write` | api_key, session | no |
| `admin.oauthClients.byClientId.delete` | DELETE | `/api/admin/oauth-clients/:clientId` | `admin.oauth_clients.write` | api_key, session | no |
| `admin.oauthClients.byClientId.update` | PUT | `/api/admin/oauth-clients/:clientId` | `admin.oauth_clients.write` | api_key, session | no |
| `admin.oauthClients.byClientId.rotateSecret` | POST | `/api/admin/oauth-clients/:clientId/rotate-secret` | `admin.oauth_clients.write` | api_key, session | no |
| `admin.popupNotices.list` | GET | `/api/admin/popup-notices` | `admin.popups.read` | api_key, session | no |
| `admin.popupNotices.create` | POST | `/api/admin/popup-notices` | `admin.popups.write` | api_key, session | no |
| `admin.popupNotices.byId.delete` | DELETE | `/api/admin/popup-notices/:id` | `admin.popups.write` | api_key, session | no |
| `admin.popupNotices.byId.update` | PUT | `/api/admin/popup-notices/:id` | `admin.popups.write` | api_key, session | no |
| `admin.popupNotices.byId.enabled.update` | PUT | `/api/admin/popup-notices/:id/enabled` | `admin.popups.write` | api_key, session | no |
| `admin.popupNotices.byId.reset` | POST | `/api/admin/popup-notices/:id/reset` | `admin.popups.write` | api_key, session | no |
| `admin.products.list` | GET | `/api/admin/products` | `admin.billing.read` | api_key, session | no |
| `admin.products.create` | POST | `/api/admin/products` | `admin.billing.write` | api_key, session | no |
| `admin.products.byId.delete` | DELETE | `/api/admin/products/:id` | `admin.billing.write` | api_key, session | no |
| `admin.products.byId.update` | PUT | `/api/admin/products/:id` | `admin.billing.write` | api_key, session | no |
| `admin.products.batchDelete` | POST | `/api/admin/products/batch-delete` | `admin.billing.write` | api_key, session | no |
| `admin.providerTags.list` | GET | `/api/admin/provider-tags` | `admin.models.read` | api_key, session | no |
| `admin.providerTags.create` | POST | `/api/admin/provider-tags` | `admin.models.write` | api_key, session | no |
| `admin.providerTags.byId.delete` | DELETE | `/api/admin/provider-tags/:id` | `admin.models.write` | api_key, session | no |
| `admin.providerTags.byId.update` | PUT | `/api/admin/provider-tags/:id` | `admin.models.write` | api_key, session | no |
| `admin.providerTags.reorder` | PUT | `/api/admin/provider-tags/reorder` | `admin.models.write` | api_key, session | no |
| `admin.providers.list` | GET | `/api/admin/providers` | `admin.providers.read` | api_key, session | no |
| `admin.providers.create` | POST | `/api/admin/providers` | `admin.providers.write` | api_key, session | no |
| `admin.providers.byId.delete` | DELETE | `/api/admin/providers/:id` | `admin.providers.write` | api_key, session | no |
| `admin.providers.byId.get` | GET | `/api/admin/providers/:id` | `admin.providers.read` | api_key, session | no |
| `admin.providers.byId.analyzeScriptError` | POST | `/api/admin/providers/:id/analyze-script-error` | `admin.providers.write` | api_key, session | no |
| `admin.providers.byId.checkQuota` | GET | `/api/admin/providers/:id/check-quota` | `admin.providers.read` | api_key, session | no |
| `admin.providers.byId.cleanupStaleModels` | POST | `/api/admin/providers/:id/cleanup-stale-models` | `admin.providers.write` | api_key, session | no |
| `admin.providers.byId.defaultQuotaScript.list` | GET | `/api/admin/providers/:id/default-quota-script` | `admin.providers.read` | api_key, session | no |
| `admin.providers.byId.fetchModels` | GET | `/api/admin/providers/:id/fetch-models` | `admin.providers.read` | api_key, session | no |
| `admin.providers.byId.fixScript` | POST | `/api/admin/providers/:id/fix-script` | `admin.providers.write` | api_key, session | no |
| `admin.providers.byId.ping` | GET | `/api/admin/providers/:id/ping` | `admin.providers.read` | api_key, session | no |
| `admin.providers.byId.proxyPool.create` | POST | `/api/admin/providers/:id/proxy-pool` | `admin.providers.write` | api_key, session | no |
| `admin.providers.byId.proxyPool.byProxyId.delete` | DELETE | `/api/admin/providers/:id/proxy-pool/:proxyId` | `admin.providers.write` | api_key, session | no |
| `admin.providers.byId.proxyPool.byProxyId.toggle` | PUT | `/api/admin/providers/:id/proxy-pool/:proxyId/toggle` | `admin.providers.write` | api_key, session | no |
| `admin.providers.byId.proxyPool.add` | POST | `/api/admin/providers/:id/proxy-pool/add` | `admin.providers.write` | api_key, session | no |
| `admin.providers.byId.quotaScript.create` | POST | `/api/admin/providers/:id/quota-script` | `admin.providers.write` | api_key, session | no |
| `admin.providers.byId.refreshKey` | POST | `/api/admin/providers/:id/refresh-key` | `admin.providers.write` | api_key, session | no |
| `admin.providers.byId.syncModels` | POST | `/api/admin/providers/:id/sync-models` | `admin.providers.write` | api_key, session | no |
| `admin.providers.byId.tags.update` | PUT | `/api/admin/providers/:id/tags` | `admin.providers.write` | api_key, session | no |
| `admin.providers.byId.toggleEnabled` | POST | `/api/admin/providers/:id/toggle-enabled` | `admin.providers.write` | api_key, session | no |
| `admin.providers.byId.toggleQuota` | POST | `/api/admin/providers/:id/toggle-quota` | `admin.providers.write` | api_key, session | no |
| `admin.providers.cleanupStaleModels` | POST | `/api/admin/providers/cleanup-stale-models` | `admin.providers.write` | api_key, session | no |
| `admin.providers.cpa.accounts.create` | POST | `/api/admin/providers/cpa/accounts` | `admin.providers.write` | api_key, session | no |
| `admin.providers.lookupIndex.list` | GET | `/api/admin/providers/lookup-index` | `admin.providers.read` | api_key, session | no |
| `admin.providers.quickAdd.create` | POST | `/api/admin/providers/quick-add` | `admin.providers.write` | api_key, session | no |
| `admin.providers.refreshStatus` | GET | `/api/admin/providers/refresh-status` | `admin.providers.read` | api_key, session | no |
| `admin.redemptionCodes.list` | GET | `/api/admin/redemption-codes` | `admin.billing.read` | api_key, session | no |
| `admin.redemptionCodes.create` | POST | `/api/admin/redemption-codes` | `admin.billing.write` | api_key, session | no |
| `admin.redemptionCodes.byId.delete` | DELETE | `/api/admin/redemption-codes/:id` | `admin.billing.write` | api_key, session | no |
| `admin.redemptionCodes.batch` | POST | `/api/admin/redemption-codes/batch` | `admin.billing.write` | api_key, session | no |
| `admin.redemptionCodes.batchDelete` | POST | `/api/admin/redemption-codes/batch-delete` | `admin.billing.write` | api_key, session | no |
| `admin.redemptionCodes.batchSetRefundable` | POST | `/api/admin/redemption-codes/batch-set-refundable` | `admin.billing.write` | api_key, session | no |
| `admin.redemptionCodes.generate.create` | POST | `/api/admin/redemption-codes/generate` | `admin.billing.write` | api_key, session | no |
| `admin.requestQuotaConfig.list` | GET | `/api/admin/request-quota-config` | `admin.settings.read` | api_key, session | no |
| `admin.requestQuotaConfig.update` | PUT | `/api/admin/request-quota-config` | `admin.settings.write` | api_key, session | no |
| `admin.retentionConfig.list` | GET | `/api/admin/retention-config` | `admin.settings.read` | api_key, session | no |
| `admin.retentionConfig.update` | PUT | `/api/admin/retention-config` | `admin.settings.write` | api_key, session | no |
| `admin.retention.runCompress` | POST | `/api/admin/retention/run-compress` | `admin.settings.write` | api_key, session | no |
| `admin.retention.runPurge` | POST | `/api/admin/retention/run-purge` | `admin.settings.write` | api_key, session | no |
| `admin.retention.tasks.byTaskId.get` | GET | `/api/admin/retention/tasks/:taskId` | `admin.settings.read` | api_key, session | no |
| `admin.seriesIcons.list` | GET | `/api/admin/series-icons` | `admin.models.read` | api_key, session | no |
| `admin.seriesIcons.create` | POST | `/api/admin/series-icons` | `admin.models.write` | api_key, session | no |
| `admin.seriesIcons.byName.delete` | DELETE | `/api/admin/series-icons/:name` | `admin.models.write` | api_key, session | no |
| `admin.settings.list` | GET | `/api/admin/settings` | `admin.settings.read` | api_key, session | no |
| `admin.settings.update` | PUT | `/api/admin/settings` | `admin.settings.write` | api_key, session | no |
| `admin.stats.list` | GET | `/api/admin/stats` | `admin.stats.read` | api_key, session | no |
| `admin.stats.latency.list` | GET | `/api/admin/stats/latency` | `admin.stats.read` | api_key, session | no |
| `admin.stats.multi.list` | GET | `/api/admin/stats/multi` | `admin.stats.read` | api_key, session | no |
| `admin.stats.multiDimension.list` | GET | `/api/admin/stats/multi-dimension` | `admin.stats.read` | api_key, session | no |
| `admin.stats.multi.filters.list` | GET | `/api/admin/stats/multi/filters` | `admin.stats.read` | api_key, session | no |
| `admin.stats.providerQuota.list` | GET | `/api/admin/stats/provider-quota` | `admin.stats.read` | api_key, session | no |
| `admin.stats.providerQuota.history.list` | GET | `/api/admin/stats/provider-quota/history` | `admin.stats.read` | api_key, session | no |
| `admin.teams.list` | GET | `/api/admin/teams` | `admin.teams.read` | api_key, session | no |
| `admin.teams.create` | POST | `/api/admin/teams` | `admin.teams.write` | api_key, session | no |
| `admin.teams.byId.delete` | DELETE | `/api/admin/teams/:id` | `admin.teams.write` | api_key, session | no |
| `admin.teams.byId.update` | PUT | `/api/admin/teams/:id` | `admin.teams.write` | api_key, session | no |
| `admin.teams.byId.members.list` | GET | `/api/admin/teams/:id/members` | `admin.teams.read` | api_key, session | no |
| `admin.teams.byId.members.create` | POST | `/api/admin/teams/:id/members` | `admin.teams.write` | api_key, session | no |
| `admin.teams.byId.members.byUserId.delete` | DELETE | `/api/admin/teams/:id/members/:userId` | `admin.teams.write` | api_key, session | no |
| `admin.teams.byId.models.list` | GET | `/api/admin/teams/:id/models` | `admin.teams.read` | api_key, session | no |
| `admin.teams.byId.models.create` | POST | `/api/admin/teams/:id/models` | `admin.teams.write` | api_key, session | no |
| `admin.teams.byId.models.byModelId.delete` | DELETE | `/api/admin/teams/:id/models/:modelId` | `admin.teams.write` | api_key, session | no |
| `admin.teams.byId.models.byModelId.update` | PUT | `/api/admin/teams/:id/models/:modelId` | `admin.teams.write` | api_key, session | no |
| `admin.teams.byId.models.batch` | POST | `/api/admin/teams/:id/models/batch` | `admin.teams.write` | api_key, session | no |
| `admin.teams.byId.rules.list` | GET | `/api/admin/teams/:id/rules` | `admin.teams.read` | api_key, session | no |
| `admin.teams.byId.rules.create` | POST | `/api/admin/teams/:id/rules` | `admin.teams.write` | api_key, session | no |
| `admin.teams.byId.rules.byRuleId.delete` | DELETE | `/api/admin/teams/:id/rules/:ruleId` | `admin.teams.write` | api_key, session | no |
| `admin.teams.byId.setFrontier.update` | PUT | `/api/admin/teams/:id/set-frontier` | `admin.teams.write` | api_key, session | no |
| `admin.usageLogs.list` | GET | `/api/admin/usage-logs` | `admin.audit.read` | api_key, session | no |
| `admin.usageLogs.byId.get` | GET | `/api/admin/usage-logs/:id` | `admin.audit.read` | api_key, session | no |
| `admin.usageLogs.export` | GET | `/api/admin/usage-logs/export` | `admin.audit.read` | api_key, session | no |
| `admin.userGroupRules.byId.delete` | DELETE | `/api/admin/user-group-rules/:id` | `admin.teams.write` | api_key, session | no |
| `admin.userGroupRules.byId.update` | PUT | `/api/admin/user-group-rules/:id` | `admin.teams.write` | api_key, session | no |
| `admin.userGroups.list` | GET | `/api/admin/user-groups` | `admin.teams.read` | api_key, session | no |
| `admin.userGroups.create` | POST | `/api/admin/user-groups` | `admin.teams.write` | api_key, session | no |
| `admin.userGroups.byId.delete` | DELETE | `/api/admin/user-groups/:id` | `admin.teams.write` | api_key, session | no |
| `admin.userGroups.byId.update` | PUT | `/api/admin/user-groups/:id` | `admin.teams.write` | api_key, session | no |
| `admin.userGroups.byId.rules.list` | GET | `/api/admin/user-groups/:id/rules` | `admin.teams.read` | api_key, session | no |
| `admin.userGroups.byId.rules.create` | POST | `/api/admin/user-groups/:id/rules` | `admin.teams.write` | api_key, session | no |
| `admin.userGroups.byId.setDefault.update` | PUT | `/api/admin/user-groups/:id/set-default` | `admin.teams.write` | api_key, session | no |
| `admin.users.list` | GET | `/api/admin/users` | `admin.users.read` | api_key, session | no |
| `admin.users.byId.update` | PUT | `/api/admin/users/:id` | `admin.users.write` | api_key, session | no |
| `admin.users.byId.codeBalances.list` | GET | `/api/admin/users/:id/code-balances` | `admin.users.read` | api_key, session | no |
| `admin.users.byId.refund.create` | POST | `/api/admin/users/:id/refund` | `admin.users.write` | api_key, session | no |
| `authInvites.list` | GET | `/api/auth-invites` | `admin.invites.read` | api_key, session | no |
| `authInvites.create` | POST | `/api/auth-invites` | `admin.invites.write` | api_key, session | no |
| `authInvites.byId.revoke` | POST | `/api/auth-invites/:id/revoke` | `admin.invites.write` | api_key, session | no |
| `cache.reset` | POST | `/api/cache/reset` | `admin.cache.write` | api_key, session | no |
| `cache.status.list` | GET | `/api/cache/status` | `admin.cache.read` | api_key, session | no |
| `cache.reset.alias` | POST | `/v1/cache/reset` | `admin.cache.write` | api_key, session | no |
| `cache.status.list.alias` | GET | `/v1/cache/status` | `admin.cache.read` | api_key, session | no |

## console

| operationId | Method | Path | Permission | Auth | Streaming |
| --- | --- | --- | --- | --- | --- |
| `2fa.disable` | POST | `/api/2fa/disable` | — | session | no |
| `2fa.enable` | POST | `/api/2fa/enable` | — | session | no |
| `2fa.generate.list` | GET | `/api/2fa/generate` | — | session | no |
| `2fa.status.list` | GET | `/api/2fa/status` | — | session | no |
| `2fa.verify` | POST | `/api/2fa/verify` | — | session | no |
| `admin.update.apply` | POST | `/api/admin/update/apply` | — | session | no |
| `admin.update.check` | GET | `/api/admin/update/check` | — | session | no |
| `admin.update.runtime.list` | GET | `/api/admin/update/runtime` | — | session | no |
| `admin.update.status.list` | GET | `/api/admin/update/status` | — | session | no |
| `passkey.byCredentialID.delete` | DELETE | `/api/passkey/:credentialID` | — | session | no |
| `passkey.list.list` | GET | `/api/passkey/list` | — | session | no |
| `passkey.login.options.create` | POST | `/api/passkey/login/options` | — | session | no |
| `passkey.login.verify` | POST | `/api/passkey/login/verify` | — | session | no |
| `passkey.register.options.list` | GET | `/api/passkey/register/options` | — | session | no |
| `passkey.register.verify` | POST | `/api/passkey/register/verify` | — | session | no |
| `setup.admin.create` | POST | `/api/setup/admin` | — | session | no |
| `setup.edition.create` | POST | `/api/setup/edition` | — | session | no |
| `setup.mode.create` | POST | `/api/setup/mode` | — | session | no |
| `setup.status.list` | GET | `/api/setup/status` | — | session | no |
| `auth.changePassword.create` | POST | `/auth/change-password` | — | session | no |
| `auth.feishu.list` | GET | `/auth/feishu` | — | session | no |
| `auth.feishu.bind.create` | POST | `/auth/feishu/bind` | — | session | no |
| `auth.feishu.callback.list` | GET | `/auth/feishu/callback` | — | session | no |
| `auth.feishu.pending.list` | GET | `/auth/feishu/pending` | — | session | no |
| `auth.feishu.status.list` | GET | `/auth/feishu/status` | — | session | no |
| `auth.login.create` | POST | `/auth/login` | — | session | no |
| `auth.login.2fa.create` | POST | `/auth/login/2fa` | — | session | no |
| `auth.logout.list` | GET | `/auth/logout` | — | session | no |
| `auth.me.list` | GET | `/auth/me` | — | session | no |
| `auth.passport.list` | GET | `/auth/passport` | — | session | no |
| `auth.passport.callback.list` | GET | `/auth/passport/callback` | — | session | no |
| `auth.passport.cancel` | GET | `/auth/passport/cancel` | — | session | no |
| `auth.passport.redirectUri.list` | GET | `/auth/passport/redirect-uri` | — | session | no |
| `auth.setPassword.create` | POST | `/auth/set-password` | — | session | no |
| `auth.status.list` | GET | `/auth/status` | — | session | no |

## content

| operationId | Method | Path | Permission | Auth | Streaming |
| --- | --- | --- | --- | --- | --- |
| `conversations.list` | GET | `/api/conversations` | `conversations.read` | api_key, session | no |
| `conversations.create` | POST | `/api/conversations` | `conversations.write` | api_key, session | no |
| `conversations.byId.delete` | DELETE | `/api/conversations/:id` | `conversations.write` | api_key, session | no |
| `conversations.byId.get` | GET | `/api/conversations/:id` | `conversations.read` | api_key, session | no |
| `conversations.byId.update` | PUT | `/api/conversations/:id` | `conversations.write` | api_key, session | no |
| `conversations.byId.fork.create` | POST | `/api/conversations/:id/fork` | `conversations.write` | api_key, session | no |
| `conversations.byId.messages.create` | POST | `/api/conversations/:id/messages` | `conversations.write` | api_key, session | no |
| `conversations.byId.messages.update` | PUT | `/api/conversations/:id/messages` | `conversations.write` | api_key, session | no |
| `conversations.byId.messages.byMsgIndex.delete` | DELETE | `/api/conversations/:id/messages/:msgIndex` | `conversations.write` | api_key, session | no |
| `user.customInstructions.list` | GET | `/api/user/custom-instructions` | `prompts.read` | api_key, session | no |
| `user.customInstructions.byFingerprint.get` | GET | `/api/user/custom-instructions/:fingerprint` | `prompts.read` | api_key, session | no |
| `user.injectPrompts.list` | GET | `/api/user/inject-prompts` | `prompts.read` | api_key, session | no |
| `user.injectPrompts.create` | POST | `/api/user/inject-prompts` | `prompts.write` | api_key, session | no |
| `user.injectPrompts.byId.delete` | DELETE | `/api/user/inject-prompts/:id` | `prompts.write` | api_key, session | no |
| `user.injectPrompts.byId.update` | PUT | `/api/user/inject-prompts/:id` | `prompts.write` | api_key, session | no |
| `user.injectPrompts.byId.keys.update` | PUT | `/api/user/inject-prompts/:id/keys` | `prompts.write` | api_key, session | no |
| `user.injectPrompts.byId.toggle` | PUT | `/api/user/inject-prompts/:id/toggle` | `prompts.write` | api_key, session | no |
| `user.injectPrompts.myKeys.list` | GET | `/api/user/inject-prompts/my-keys` | `prompts.read` | api_key, session | no |

## events

| operationId | Method | Path | Permission | Auth | Streaming |
| --- | --- | --- | --- | --- | --- |
| `clientEvents.create` | POST | `/api/client-events` | `events.report` | api_key, oauth | no |
| `clientEvents.capabilities.list` | GET | `/api/client-events/capabilities` | `events.read` | api_key, oauth | no |
| `clientEvents.live.list` | GET | `/api/client-events/live` | `events.read` | api_key, oauth | no |
| `clientEvents.recentEvents.list` | GET | `/api/client-events/recent-events` | `events.read` | api_key, oauth | no |

## gateway

| operationId | Method | Path | Permission | Auth | Streaming |
| --- | --- | --- | --- | --- | --- |
| `chat.completions.create.alias` | POST | `/api/chat/completions` | `gateway.chat` | api_key, oauth | no |
| `messages.create.alias` | POST | `/api/messages` | `gateway.messages` | api_key, oauth | no |
| `models.list.alias` | GET | `/api/models` | `gateway.models` | api_key, oauth | no |
| `responses.create.alias` | POST | `/api/responses` | `gateway.responses` | api_key, oauth | no |
| `gateway.chat.completions.create` | POST | `/v1/chat/completions` | `gateway.chat` | api_key, oauth | yes |
| `interactions.create` | POST | `/v1/interactions` | `gateway.gemini` | api_key, oauth | no |
| `interactions.byId.delete` | DELETE | `/v1/interactions/:id` | `gateway.gemini` | api_key, oauth | no |
| `interactions.byId.get` | GET | `/v1/interactions/:id` | `gateway.gemini` | api_key, oauth | no |
| `interactions.byId.cancel` | POST | `/v1/interactions/:id/cancel` | `gateway.gemini` | api_key, oauth | no |
| `gateway.messages.create` | POST | `/v1/messages` | `gateway.messages` | api_key, oauth | yes |
| `gateway.models.list` | GET | `/v1/models` | `gateway.models` | api_key, oauth | no |
| `models.list` | GET | `/v1/models/*` | `gateway.gemini` | api_key, oauth | no |
| `models.create` | POST | `/v1/models/*` | `gateway.gemini` | api_key, oauth | no |
| `gateway.responses.create` | POST | `/v1/responses` | `gateway.responses` | api_key, oauth | yes |
| `v1beta.interactions.create` | POST | `/v1beta/interactions` | `gateway.gemini` | api_key, oauth | no |
| `v1beta.interactions.byId.delete` | DELETE | `/v1beta/interactions/:id` | `gateway.gemini` | api_key, oauth | no |
| `v1beta.interactions.byId.get` | GET | `/v1beta/interactions/:id` | `gateway.gemini` | api_key, oauth | no |
| `v1beta.interactions.byId.cancel` | POST | `/v1beta/interactions/:id/cancel` | `gateway.gemini` | api_key, oauth | no |
| `v1beta.models.list` | GET | `/v1beta/models` | `gateway.gemini` | api_key, oauth | no |
| `v1beta.models.list2` | GET | `/v1beta/models/*` | `gateway.gemini` | api_key, oauth | no |
| `v1beta.models.create` | POST | `/v1beta/models/*` | `gateway.gemini` | api_key, oauth | no |

## keys

| operationId | Method | Path | Permission | Auth | Streaming |
| --- | --- | --- | --- | --- | --- |
| `user.apiKeys.list` | GET | `/api/user/api-keys` | `keys.read` | api_key, session | no |
| `user.apiKeys.create` | POST | `/api/user/api-keys` | `keys.write` | api_key, session | no |
| `user.apiKeys.byId.delete` | DELETE | `/api/user/api-keys/:id` | `keys.write` | api_key, session | no |
| `user.apiKeys.byId.update` | PUT | `/api/user/api-keys/:id` | `keys.write` | api_key, session | no |
| `user.apiKeys.byId.config.list` | GET | `/api/user/api-keys/:id/config` | `keys.secret` | api_key, session | no |
| `user.apiKeys.byId.crewrouterCommands.update` | PUT | `/api/user/api-keys/:id/crewrouter-commands` | `keys.write` | api_key, session | no |
| `user.apiKeys.byId.enabled.update` | PUT | `/api/user/api-keys/:id/enabled` | `keys.write` | api_key, session | no |
| `user.apiKeys.byId.fusionConfig.list` | GET | `/api/user/api-keys/:id/fusion-config` | `keys.read` | api_key, session | no |
| `user.apiKeys.byId.fusionConfig.update` | PUT | `/api/user/api-keys/:id/fusion-config` | `keys.write` | api_key, session | no |
| `user.apiKeys.byId.harnessModels.list` | GET | `/api/user/api-keys/:id/harness-models` | `keys.read` | api_key, session | no |
| `user.apiKeys.byId.harnessModels.update` | PUT | `/api/user/api-keys/:id/harness-models` | `keys.write` | api_key, session | no |
| `user.apiKeys.byId.members.list` | GET | `/api/user/api-keys/:id/members` | `keys.members` | api_key, session | no |
| `user.apiKeys.byId.members.create` | POST | `/api/user/api-keys/:id/members` | `keys.members` | api_key, session | no |
| `user.apiKeys.byId.members.byUserId.delete` | DELETE | `/api/user/api-keys/:id/members/:userId` | `keys.members` | api_key, session | no |
| `user.apiKeys.byId.members.me.delete` | DELETE | `/api/user/api-keys/:id/members/me` | `keys.members` | api_key, session | no |
| `user.apiKeys.byId.models.list` | GET | `/api/user/api-keys/:id/models` | `keys.read` | api_key, session | no |
| `user.apiKeys.byId.models.update` | PUT | `/api/user/api-keys/:id/models` | `keys.write` | api_key, session | no |
| `user.apiKeys.byId.quotaWarning.list` | GET | `/api/user/api-keys/:id/quota-warning` | `keys.read` | api_key, session | no |
| `user.apiKeys.byId.quotaWarning.update` | PUT | `/api/user/api-keys/:id/quota-warning` | `keys.write` | api_key, session | no |
| `user.apiKeys.byId.requestModelBindings.list` | GET | `/api/user/api-keys/:id/request-model-bindings` | `keys.read` | api_key, session | no |
| `user.apiKeys.byId.requestModelBindings.update` | PUT | `/api/user/api-keys/:id/request-model-bindings` | `keys.write` | api_key, session | no |
| `user.apiKeys.byId.schedule.list` | GET | `/api/user/api-keys/:id/schedule` | `keys.read` | api_key, session | no |
| `user.apiKeys.byId.schedule.update` | PUT | `/api/user/api-keys/:id/schedule` | `keys.write` | api_key, session | no |
| `user.apiKeys.byId.signature.list` | GET | `/api/user/api-keys/:id/signature` | `keys.read` | api_key, session | no |
| `user.apiKeys.byId.signature.update` | PUT | `/api/user/api-keys/:id/signature` | `keys.write` | api_key, session | no |
| `user.apiKeys.byId.swallowImages.update` | PUT | `/api/user/api-keys/:id/swallow-images` | `keys.write` | api_key, session | no |
| `user.apiKeys.byId.tags.update` | PUT | `/api/user/api-keys/:id/tags` | `keys.write` | api_key, session | no |
| `user.apiKeys.byId.usage.list` | GET | `/api/user/api-keys/:id/usage` | `keys.read` | api_key, session | no |
| `user.apiKeys.reorder` | PUT | `/api/user/api-keys/reorder` | `keys.write` | api_key, session | no |
| `user.keyTags.list` | GET | `/api/user/key-tags` | `keys.read` | api_key, session | no |
| `user.keyTags.create` | POST | `/api/user/key-tags` | `keys.write` | api_key, session | no |
| `user.keyTags.byId.delete` | DELETE | `/api/user/key-tags/:id` | `keys.write` | api_key, session | no |
| `user.keyTags.byId.update` | PUT | `/api/user/key-tags/:id` | `keys.write` | api_key, session | no |
| `user.keyTags.reorder` | PUT | `/api/user/key-tags/reorder` | `keys.write` | api_key, session | no |

## management

| operationId | Method | Path | Permission | Auth | Streaming |
| --- | --- | --- | --- | --- | --- |
| `admin.policies.list` | GET | `/api/admin/policies` | — | session | no |
| `admin.policies.create` | POST | `/api/admin/policies` | — | session | no |
| `admin.policies.byId.delete` | DELETE | `/api/admin/policies/:id` | — | session | no |
| `admin.policies.byId.get` | GET | `/api/admin/policies/:id` | — | session | no |
| `admin.policies.byId.update` | PUT | `/api/admin/policies/:id` | — | session | no |
| `admin.policies.byId.archive.create` | POST | `/api/admin/policies/:id/archive` | — | session | no |
| `admin.policies.byId.diff.list` | GET | `/api/admin/policies/:id/diff` | — | session | no |
| `admin.policies.byId.duplicate.create` | POST | `/api/admin/policies/:id/duplicate` | — | session | no |
| `admin.policies.byId.publish` | POST | `/api/admin/policies/:id/publish` | — | session | no |
| `admin.policies.byId.rollback.byVersion.create` | POST | `/api/admin/policies/:id/rollback/:version` | — | session | no |
| `admin.policies.byId.unpublish.create` | POST | `/api/admin/policies/:id/unpublish` | — | session | no |
| `admin.policies.byId.versions.list` | GET | `/api/admin/policies/:id/versions` | — | session | no |
| `admin.policies.analytics.list` | GET | `/api/admin/policies/analytics` | — | session | no |
| `admin.policies.bulk.create` | POST | `/api/admin/policies/bulk` | — | session | no |
| `admin.policies.conflicts.list` | GET | `/api/admin/policies/conflicts` | — | session | no |
| `admin.policies.effective.list` | GET | `/api/admin/policies/effective` | — | session | no |
| `admin.policies.export` | GET | `/api/admin/policies/export` | — | session | no |
| `admin.policies.fromTemplate.create` | POST | `/api/admin/policies/from-template` | — | session | no |
| `admin.policies.health.list` | GET | `/api/admin/policies/health` | — | session | no |
| `admin.policies.import` | POST | `/api/admin/policies/import` | — | session | no |
| `admin.policies.metrics.list` | GET | `/api/admin/policies/metrics` | — | session | no |
| `admin.policies.outputScan.create` | POST | `/api/admin/policies/output-scan` | — | session | no |
| `admin.policies.overview.list` | GET | `/api/admin/policies/overview` | — | session | no |
| `admin.policies.preview.create` | POST | `/api/admin/policies/preview` | — | session | no |
| `admin.policies.report.list` | GET | `/api/admin/policies/report` | — | session | no |
| `admin.policies.schema.list` | GET | `/api/admin/policies/schema` | — | session | no |
| `admin.policies.simulate.create` | POST | `/api/admin/policies/simulate` | — | session | no |
| `admin.policies.templates.list` | GET | `/api/admin/policies/templates` | — | session | no |
| `admin.policyAlertRules.list` | GET | `/api/admin/policy-alert-rules` | — | session | no |
| `admin.policyAlertRules.create` | POST | `/api/admin/policy-alert-rules` | — | session | no |
| `admin.policyAlertRules.byId.delete` | DELETE | `/api/admin/policy-alert-rules/:id` | — | session | no |
| `admin.policyAlertRules.byId.update` | PUT | `/api/admin/policy-alert-rules/:id` | — | session | no |
| `admin.policyAppeals.list` | GET | `/api/admin/policy-appeals` | — | session | no |
| `admin.policyAppeals.byId.decide.create` | POST | `/api/admin/policy-appeals/:id/decide` | — | session | no |
| `admin.policyApprovals.list` | GET | `/api/admin/policy-approvals` | — | session | no |
| `admin.policyApprovals.byId.decide.create` | POST | `/api/admin/policy-approvals/:id/decide` | — | session | no |
| `admin.policyChannels.list` | GET | `/api/admin/policy-channels` | — | session | no |
| `admin.policyChannels.create` | POST | `/api/admin/policy-channels` | — | session | no |
| `admin.policyChannels.byId.delete` | DELETE | `/api/admin/policy-channels/:id` | — | session | no |
| `admin.policyChannels.byId.update` | PUT | `/api/admin/policy-channels/:id` | — | session | no |
| `admin.policyChannels.byId.test` | POST | `/api/admin/policy-channels/:id/test` | — | session | no |
| `admin.policyClients.list` | GET | `/api/admin/policy-clients` | — | session | no |
| `admin.policyExemptions.list` | GET | `/api/admin/policy-exemptions` | — | session | no |
| `admin.policyExemptions.create` | POST | `/api/admin/policy-exemptions` | — | session | no |
| `admin.policyExemptions.byId.delete` | DELETE | `/api/admin/policy-exemptions/:id` | — | session | no |
| `admin.policyExemptions.fromHit.byHitId.create` | POST | `/api/admin/policy-exemptions/from-hit/:hitId` | — | session | no |
| `admin.policyGroups.list` | GET | `/api/admin/policy-groups` | — | session | no |
| `admin.policyGroups.create` | POST | `/api/admin/policy-groups` | — | session | no |
| `admin.policyGroups.byId.delete` | DELETE | `/api/admin/policy-groups/:id` | — | session | no |
| `admin.policyGroups.byId.update` | PUT | `/api/admin/policy-groups/:id` | — | session | no |
| `admin.policyHits.list` | GET | `/api/admin/policy-hits` | — | session | no |
| `admin.policyHits.byId.get` | GET | `/api/admin/policy-hits/:id` | — | session | no |
| `admin.policyHits.stream.list` | GET | `/api/admin/policy-hits/stream` | — | session | no |
| `admin.policyLoginEvents.list` | GET | `/api/admin/policy-login-events` | — | session | no |
| `admin.policyMembers.list` | GET | `/api/admin/policy-members` | — | session | no |
| `admin.policyMembers.byUserId.bypass.create` | POST | `/api/admin/policy-members/:userId/bypass` | — | session | no |
| `admin.policyMembers.byUserId.offboard.create` | POST | `/api/admin/policy-members/:userId/offboard` | — | session | no |
| `admin.policyMembers.byUserId.resume.create` | POST | `/api/admin/policy-members/:userId/resume` | — | session | no |
| `admin.policyMembers.byUserId.role.create` | POST | `/api/admin/policy-members/:userId/role` | — | session | no |
| `admin.policyMembers.byUserId.suspend.create` | POST | `/api/admin/policy-members/:userId/suspend` | — | session | no |
| `admin.policyMembers.bulk.create` | POST | `/api/admin/policy-members/bulk` | — | session | no |
| `admin.policySettings.list` | GET | `/api/admin/policy-settings` | — | session | no |
| `admin.policySettings.update` | PUT | `/api/admin/policy-settings` | — | session | no |
| `admin.policySettings.killSwitch.create` | POST | `/api/admin/policy-settings/kill-switch` | — | session | no |
| `admin.policyTags.list` | GET | `/api/admin/policy-tags` | — | session | no |
| `admin.policyTeams.list` | GET | `/api/admin/policy-teams` | — | session | no |
| `admin.policyUsers.list` | GET | `/api/admin/policy-users` | — | session | no |
| `user.policies.blocks.list` | GET | `/api/user/policies/blocks` | — | session | no |
| `user.policies.mine.list` | GET | `/api/user/policies/mine` | — | session | no |
| `user.policyAppeals.list` | GET | `/api/user/policy-appeals` | — | session | no |
| `user.policyAppeals.create` | POST | `/api/user/policy-appeals` | — | session | no |
| `user.policyApprovals.byId.get` | GET | `/api/user/policy-approvals/:id` | — | session | no |
| `user.policyRole.list` | GET | `/api/user/policy-role` | — | session | no |
| `user.suspension.list` | GET | `/api/user/suspension` | — | session | no |

## models

| operationId | Method | Path | Permission | Auth | Streaming |
| --- | --- | --- | --- | --- | --- |
| `user.modelLibrary.list` | GET | `/api/user/model-library` | `models.read` | api_key, session | no |
| `user.modelLibrary.hidden.delete` | DELETE | `/api/user/model-library/hidden` | `models.write` | api_key, session | no |
| `user.modelLibrary.hidden.update` | PUT | `/api/user/model-library/hidden` | `models.write` | api_key, session | no |
| `user.modelLibrary.order` | DELETE | `/api/user/model-library/order` | `models.write` | api_key, session | no |
| `user.modelLibrary.order2` | PUT | `/api/user/model-library/order` | `models.write` | api_key, session | no |
| `user.modelLibrary.order.byTest.update` | PUT | `/api/user/model-library/order/by-test` | `models.write` | api_key, session | no |
| `user.modelLibrary.search` | GET | `/api/user/model-library/search` | `models.read` | api_key, session | no |
| `user.modelLibrary.star` | PUT | `/api/user/model-library/star` | `models.write` | api_key, session | no |
| `user.models.list` | GET | `/api/user/models` | `models.read` | api_key, session | no |
| `user.models.create` | POST | `/api/user/models` | `models.write` | api_key, session | no |
| `user.models.byId.delete` | DELETE | `/api/user/models/:id` | `models.write` | api_key, session | no |
| `user.models.byId.update` | PUT | `/api/user/models/:id` | `models.write` | api_key, session | no |
| `user.models.byId.info.list` | GET | `/api/user/models/:id/info` | `models.read` | api_key, session | no |
| `user.models.byId.publish` | POST | `/api/user/models/:id/publish` | `models.write` | api_key, session | no |
| `user.models.byId.test` | POST | `/api/user/models/:id/test` | `models.write` | api_key, session | no |
| `user.models.byId.uptime.list` | GET | `/api/user/models/:id/uptime` | `models.read` | api_key, session | no |
| `user.models.testBatch` | POST | `/api/user/models/test-batch` | `models.write` | api_key, session | no |
| `user.models.uptime.list` | GET | `/api/user/models/uptime` | `models.read` | api_key, session | no |
| `user.myProviders.list` | GET | `/api/user/my-providers` | `providers.read` | api_key, session | no |
| `user.myTeamModels.list` | GET | `/api/user/my-team-models` | `models.read` | api_key, session | no |
| `user.myTeamModels.batchDelete` | POST | `/api/user/my-team-models/batch-delete` | `models.write` | api_key, session | no |
| `user.myTeamModels.batchUpdate` | POST | `/api/user/my-team-models/batch-update` | `models.write` | api_key, session | no |
| `user.providerTags.list` | GET | `/api/user/provider-tags` | `providers.read` | api_key, session | no |
| `user.providers.list` | GET | `/api/user/providers` | `providers.read` | api_key, session | no |
| `user.providers.create` | POST | `/api/user/providers` | `providers.write` | api_key, session | no |
| `user.providers.byId.delete` | DELETE | `/api/user/providers/:id` | `providers.write` | api_key, session | no |
| `user.providers.byId.update` | PUT | `/api/user/providers/:id` | `providers.write` | api_key, session | no |
| `user.providers.byId.models.list` | GET | `/api/user/providers/:id/models` | `models.read` | api_key, session | no |
| `user.providers.byId.ping` | GET | `/api/user/providers/:id/ping` | `providers.read` | api_key, session | no |
| `user.providers.byId.refreshModels` | POST | `/api/user/providers/:id/refresh-models` | `providers.write` | api_key, session | no |
| `user.providers.byProviderId.models.byModelId.delete` | DELETE | `/api/user/providers/:providerId/models/:modelId` | `models.write` | api_key, session | no |
| `user.providers.byProviderId.models.batchDelete` | POST | `/api/user/providers/:providerId/models/batch-delete` | `models.write` | api_key, session | no |
| `user.providers.byProviderId.models.batchUpdate` | POST | `/api/user/providers/:providerId/models/batch-update` | `models.write` | api_key, session | no |
| `user.providers.lookupIndex.list` | GET | `/api/user/providers/lookup-index` | `providers.read` | api_key, session | no |
| `user.providers.lookup.byName.get` | GET | `/api/user/providers/lookup/:name` | `providers.read` | api_key, session | no |
| `user.providers.quota.list` | GET | `/api/user/providers/quota` | `providers.read` | api_key, session | no |
| `user.providers.quota.refresh` | POST | `/api/user/providers/quota/refresh` | `providers.write` | api_key, session | no |
| `user.team.byTeamId.provider.byProviderId.models.list` | GET | `/api/user/team/:teamId/provider/:providerId/models` | `models.read` | api_key, session | no |

## notifications

| operationId | Method | Path | Permission | Auth | Streaming |
| --- | --- | --- | --- | --- | --- |
| `user.alertHistory.list` | GET | `/api/user/alert-history` | `notifications.read` | api_key, session | no |
| `user.alertSettings.list` | GET | `/api/user/alert-settings` | `notifications.read` | api_key, session | no |
| `user.alertSettings.update` | PUT | `/api/user/alert-settings` | `notifications.write` | api_key, session | no |
| `user.alertSettings.test` | POST | `/api/user/alert-settings/test` | `notifications.write` | api_key, session | no |
| `user.hookNotifyRules.list` | GET | `/api/user/hook-notify-rules` | `notifications.read` | api_key, session | no |
| `user.hookNotifyRules.pushEnabled.update` | PUT | `/api/user/hook-notify-rules/push-enabled` | `notifications.write` | api_key, session | no |
| `user.hookNotifyRules.selection.update` | PUT | `/api/user/hook-notify-rules/selection` | `notifications.write` | api_key, session | no |
| `user.notificationSettings.list` | GET | `/api/user/notification-settings` | `notifications.read` | api_key, session | no |
| `user.notificationSettings.update` | PUT | `/api/user/notification-settings` | `notifications.write` | api_key, session | no |
| `user.notificationSettings.test` | POST | `/api/user/notification-settings/test` | `notifications.write` | api_key, session | no |
| `user.notifications.delete` | DELETE | `/api/user/notifications` | `notifications.write` | api_key, session | no |
| `user.notifications.list` | GET | `/api/user/notifications` | `notifications.read` | api_key, session | no |
| `user.notifications.byId.delete` | DELETE | `/api/user/notifications/:id` | `notifications.write` | api_key, session | no |
| `user.notifications.byId.read` | PUT | `/api/user/notifications/:id/read` | `notifications.write` | api_key, session | no |
| `user.pluginPrefOptin.list` | GET | `/api/user/plugin-pref-optin` | `notifications.read` | api_key, session | no |
| `user.pluginPrefOptin.update` | PUT | `/api/user/plugin-pref-optin` | `notifications.write` | api_key, session | no |
| `user.popupNotices.list` | GET | `/api/user/popup-notices` | `notifications.read` | api_key, session | no |
| `user.popupNotices.seen` | POST | `/api/user/popup-notices/seen` | `notifications.write` | api_key, session | no |

## oauth

| operationId | Method | Path | Permission | Auth | Streaming |
| --- | --- | --- | --- | --- | --- |
| `wellKnown.oauthAuthorizationServer.list` | GET | `/.well-known/oauth-authorization-server` | — | public | no |
| `oauth.authorizations.list` | GET | `/oauth/authorizations` | — | session | no |
| `oauth.authorizations.revoke` | POST | `/oauth/authorizations/revoke` | — | session | no |
| `oauth.authorize.list` | GET | `/oauth/authorize` | — | session | no |
| `oauth.authorize.approve` | POST | `/oauth/authorize/approve` | — | session | no |
| `oauth.authorize.info.list` | GET | `/oauth/authorize/info` | — | session | no |
| `oauth.desktopSession.create` | POST | `/oauth/desktop-session` | — | public | no |
| `oauth.githubActions.create` | POST | `/oauth/github-actions` | — | session | no |
| `oauth.revoke` | POST | `/oauth/revoke` | — | public | no |
| `oauth.token.create` | POST | `/oauth/token` | — | public | no |

## public

| operationId | Method | Path | Permission | Auth | Streaming |
| --- | --- | --- | --- | --- | --- |
| `i18n.catalog.list` | GET | `/api/i18n/catalog` | — | public | no |

## tools

| operationId | Method | Path | Permission | Auth | Streaming |
| --- | --- | --- | --- | --- | --- |
| `agent.images.list` | GET | `/api/agent/images` | `agent.use` | api_key, session | no |
| `agent.images.create` | POST | `/api/agent/images` | `agent.use` | api_key, session | no |
| `agent.images.byId.content.list` | GET | `/api/agent/images/:id/content` | `agent.use` | api_key, session | no |
| `agent.manage.approvals.byId.create` | POST | `/api/agent/manage/approvals/:id` | `agent.manage` | api_key, session | no |
| `agent.manage.attachments.create` | POST | `/api/agent/manage/attachments` | `agent.manage` | api_key, session | no |
| `agent.manage.attachments.byId.delete` | DELETE | `/api/agent/manage/attachments/:id` | `agent.manage` | api_key, session | no |
| `agent.manage.attachments.byId.get` | GET | `/api/agent/manage/attachments/:id` | `agent.manage` | api_key, session | no |
| `agent.manage.attachments.byId.content.list` | GET | `/api/agent/manage/attachments/:id/content` | `agent.manage` | api_key, session | no |
| `agent.manage.attachments.url.create` | POST | `/api/agent/manage/attachments/url` | `agent.manage` | api_key, session | no |
| `agent.manage.runs.create` | POST | `/api/agent/manage/runs` | `agent.manage` | api_key, session | no |
| `agent.manage.threads.list` | GET | `/api/agent/manage/threads` | `agent.manage` | api_key, session | no |
| `agent.manage.threads.byId.get` | GET | `/api/agent/manage/threads/:id` | `agent.manage` | api_key, session | no |
| `playground.chat.create` | POST | `/api/playground/chat` | `playground.use` | api_key, session | no |
| `playground.diagnose.list` | GET | `/api/playground/diagnose` | `playground.use` | api_key, session | no |
| `playground.history.list` | GET | `/api/playground/history` | `playground.use` | api_key, session | no |
| `playground.history.byId.delete` | DELETE | `/api/playground/history/:id` | `playground.use` | api_key, session | no |
| `playground.history.byId.get` | GET | `/api/playground/history/:id` | `playground.use` | api_key, session | no |
| `playground.thinkingCapabilities.list` | GET | `/api/playground/thinking-capabilities` | `playground.use` | api_key, session | no |
| `user.modelTrace.bank.list` | GET | `/api/user/model-trace/bank` | — | session | no |
| `user.modelTrace.jobs.list` | GET | `/api/user/model-trace/jobs` | — | session | no |
| `user.modelTrace.jobs.create` | POST | `/api/user/model-trace/jobs` | — | session | no |
| `user.modelTrace.jobs.byId.get` | GET | `/api/user/model-trace/jobs/:id` | — | session | no |
| `user.modelTrace.jobs.byId.cancel` | POST | `/api/user/model-trace/jobs/:id/cancel` | — | session | no |
| `user.modelTrace.targets.list` | GET | `/api/user/model-trace/targets` | — | session | no |

