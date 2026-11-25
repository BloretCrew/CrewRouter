'use strict';

const { overviewPage, servicePage, accountPage } = require('./pages-core');
const { providersPage, myUpstreamPage, providerTagsPage, modelsPage, keysPage } = require('./pages-resources');
const { usagePage, sessionsPage } = require('./pages-data');
const { createAdminPages } = require('./pages-admin');
const { notificationSettingsPage, securitySettingsPage } = require('./pages-user-settings');

const WEB_PAGE_MAP = Object.freeze([
  { area: 'console', web: 'home', cli: 'model-library', kind: 'redirect' },
  { area: 'console', web: 'modelLibrary', cli: 'model-library', kind: 'navigation' },
  { area: 'admin', web: 'adminModelLibrary', cli: 'admin-model-library' },
  { area: 'admin', web: 'adminModels', cli: 'admin-models' },
  { area: 'admin', web: 'adminProviders', cli: 'providers' },
  { area: 'admin', web: 'providerTags', cli: 'provider-tags', kind: 'tab' },
  { area: 'admin', web: 'adminTeams', cli: 'admin-teams' },
  { area: 'console', web: 'myUpstream', cli: 'my-upstream' },
  { area: 'console', web: 'stats', cli: 'usage' },
  { area: 'console', web: 'apiKeys', cli: 'keys' },

  { area: 'console', web: 'projectWork', cli: 'projects' },
  { area: 'console', web: 'leaderboard', cli: 'leaderboard' },
  { area: 'console', web: 'balance', cli: 'balance' },
  { area: 'console', web: 'auditLogs', cli: 'audit-logs' },
  { area: 'console', web: 'prompts', cli: 'prompts' },
  { area: 'console', web: 'sessions', cli: 'sessions' },
  { area: 'console', web: 'bloraAgent', cli: 'blora-agent' },
  { area: 'console', web: 'policyCenter', cli: 'policy-center' },
  { area: 'console', web: 'settings', cli: 'settings' },
  { area: 'console', web: 'securitySettings', cli: 'security-settings', kind: 'settings-category' },
  { area: 'console', web: 'notificationSettings', cli: 'notification-settings', kind: 'settings-category' },
  { area: 'admin', web: 'adminUsers', cli: 'admin-users' },
  { area: 'admin', web: 'adminAuditLogs', cli: 'admin-audit-logs' },
  { area: 'admin', web: 'adminErrorLogs', cli: 'admin-error-logs' },
  { area: 'admin', web: 'adminPrompts', cli: 'admin-prompts' },
  { area: 'admin', web: 'adminPolicies', cli: 'admin-policies', kind: 'tabbed-page' },
  { area: 'admin', web: 'policySettings', cli: 'admin-policy-settings', kind: 'tab' },
  { area: 'admin', web: 'policyMembers', cli: 'admin-policy-members', kind: 'tab' },
  { area: 'admin', web: 'policyApprovals', cli: 'admin-policy-approvals', kind: 'tab' },
  { area: 'admin', web: 'policyClients', cli: 'admin-policy-clients', kind: 'tab' },
  { area: 'admin', web: 'policyChannels', cli: 'admin-policy-notifications', kind: 'tab' },
  { area: 'admin', web: 'adminStats', cli: 'admin-stats' },
  { area: 'admin', web: 'adminTeams', cli: 'admin-teams' },
  { area: 'admin', web: 'adminPlugins', cli: 'admin-plugins' },
  { area: 'admin', web: 'oauthClients', cli: 'admin-oauth-clients', kind: 'settings-category' },
  { area: 'admin', web: 'popupNotices', cli: 'admin-popups', kind: 'settings-category' },
  { area: 'admin', web: 'dataRetention', cli: 'admin-retention', kind: 'settings-category' },
  { area: 'admin', web: 'updateSettings', cli: 'admin-updates', kind: 'settings-category' },
  { area: 'admin', web: 'authInvites', cli: 'admin-invites', kind: 'settings-category' },
  { area: 'admin', web: 'adminSettings', cli: 'admin-settings' }
]);

function buildPages(runtime) {
  const adminPages = createAdminPages(runtime);
  const adminById = new Map(adminPages.map(page => [page.id, page]));
  const pages = [
    adminById.get('model-library'),
    myUpstreamPage(runtime),
    providersPage(runtime),
    providerTagsPage(runtime),
    keysPage(runtime),
    usagePage(runtime),
    adminById.get('projects'),
    adminById.get('leaderboard'),
    adminById.get('balance'),
    adminById.get('audit-logs'),
    adminById.get('prompts'),
    sessionsPage(runtime),
    adminById.get('blora-agent'),
    adminById.get('policy-center'),
    adminById.get('settings'),
    notificationSettingsPage(runtime),
    securitySettingsPage(runtime),
    adminById.get('admin-users'),
    adminById.get('admin-policies'),
    adminById.get('admin-policy-settings'),
    adminById.get('admin-policy-members'),
    adminById.get('admin-policy-approvals'),
    adminById.get('admin-policy-clients'),
    adminById.get('admin-policy-notifications'),
    adminById.get('admin-model-library'),
    adminById.get('admin-models'),
    adminById.get('admin-teams'),
    adminById.get('admin-stats'),
    adminById.get('admin-error-logs'),
    adminById.get('admin-audit-logs'),
    adminById.get('admin-prompts'),
    adminById.get('admin-plugins'),
    adminById.get('admin-settings'),
    adminById.get('admin-oauth-clients'),
    adminById.get('admin-invites'),
    adminById.get('admin-updates'),
    adminById.get('admin-popups'),
    adminById.get('admin-retention'),
    modelsPage(runtime),
    accountPage(runtime),
    overviewPage(runtime),
    servicePage(runtime),
  ];
  return pages;
}

const navGroups = [
  { id: 'console', label: '控制台', pages: ['model-library', 'my-upstream', 'keys', 'usage', 'projects', 'leaderboard', 'balance', 'audit-logs', 'prompts', 'sessions', 'blora-agent', 'policy-center', 'settings', 'notification-settings'] },
  { id: 'admin', label: '管理后台', pages: ['admin-users', 'admin-policies', 'admin-model-library', 'admin-stats', 'admin-error-logs', 'admin-audit-logs', 'admin-prompts', 'admin-plugins', 'admin-settings'] },
  { id: 'admin-subpages', label: '管理子页面', pages: ['admin-policy-settings', 'admin-policy-members', 'admin-policy-approvals', 'admin-policy-clients', 'admin-policy-notifications', 'admin-models', 'admin-teams', 'admin-oauth-clients', 'admin-popups', 'admin-retention', 'admin-invites', 'admin-updates'] },
  { id: 'tools', label: '终端工具', pages: ['providers', 'provider-tags', 'models', 'account', 'overview', 'security-settings'] },
  { id: 'cli', label: 'CLI 服务', pages: ['service'] },
];

const navAreas = [
  { id: 'console', label: '控制台', groups: ['console', 'tools', 'cli'] },
  { id: 'admin', label: '管理后台', groups: ['admin', 'admin-subpages'], adminOnly: true },
];

module.exports = { buildPages, WEB_PAGE_MAP, navGroups, navAreas };
