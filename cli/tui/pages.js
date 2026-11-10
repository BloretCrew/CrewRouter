'use strict';

const { overviewPage, servicePage, accountPage } = require('./pages-core');
const { providersPage, modelsPage, keysPage } = require('./pages-resources');
const { usagePage, sessionsPage } = require('./pages-data');

function buildPages(runtime) {
  return [
    overviewPage(runtime),
    servicePage(runtime),
    providersPage(runtime),
    modelsPage(runtime),
    keysPage(runtime),
    usagePage(runtime),
    sessionsPage(runtime),
    accountPage(runtime),
  ];
}

module.exports = { buildPages };
