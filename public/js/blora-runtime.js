/* Shared runtime bridge for Blora controllers, dropdowns and services. */
import { createTableController } from '/blora/components/table/index.js?v=2.0.8';
import { createFormController } from '/blora/components/form/index.js?v=2.0.8';
import { message } from '/blora/components/message/index.js?v=2.0.8';

const tableControllers = new WeakMap();
const formControllers = new WeakMap();

function initTables(root = document) {
  root.querySelectorAll?.('table').forEach((table) => {
    const host = table.closest('.blora-table-wrap, [data-blora-table-root]') || table.parentElement || table;
    host.classList.add('blora-table-wrap');
    host.dataset.bloraTableRoot = 'true';
    table.classList.add('blora-table');
    if (!tableControllers.has(host)) tableControllers.set(host, createTableController(host));
  });
}

function initForms(root = document) {
  root.querySelectorAll?.('form').forEach((form) => {
    if (!formControllers.has(form)) formControllers.set(form, createFormController(form));
  });
}

function init(root = document) {
  initTables(root);
  initForms(root);
  root.querySelectorAll?.('blora-dropdown').forEach((dropdown) => {
    if (dropdown.dataset.runtimeBound) return;
    dropdown.dataset.runtimeBound = 'true';
    dropdown.addEventListener('blora-select', (event) => {
      const value = event.detail?.value;
      const app = window.app;
      const admin = window.adminApp;
      if (dropdown.id === 'batchDropdownMenu') {
        ({ enable: () => admin?.batchUpdateModels(true), disable: () => admin?.batchUpdateModels(false), 'set-prices': () => admin?.showBatchSetPricesModal(), 'adjust-prices': () => admin?.showBatchAdjustPricesModal(), 'adjust-reference': () => admin?.showBatchAdjustByRefModal(), 'rate-limit': () => admin?.showBatchSetRateLimitModal(), description: () => admin?.showBatchEditDescModal(), series: () => admin?.showBatchSetSeriesModal(), delete: () => admin?.batchDeleteModels() }[value])?.();
      } else if (dropdown.id === 'adminTestDropdown') {
        if (value === 'filtered') admin?.testAllFilteredModels();
        if (value === 'selected') admin?.testSelectedModels();
      } else if (dropdown.id === 'libraryMoreDropdown') {
        ({ 'expand-teams': () => app?.expandAllTeams(), 'collapse-teams': () => app?.collapseAllTeams(), 'expand-providers': () => app?.expandAllProviders(), 'collapse-providers': () => app?.collapseAllProviders(), 'test-all': () => app?.testAllModels(), 'test-team': () => app?.testAllCurrentTeamModels(), 'test-provider': () => app?.testAllCurrentProviderModels(), 'ping-providers': () => app?.pingAllLibraryProviders(), hidden: () => app?.toggleLibraryShowHidden(), 'clear-hidden': () => app?.clearLibraryHidden(), reorder: () => app?.toggleLibraryReorderMode(), 'reset-order': () => app?.resetLibraryOrder() }[value])?.();
      }
    });
  });
}

window.CrewBlora = Object.assign(window.CrewBlora || {}, { init, message, destroy(root = document) {
  root.querySelectorAll?.('[data-blora-table-root]').forEach((host) => { tableControllers.get(host)?.destroy(); tableControllers.delete(host); });
  root.querySelectorAll?.('form').forEach((form) => { formControllers.get(form)?.destroy(); formControllers.delete(form); });
}});

document.addEventListener('DOMContentLoaded', () => init());
window.addEventListener('pagehide', () => window.CrewBlora.destroy(), { once: true });
