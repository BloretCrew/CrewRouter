'use strict';

function text(value, fallback = '未知') {
  if (value === null || value === undefined || value === '') return fallback;
  return String(value);
}

function enabledLabel(value) {
  return value === true ? '启用' : value === false ? '停用' : '未知';
}

async function loadParts(api, specs) {
  const settled = await Promise.allSettled(specs.map(spec => api(spec.path, spec.options || {})));
  const values = {};
  const errors = {};
  settled.forEach((result, index) => {
    const spec = specs[index];
    if (result.status === 'fulfilled') values[spec.key] = result.value;
    else {
      if (result.reason && result.reason.statusCode === 401) throw result.reason;
      errors[spec.key] = result.reason && result.reason.message ? result.reason.message : '读取失败';
    }
  });
  return { values, errors };
}

function errorRows(errors, names) {
  return Object.entries(errors).map(([key, message]) => ({
    label: `${names[key] || key}：${message}`,
  }));
}

function bar(value, max, width = 20) {
  const ratio = max > 0 ? Math.max(0, Math.min(1, Number(value) / max)) : 0;
  const filled = Math.round(ratio * width);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
}

module.exports = {
  text,
  enabledLabel,
  loadParts,
  errorRows,
  bar,
};
