import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
const requireDesktop = createRequire(path.resolve('CrewRouter-Desktop/package.json'));
const { parse } = requireDesktop('yaml');

const files = [
  '.github/workflows/build-docker.yml',
  '.github/workflows/build-desktop.yml',
  '.github/workflows/beta-release.yml',
];
for (const file of files) {
  const doc = parse(await readFile(file, 'utf8'));
  if (!doc || typeof doc !== 'object' || !doc.jobs) throw new Error(`${file} did not parse into jobs`);
}
const beta = parse(await readFile(files[2], 'utf8'));
if (JSON.stringify(beta.on.push.tags) !== JSON.stringify(['v27.0.0-beta.1'])) throw new Error('beta workflow must only publish the explicitly versioned candidate tag');
const manualDryRun = beta.jobs.desktop.if?.includes('inputs.dry_run') && beta.jobs['npm-beta-candidate'].if?.includes('inputs.dry_run');
if (!manualDryRun || beta.jobs['npm-beta-candidate'].needs.join(',') !== 'gate,server,desktop') throw new Error('manual dry-run must build server, desktop and npm candidate assets from one SHA');
const prereleaseDownloadNames = beta.jobs['github-prerelease'].steps.filter(step => step.uses === 'actions/download-artifact@v4').map(step => step.with?.pattern);
if (JSON.stringify(prereleaseDownloadNames) !== JSON.stringify(['beta-server-*', 'beta-crewrouter-desktop-*'])) throw new Error('GitHub release must download only server and Desktop assets');
if (!beta.jobs['gate'].steps.some(step => step.name === 'Validate beta tag and all npm manifests' && step.run?.includes('Publishing requires dispatch from') && step.run?.includes('git rev-parse'))) throw new Error('manual publish must require the checked-out commit to match the release tag');
if (!beta.jobs['gate'].steps.some(step => step.name === 'Verify npm beta names are unclaimed' && step.if?.includes("github.event_name == 'push'"))) throw new Error('npm package ownership must be checked only on tag publish');
const desktopWorkflow = parse(await readFile(files[1], 'utf8'));
for (const event of ['push', 'pull_request']) {
  const paths = desktopWorkflow.on[event].paths || [];
  for (const required of ['cli/**', 'deploy/**']) if (!paths.includes(required)) throw new Error(`Desktop CI ${event} path filter omits ${required}`);
}
const sdkWorkflow = parse(await readFile('.github/workflows/sdk-ci.yml', 'utf8'));
for (const event of ['push', 'pull_request']) {
  const paths = sdkWorkflow.on[event].paths || [];
  for (const required of ['cli/**', 'CrewRouter-Desktop/package.json', 'server/index.js', 'server/routes/mount-loader.js']) if (!paths.includes(required)) throw new Error(`SDK CI ${event} path filter omits ${required}`);
}
if (!sdkWorkflow.jobs.contract.steps.some(step => step.run === 'npm run sdk:conformance')) throw new Error('SDK CI contract job must run cross-language conformance');
if (!sdkWorkflow.jobs.contract.steps.some(step => step.run === 'node server/scripts/test-upstream-generation-routes.js')) throw new Error('SDK CI contract job must run the SDK-to-isolated-gateway integration suite');
if (!sdkWorkflow.jobs.contract.steps.some(step => step.run === 'node server/scripts/test-sdk-auth-integration.js')) throw new Error('SDK CI contract job must run the SDK authentication integration suite');
if (!sdkWorkflow.jobs['node-sdk'].steps.some(step => step.run?.includes('npm run sdk:conformance'))) throw new Error('Node SDK CI must run shared conformance and package checks');
const postgresSetup = beta.jobs.gate.steps.find(step => step.name === 'Install isolated PostgreSQL test runtime');
if (!postgresSetup?.run?.includes('pg_config --bindir')) throw new Error('PostgreSQL integration tests require their isolated runner dependencies');
if (!beta.jobs['npm-beta-candidate'].steps.some(step => step.uses === 'actions/upload-artifact@v4' && step.with?.name?.startsWith('crewrouter-27-beta-npm-candidates-') && step.if?.includes("inputs.dry_run"))) throw new Error('npm beta candidate tarballs must be uploaded for dry-runs and tagged builds');
const sdkPack = beta.jobs['npm-beta-candidate'].steps.find(step => step.name === 'Build and pack SDK candidate');
if (!sdkPack?.run?.includes('cd sdk/typescript') || !sdkPack.run.includes('test -f "$RUNNER_TEMP/bloret-crew-crewrouter-sdk-${PRODUCT_VERSION}.tgz"')) throw new Error('SDK candidate must pack from sdk/typescript and verify its tarball name');
const cliPack = beta.jobs['npm-beta-candidate'].steps.find(step => step.name === 'Build and pack CLI candidate');
if (!cliPack?.run?.includes('test -f "$RUNNER_TEMP/bloret-crew-crewrouter-${PRODUCT_VERSION}.tgz"')) throw new Error('CLI candidate must verify its tarball name');
const npmPublishStep = beta.jobs['npm-beta-publish'].steps.find(step => step.name === 'Confirm npm package ownership and publish candidate packages');
if (!npmPublishStep?.run?.includes('npm publish candidates/bloret-crew-crewrouter-sdk-${PRODUCT_VERSION}.tgz') || !npmPublishStep.run.includes('npm publish candidates/bloret-crew-crewrouter-${PRODUCT_VERSION}.tgz')) throw new Error('npm publish must publish both scoped candidates');
if (!npmPublishStep.run.includes('@bloret-crew/crewrouter-sdk @bloret-crew/crewrouter')) throw new Error('npm publish must target the scoped package names');
if (!npmPublishStep.run.includes('doc.versions')) throw new Error('npm publish must check the target version is still unpublished');
if (!sdkWorkflow.jobs['node-sdk'].steps.some(step => step.run === 'npm run sdk:conformance')) throw new Error('Node SDK CI must run shared fixtures and the package inspection');
if (!sdkWorkflow.jobs['go-sdk'].steps.some(step => step.run === 'go test ./...' && step['working-directory'] === 'sdk/go/consumer')) throw new Error('Go SDK CI omits external module consumer smoke test');
for (const required of ['python -m build --wheel --sdist sdk/python', 'python -m pip install --no-deps sdk/python/dist/*.whl', 'python -m pip install "httpx>=0.27"']) {
  if (!sdkWorkflow.jobs['python-sdk'].steps.some(step => step.run === required)) throw new Error(`Python SDK CI omits package artifact validation: ${required}`);
}
const npmNameGate = beta.jobs.gate.steps.find(step => step.name === 'Verify npm beta names are unclaimed');
if (!npmNameGate?.run?.includes('doc.versions')) throw new Error('npm name gate must allow already-owned packages when the target version is new');
if (beta.jobs['github-prerelease'].needs.join(',') !== 'gate,server,desktop,npm-beta-candidate') throw new Error('GitHub release must wait for all release and candidate build gates');
const npmPublish = beta.jobs['npm-beta-publish'];
if (!npmPublish || !npmPublish.needs.includes('npm-beta-candidate') || !npmPublish.permissions?.['id-token']) throw new Error('manual npm publish must use the separately approved candidate artifact and OIDC permissions');
if (beta.jobs['npm-beta-publish'].steps.find(step => step.uses === 'actions/download-artifact@v4')?.with?.name !== 'crewrouter-27-beta-npm-candidates-${{ github.sha }}') throw new Error('npm publish must download candidate tarballs from this workflow run');
if (beta.jobs['github-release-manual'].needs.includes('npm-beta-publish') !== true) throw new Error('manual GitHub release must await npm publish if publish was explicitly selected');
const electronGate = beta.jobs.gate.steps.find(step => step.name === 'Desktop behavior, sandboxed launcher and syntax');
if (!electronGate?.run?.includes('chown root node_modules/electron/dist/chrome-sandbox') || !electronGate.run.includes('chmod 4755 node_modules/electron/dist/chrome-sandbox') || electronGate.run.includes('--no-sandbox')) throw new Error('Electron launcher gate must retain sandbox and configure the isolated SUID helper');
for (const openapiPath of ['sdk/contract/openapi.json', 'docs/api/openapi.json']) {
  const openapi = JSON.parse(await readFile(openapiPath, 'utf8'));
  const adminUsers = openapi.paths['/api/admin/users']?.get;
  const adminProducts = openapi.paths['/api/admin/products']?.get?.responses?.[200]?.content?.['application/json']?.schema;
  const adminUsageLogs = openapi.paths['/api/admin/usage-logs']?.get?.responses?.[200]?.content?.['application/json']?.schema;
  const adminStatsFilters = openapi.paths['/api/admin/stats/multi/filters']?.get?.responses?.[200]?.content?.['application/json']?.schema;
  const adminTeamMembers = openapi.paths['/api/admin/teams/{id}/members']?.get?.responses?.[200]?.content?.['application/json']?.schema;
  const adminTeamModels = openapi.paths['/api/admin/teams/{id}/models']?.get?.responses?.[200]?.content?.['application/json']?.schema;
  const teamRules = openapi.paths['/api/admin/teams/{id}/rules']?.get?.responses?.[200]?.content?.['application/json']?.schema;
  const adminProviderTags = openapi.paths['/api/admin/provider-tags']?.get?.responses?.[200]?.content?.['application/json']?.schema;
  const adminProviderTagCreate = openapi.paths['/api/admin/provider-tags']?.post?.responses?.[200]?.content?.['application/json']?.schema;
  const adminProviderTagUpdate = openapi.paths['/api/admin/provider-tags/{id}']?.put?.responses?.[200]?.content?.['application/json']?.schema;
  const apiKeyList = openapi.paths['/api/user/api-keys']?.get?.responses?.[200]?.content?.['application/json']?.schema;
  const usage = openapi.paths['/api/user/usage']?.get?.responses?.[200]?.content?.['application/json']?.schema;
  const balance = openapi.paths['/api/user/balance']?.get?.responses?.[200]?.content?.['application/json']?.schema;
  const models = openapi.paths['/api/user/models']?.get?.responses?.[200]?.content?.['application/json']?.schema;
  const providers = openapi.paths['/api/user/providers']?.get?.responses?.[200]?.content?.['application/json']?.schema;
  const products = openapi.paths['/api/user/products']?.get?.responses?.[200]?.content?.['application/json']?.schema;
  const codeBalances = openapi.paths['/api/user/code-balances']?.get?.responses?.[200]?.content?.['application/json']?.schema;
  const providerTags = openapi.paths['/api/user/provider-tags']?.get?.responses?.[200]?.content?.['application/json']?.schema;
  const modelUptime = openapi.paths['/api/user/models/uptime']?.get?.responses?.[200]?.content?.['application/json']?.schema;
  const modelUptimeDetail = openapi.paths['/api/user/models/{id}/uptime']?.get?.responses?.[200]?.content?.['application/json']?.schema;
  const adminModelUptime = openapi.paths['/api/admin/models/uptime']?.get?.responses?.[200]?.content?.['application/json']?.schema;
  const adminModelUptimeDetail = openapi.paths['/api/admin/models/{id}/uptime']?.get?.responses?.[200]?.content?.['application/json']?.schema;
  const keyUsage = openapi.paths['/api/user/api-keys/{id}/usage']?.get?.responses?.[200]?.content?.['application/json']?.schema;
  const keyTags = openapi.paths['/api/user/key-tags']?.get?.responses?.[200]?.content?.['application/json']?.schema;
  const keyTagCreate = openapi.paths['/api/user/key-tags']?.post?.responses?.[201]?.content?.['application/json']?.schema;
  const keyTagUpdate = openapi.paths['/api/user/key-tags/{id}']?.put?.responses?.[200]?.content?.['application/json']?.schema;
  const keyMembers = openapi.paths['/api/user/api-keys/{id}/members']?.get?.responses?.[200]?.content?.['application/json']?.schema;
  const quotaWarning = openapi.paths['/api/user/api-keys/{id}/quota-warning']?.get?.responses?.[200]?.content?.['application/json']?.schema;
  const keySchedule = openapi.paths['/api/user/api-keys/{id}/schedule']?.get?.responses?.[200]?.content?.['application/json']?.schema;
  const currentModel = openapi.paths['/api/user/current-model']?.get?.responses?.[200]?.content?.['application/json']?.schema;
  const usageLogs = openapi.paths['/api/user/usage-logs']?.get?.responses?.[200]?.content?.['application/json']?.schema;
  const statsFilters = openapi.paths['/api/user/stats/filters']?.get?.responses?.[200]?.content?.['application/json']?.schema;
  const usageLogDetail = openapi.paths['/api/user/usage-logs/{id}']?.get?.responses?.[200]?.content?.['application/json']?.schema;
  const apiKeyModels = openapi.paths['/api/user/api-keys/{id}/models']?.get?.responses?.[200]?.content?.['application/json']?.schema;
  const apiKeyModelsUpdate = openapi.paths['/api/user/api-keys/{id}/models']?.put?.responses?.[200]?.content?.['application/json']?.schema;
  const apiKeyConfig = openapi.paths['/api/user/api-keys/{id}/config']?.get;
  const keyEnabled = openapi.paths['/api/user/api-keys/{id}/enabled']?.put?.responses?.[200]?.content?.['application/json']?.schema;
  const keySwallowImages = openapi.paths['/api/user/api-keys/{id}/swallow-images']?.put?.responses?.[200]?.content?.['application/json']?.schema;
  const keyCommands = openapi.paths['/api/user/api-keys/{id}/crewrouter-commands']?.put?.responses?.[200]?.content?.['application/json']?.schema;
  const keyTagsUpdate = openapi.paths['/api/user/api-keys/{id}/tags']?.put?.responses?.[200]?.content?.['application/json']?.schema;
  const fusionConfig = openapi.paths['/api/user/api-keys/{id}/fusion-config']?.get?.responses?.[200]?.content?.['application/json']?.schema;
  const fusionConfigPut = openapi.paths['/api/user/api-keys/{id}/fusion-config']?.put;
  const harnessModels = openapi.paths['/api/user/api-keys/{id}/harness-models']?.get?.responses?.[200]?.content?.['application/json']?.schema;
  const requestModelBindings = openapi.paths['/api/user/api-keys/{id}/request-model-bindings']?.get?.responses?.[200]?.content?.['application/json']?.schema;
  if (adminUsers?.['x-crewrouter-permission'] !== 'admin.users.read' || adminUsers.responses?.[200]?.content?.['application/json']?.schema?.oneOf?.length !== 2) throw new Error(`${openapiPath} must document admin user list pagination variants`);
  if (adminUsers.responses[200].content['application/json'].schema.oneOf[0].items?.$ref !== '#/components/schemas/AdminUser' || adminUsers.responses[200].content['application/json'].schema.oneOf[1].$ref !== '#/components/schemas/AdminUsersPage') throw new Error(`${openapiPath} must define admin user list row and page schemas`);
  if (adminProducts?.type !== 'array' || adminProducts.items?.$ref !== '#/components/schemas/AdminProduct') throw new Error(`${openapiPath} must define administrator product list responses`);
  if (adminUsageLogs?.$ref !== '#/components/schemas/AdminUsageLogsResponse' || openapi.components.schemas.AdminUsageLogsResponse?.properties?.logs?.items?.$ref !== '#/components/schemas/AdminUsageLog') throw new Error(`${openapiPath} must define paginated administrator usage logs`);
  if (adminStatsFilters?.$ref !== '#/components/schemas/AdminStatsFiltersResponse' || !['users', 'teams', 'models', 'providers', 'sources', 'projects'].every(key => openapi.components.schemas.AdminStatsFiltersResponse?.properties?.[key]?.type === 'array')) throw new Error(`${openapiPath} must define administrator stats filter arrays`);
  if (openapi.components.schemas.AdminUsersPage?.properties?.stats?.$ref !== '#/components/schemas/AdminUserStats') throw new Error(`${openapiPath} must define paginated admin user stats`);
  if (adminTeamMembers?.type !== 'array' || adminTeamMembers.items?.$ref !== '#/components/schemas/TeamMember') throw new Error(`${openapiPath} must define administrator Team member list responses`);
  if (adminTeamModels?.type !== 'array' || adminTeamModels.items?.$ref !== '#/components/schemas/TeamModelListItem') throw new Error(`${openapiPath} must define administrator Team model list responses`);
  if (teamRules?.type !== 'array' || teamRules.items?.$ref !== '#/components/schemas/TeamQuotaRule') throw new Error(`${openapiPath} must define Team quota rule lists`);
  if (!openapi.components.schemas.TeamQuotaRule?.additionalProperties || openapi.components.schemas.TeamQuotaRule?.properties?.rule_type?.enum?.join(',') !== 'requests,tokens') throw new Error(`${openapiPath} must describe extensible legacy Team quota rules`);
  if (adminProviderTags?.type !== 'array' || adminProviderTags.items?.$ref !== '#/components/schemas/AdminProviderTag') throw new Error(`${openapiPath} must define administrator provider tag list responses`);
  if (adminProviderTagCreate?.$ref !== '#/components/schemas/AdminProviderTagUpdateResponse' || adminProviderTagUpdate?.$ref !== '#/components/schemas/AdminProviderTagUpdateResponse') throw new Error(`${openapiPath} must define admin provider tag mutation responses`);
  if (apiKeyList?.type !== 'array' || apiKeyList.items?.$ref !== '#/components/schemas/ApiKeyListItem') throw new Error(`${openapiPath} must define API key list responses`);
  if (!openapi.components.schemas.ApiKeyListItem?.properties?.key_value?.type?.includes('null')) throw new Error(`${openapiPath} must document nullable/redacted API keys`);
  if (usage?.type !== 'array' || usage.items?.$ref !== '#/components/schemas/DailyUsageItem') throw new Error(`${openapiPath} must define daily usage responses`);
  if (balance?.$ref !== '#/components/schemas/UserBalance' || !openapi.components.schemas.UserBalance?.properties?.group?.anyOf?.some(item => item.type === 'null')) throw new Error(`${openapiPath} must define nullable balance group responses`);
  if (models?.type !== 'array' || models.items?.$ref !== '#/components/schemas/UserModelListItem') throw new Error(`${openapiPath} must define visible model list responses`);
  if (!openapi.components.schemas.UserModelListItem?.properties?.alias?.type?.includes('null')) throw new Error(`${openapiPath} must document nullable visible model aliases`);
  for (const field of ['upstream_model_id', 'provider_name', 'input_price_per_1k_tokens', 'output_price_per_1k_tokens', 'output_kind']) {
    if (!openapi.components.schemas.UserModelListItem?.properties?.[field]) throw new Error(`${openapiPath} is missing UserModelListItem.${field}`);
  }
  if (providers?.type !== 'array' || providers.items?.$ref !== '#/components/schemas/UserProviderListItem') throw new Error(`${openapiPath} must define visible provider list responses`);
  if (!openapi.components.schemas.UserProviderListItem?.properties?.created_by?.type?.includes('null')) throw new Error(`${openapiPath} must allow shared providers without created_by`);
  if (products?.type !== 'array' || products.items?.$ref !== '#/components/schemas/UserProduct') throw new Error(`${openapiPath} must define active product list responses`);
  if (!openapi.components.schemas.UserProduct?.properties?.description?.type?.includes('null') || !openapi.components.schemas.UserProduct?.properties?.link?.type?.includes('null')) throw new Error(`${openapiPath} must document nullable product fields`);
  if (codeBalances?.type !== 'array' || codeBalances.items?.$ref !== '#/components/schemas/UserCodeBalanceItem') throw new Error(`${openapiPath} must define code-balance list responses`);
  if (providerTags?.type !== 'array' || providerTags.items?.$ref !== '#/components/schemas/ProviderTag') throw new Error(`${openapiPath} must define provider-tag list responses`);
  if (modelUptime?.$ref !== '#/components/schemas/ModelUptimeResponse' || openapi.components.schemas.ModelUptimeResponse?.oneOf?.length !== 2) throw new Error(`${openapiPath} must define daily and 15-minute uptime variants`);
  if (modelUptimeDetail?.$ref !== '#/components/schemas/ModelUptimeDetailResponse' || openapi.components.schemas.ModelUptimeDetailResponse?.oneOf?.length !== 2) throw new Error(`${openapiPath} must define daily and 15-minute uptime detail variants`);
  if (adminModelUptime?.$ref !== '#/components/schemas/ModelUptimeResponse' || adminModelUptimeDetail?.$ref !== '#/components/schemas/ModelUptimeDetailResponse') throw new Error(`${openapiPath} must share uptime schemas with administrator endpoints`);
  if (keyUsage?.type !== 'array' || keyUsage.items?.$ref !== '#/components/schemas/ApiKeyDailyUsageItem') throw new Error(`${openapiPath} must define per-key usage responses`);
  for (const field of ['model_id', 'tokens', 'cost', 'requests']) {
    if (!openapi.components.schemas.ApiKeyDailyUsageItem?.properties?.[field]) throw new Error(`${openapiPath} is missing ApiKeyDailyUsageItem.${field}`);
  }
  if (!openapi.components.schemas.ApiKeyDailyUsageItem?.properties?.model_name?.type?.includes('null')) throw new Error(`${openapiPath} must document nullable per-key usage model names`);
  if (keyTags?.type !== 'array' || keyTags.items?.$ref !== '#/components/schemas/UserKeyTag') throw new Error(`${openapiPath} must define user key-tag list responses`);
  if (keyTagCreate?.$ref !== '#/components/schemas/UserKeyTag' || keyTagUpdate?.$ref !== '#/components/schemas/UserKeyTag') throw new Error(`${openapiPath} must define key-tag create/update responses`);
  if (keyMembers?.$ref !== '#/components/schemas/ApiKeyMembersResponse') throw new Error(`${openapiPath} must define Co-Key member list responses`);
  if (!openapi.components.schemas.ApiKeyMembersResponse?.properties?.members?.items?.$ref?.endsWith('/ApiKeyMember')) throw new Error(`${openapiPath} must define Co-Key member fields`);
  if (quotaWarning?.$ref !== '#/components/schemas/ApiKeyQuotaWarning') throw new Error(`${openapiPath} must define quota-warning settings`);
  if (keySchedule?.$ref !== '#/components/schemas/ApiKeySchedule') throw new Error(`${openapiPath} must define API Key schedule settings`);
  if (!openapi.components.schemas.ApiKeySchedule?.properties?.schedule_on_time?.type?.includes('null')) throw new Error(`${openapiPath} must document nullable API Key schedule times`);
  if (currentModel?.$ref !== '#/components/schemas/CurrentModelResponse' || !openapi.components.schemas.CurrentModelResponse?.properties?.currentModel?.anyOf?.some(item => item.type === 'null')) throw new Error(`${openapiPath} must document the nullable current model response`);
  if (usageLogs?.$ref !== '#/components/schemas/UserUsageLogsResponse' || openapi.components.schemas.UserUsageLogsResponse?.properties?.logs?.items?.$ref !== '#/components/schemas/UserUsageLog') throw new Error(`${openapiPath} must define paginated usage-log responses`);
  if (statsFilters?.$ref !== '#/components/schemas/UserStatsFiltersResponse' || !['sources', 'models', 'providers', 'teams'].every(key => openapi.components.schemas.UserStatsFiltersResponse?.properties?.[key]?.type === 'array')) throw new Error(`${openapiPath} must define user stats filter option arrays`);
  const usageLogDetailSchema = openapi.components.schemas.UserUsageLogDetail;
  const usageLogDetailFields = usageLogDetailSchema?.properties || usageLogDetailSchema?.allOf?.find(item => item.properties)?.properties;
  if (usageLogDetail?.$ref !== '#/components/schemas/UserUsageLogDetailResponse' || !usageLogDetailFields?.messages || !usageLogDetailFields?.response) throw new Error(`${openapiPath} must define detailed usage-log opaque payloads`);
  if (!openapi.paths['/api/user/usage-logs/{id}']?.get?.description?.includes('avoid logging or redistributing')) throw new Error(`${openapiPath} must warn about sensitive usage-log detail payloads`);
  if (apiKeyModels?.$ref !== '#/components/schemas/ApiKeyModelsResponse' || openapi.components.schemas.ApiKeyModelsResponse?.properties?.queue?.items?.$ref !== '#/components/schemas/ApiKeyQueueItem') throw new Error(`${openapiPath} must define API Key model queue responses`);
  if (!openapi.components.schemas.ApiKeyQueueItem?.properties?.sort_order || !openapi.components.schemas.ApiKeyModelsResponse?.properties?.models?.items?.$ref?.endsWith('/ApiKeyAvailableModel')) throw new Error(`${openapiPath} must define API Key available models and ordered queue fields`);
  if (apiKeyModelsUpdate?.$ref !== '#/components/schemas/ApiKeyModelsUpdateResponse') throw new Error(`${openapiPath} must define model queue update responses`);
  if (keyTagsUpdate?.$ref !== '#/components/schemas/ApiKeyTagsResponse' || !openapi.components.schemas.ApiKeyTagsResponse?.properties?.tags?.items?.$ref?.endsWith('/ApiKeyTag')) throw new Error(`${openapiPath} must define API Key tag assignment responses`);
  if (apiKeyConfig?.['x-crewrouter-permission'] !== 'keys.secret' || !apiKeyConfig.description?.includes('Owner-only') || !apiKeyConfig.description.includes('never log or expose')) throw new Error(`${openapiPath} must document the API Key secret exposure boundary`);
  if (keyEnabled?.$ref !== '#/components/schemas/ApiKeyEnabledUpdateResponse' || keySwallowImages?.$ref !== '#/components/schemas/ApiKeySwallowImagesUpdateResponse' || keyCommands?.$ref !== '#/components/schemas/ApiKeyCommandsUpdateResponse') throw new Error(`${openapiPath} must define API Key toggle response schemas`);
  if (!openapi.components.schemas.ApiKeyClaudeConfig?.properties?.env?.properties?.ANTHROPIC_AUTH_TOKEN?.description?.includes('never log or expose')) throw new Error(`${openapiPath} must mark the generated API Key token as sensitive`);
  if (fusionConfig?.$ref !== '#/components/schemas/ApiKeyFusionConfig') throw new Error(`${openapiPath} must define API Key Fusion config responses`);
  if (fusionConfigPut?.requestBody?.content?.['application/json']?.schema?.$ref !== '#/components/schemas/ApiKeyFusionConfigPut' || openapi.components.schemas.ApiKeyFusionConfigPut?.properties?.panel_models?.maxItems !== 10) throw new Error(`${openapiPath} must define bounded Fusion model configuration requests`);
  if (harnessModels?.$ref !== '#/components/schemas/ApiKeyHarnessModelsResponse') throw new Error(`${openapiPath} must define API Key harness model responses`);
  if (!openapi.components.schemas.ApiKeyHarnessModelsResponse?.properties?.available_harnesses?.items?.$ref?.endsWith('/AvailableHarness')) throw new Error(`${openapiPath} must define available harness options`);
  if (requestModelBindings?.$ref !== '#/components/schemas/ApiKeyRequestModelBindingsResponse') throw new Error(`${openapiPath} must define request-model binding responses`);
}
const embeddedSdkDocs = await readFile('docs/sdk/embedded-server.md', 'utf8');
for (const required of ['limited preview', 'GA readiness gate', 'release owner approves', 'externally owned pools are never closed']) {
  if (!embeddedSdkDocs.includes(required)) throw new Error(`Embedded SDK release boundary omits ${required}`);
}
const sdkOverview = await readFile('docs/sdk/README.md', 'utf8');
if (!sdkOverview.includes('Limited preview only; not part of the client SDK stable-release commitment')) throw new Error('SDK overview must keep embedded server SDK outside the stable client commitment');
const sdkVersioning = await readFile('docs/sdk/versioning.md', 'utf8');
if (!sdkVersioning.includes('limited preview; excluded from client SDK stable commitment')) throw new Error('SDK version table must keep embedded server SDK in limited preview');
for (const required of ['1.0', 'contractVersion', 'Deprecation', 'support matrix']) {
  if (!sdkVersioning.includes(required)) throw new Error(`SDK versioning policy omits ${required}`);
}
const stable = parse(await readFile(files[0], 'utf8'));
if (!stable.jobs['build-docker'].if?.includes("contains(github.ref, '-beta.')")) throw new Error('Stable workflow is missing prerelease protection');
console.log('release workflow YAML and sequencing contracts passed');
