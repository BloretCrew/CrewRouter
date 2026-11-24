'use strict';

const { overviewPage, servicePage, accountPage } = require('./pages-core');
const { providersPage, modelsPage, keysPage } = require('./pages-resources');
const { usagePage, sessionsPage } = require('./pages-data');
const { createAdminPages } = require('./pages-admin');

const WEB_PAGE_MAP = Object.freeze([
  { area: 'console', web: 'home', cli: 'model-library' },
  { area: 'console', web: 'modelLibrary', cli: 'model-library' },
  { area: 'admin', web: 'adminModelLibrary', cli: 'admin-model-library' },
  { area: 'admin', web: 'adminModels', cli: 'admin-models' },
  { area: 'admin', web: 'adminProviders', cli: 'providers' },
  { area: 'admin', web: 'adminTeams', cli: 'admin-teams' },
  { area: 'console', web: 'myUpstream', cli: 'providers' },
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
  { area: 'admin', web: 'adminUsers', cli: 'admin-users' },
  { area: 'admin', web: 'adminAuditLogs', cli: 'admin-audit-logs' },
  { area: 'admin', web: 'adminErrorLogs', cli: 'admin-error-logs' },
  { area: 'admin', web: 'adminPrompts', cli: 'admin-prompts' },
  { area: 'admin', web: 'adminPolicies', cli: 'admin-policies' },
  { area: 'admin', web: 'policyMembers', cli: 'admin-policy-members' },
  { area: 'admin', web: 'policyApprovals', cli: 'admin-policy-approvals' },
  { area: 'admin', web: 'policyChannels', cli: 'admin-policy-notifications' },
  { area: 'admin', web: 'adminStats', cli: 'admin-stats' },
  { area: 'admin', web: 'adminTeams', cli: 'admin-teams' },
  { area: 'admin', web: 'adminPlugins', cli: 'admin-plugins' },
  { area: 'admin', web: 'adminSettings', cli: 'admin-settings' }
]);

function buildPages(runtime) {
  const adminPages = createAdminPages(runtime);
  const adminById = new Map(adminPages.map(page => [page.id, page]));
  const pages = [
    adminById.get('model-library'),
    providersPage(runtime),
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
    adminById.get('admin-users'),
    adminById.get('admin-policies'),
    adminById.get('admin-policy-members'),
    adminById.get('admin-policy-approvals'),
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
    modelsPage(runtime),
    accountPage(runtime),
    overviewPage(runtime),
    servicePage(runtime),
  ];
  return pages;
}

const navGroups = [
  { id: 'console', label: '控制台', pages: ['model-library', 'providers', 'keys', 'usage', 'projects', 'leaderboard', 'balance', 'audit-logs', 'prompts', 'sessions', 'blora-agent', 'policy-center', 'settings', 'home', 'models', 'account', 'overview'] },
  { id: 'admin', label: '管理后台', pages: ['admin-users', 'admin-policies', 'admin-policy-members', 'admin-policy-approvals', 'admin-policy-notifications', 'admin-model-library', 'admin-models', 'admin-teams', 'admin-stats', 'admin-error-logs', 'admin-audit-logs', 'admin-prompts', 'admin-plugins', 'admin-settings'] },
  { id: 'cli', label: 'CLI 服务', pages: ['service'] },
];

module.exports = { buildPages, WEB_PAGE_MAP, navGroups };
