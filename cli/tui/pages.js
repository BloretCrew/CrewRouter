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
  { area: 'console', web: 'policyCenter', cli: 'admin-policies' },
  { area: 'console', web: 'settings', cli: 'settings' },
  { area: 'admin', web: 'adminUsers', cli: 'admin-users' },
  { area: 'admin', web: 'adminAuditLogs', cli: 'admin-audit-logs' },
  { area: 'admin', web: 'adminErrorLogs', cli: 'admin-error-logs' },
  { area: 'admin', web: 'adminPrompts', cli: 'admin-prompts' },
  { area: 'admin', web: 'adminPolicies', cli: 'admin-policies' },
  { area: 'admin', web: 'adminStats', cli: 'admin-stats' },
  { area: 'admin', web: 'adminTeams', cli: 'admin-teams' },
  { area: 'admin', web: 'adminPlugins', cli: 'admin-plugins' },
  { area: 'admin', web: 'adminSettings', cli: 'admin-settings' }
]);

function buildPages(runtime) {
  const adminPages = createAdminPages(runtime);
  const adminById = new Map(adminPages.map(page => [page.id, page]));
  const pages = [
    adminById.get('home'),
    overviewPage(runtime),
    modelsPage(runtime),
    adminById.get('model-library'),
    adminById.get('admin-model-library'),
    adminById.get('admin-models'),
    providersPage(runtime),

    keysPage(runtime),
    usagePage(runtime),
    adminById.get('projects'),
    adminById.get('leaderboard'),
    adminById.get('balance'),
    adminById.get('audit-logs'),
    sessionsPage(runtime),
    adminById.get('blora-agent'),
    adminById.get('admin-policies'),
    accountPage(runtime),
    adminById.get('admin-users'),
    adminById.get('admin-stats'),
    adminById.get('admin-error-logs'),
    adminById.get('admin-audit-logs'),
    adminById.get('admin-prompts'),
    adminById.get('prompts'),
    adminById.get('admin-plugins'),
    adminById.get('admin-teams'),
    adminById.get('admin-settings'),
    adminById.get('settings'),
    servicePage(runtime),
  ];
  return pages;
}

const navGroups = [
  { id: 'console', label: '控制台', pages: ['home', 'overview', 'models', 'model-library', 'providers', 'keys', 'usage', 'projects', 'leaderboard', 'balance', 'audit-logs', 'prompts', 'sessions', 'blora-agent', 'admin-policies', 'account', 'settings'] },
  { id: 'admin', label: '管理后台', pages: ['admin-users', 'admin-policies', 'admin-model-library', 'admin-models', 'admin-stats', 'admin-error-logs', 'admin-audit-logs', 'admin-prompts', 'admin-plugins', 'admin-teams', 'admin-settings'] },
  { id: 'cli', label: 'CLI 服务', pages: ['service'] },
];

module.exports = { buildPages, WEB_PAGE_MAP, navGroups };
