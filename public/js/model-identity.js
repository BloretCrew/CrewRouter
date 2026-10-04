/* Shared diagnostics for usage records and session calls. */
const ModelIdentity = (() => {
  const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;
  const translate = value => typeof t === 'function' ? t(value) : value;
  function status(record) {
    const resolved = text(record?.resolved_model);
    const response = text(record?.response_model);
    if (!response) return { label: '上游未提供', variant: 'neutral' };
    if (!resolved) return { label: '路由模型未采集，无法比对', variant: 'neutral' };
    return resolved === response
      ? { label: '模型名称一致', variant: 'success' }
      : { label: '模型名称不一致', variant: 'warning' };
  }
  function badge(record, mismatchOnly = false) {
    const state = status(record);
    if (mismatchOnly && state.variant !== 'warning') return '';
    return `<span class="blora-badge model-identity-status" data-variant="${state.variant}">${escape(translate(state.label))}</span>`;
  }
  function fields(record) {
    return [['requested_model', '客户端请求模型', '未采集（历史记录或客户端未提供）'],
      ['resolved_model', '路由模型', '未采集（历史记录或调用未记录）'],
      ['response_model', '上游响应模型', '上游未提供（或历史记录未采集）']].map(([key, label, missing]) =>
      `<div class="model-identity-field"><dt>${escape(translate(label))}</dt><dd>${escape(text(record?.[key]) || translate(missing))}</dd></div>`).join('');
  }
  function summary(record) {
    return `<div class="model-identity-summary"><dl>${fields(record)}</dl>${badge(record, true)}</div>`;
  }
  function detail(record) {
    return `<section class="model-identity-detail" aria-label="${escape(translate('模型身份'))}">${badge(record)}<dl>${fields(record)}</dl><p class="model-identity-note">${escape(translate('上游响应声明的模型，供应商可能改写；名称差异可能来自别名或版本映射。'))}</p></section>`;
  }
  function session(record) {
    const calls = Array.isArray(record?.modelIdentities) && record.modelIdentities.length ? record.modelIdentities : [record];
    const warning = calls.find(call => status(call).variant === 'warning');
    const content = calls.map(call => `${calls.length > 1 ? `<p>${escape(translate('调用'))} #${escape(call.id ?? '—')}</p>` : ''}${detail(call)}`).join('');
    return `<details class="model-identity-session"><summary>${escape(translate('模型身份'))} ${badge(warning || record)}</summary>${content}</details>`;
  }
  return { status, badge, summary, detail, session };
})();
