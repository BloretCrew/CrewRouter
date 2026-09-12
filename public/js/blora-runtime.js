/* Shared runtime bridge for Blora controllers and services. */
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
}

window.CrewBlora = Object.assign(window.CrewBlora || {}, {
  init,
  message,
  destroy(root = document) {
    root.querySelectorAll?.('[data-blora-table-root]').forEach((host) => {
      tableControllers.get(host)?.destroy();
      tableControllers.delete(host);
    });
    root.querySelectorAll?.('form').forEach((form) => {
      formControllers.get(form)?.destroy();
      formControllers.delete(form);
    });
  }
});

document.addEventListener('DOMContentLoaded', () => init());
window.addEventListener('pagehide', () => window.CrewBlora.destroy(), { once: true });
