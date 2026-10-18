const API = '/api/user/model-trace';
const tr = (text) => window.t ? window.t(text) : text;
const esc = (value) => window.escapeHtml(String(value ?? ''));
const put = (node, content) => window.setHTML(node, content);
const active = (job) => ['pending', 'running'].includes(job.status);
const states = { pending: '等待执行', running: '正在检测模型指纹', completed: '检测完成', partial: '部分有效', failed: '检测失败', canceled: '已取消', interrupted: '执行中断' };
const notice = '指纹归因（实验性）：候选库外模型也会归入已有候选；系统提示词、采集环境及配置变化可能影响结果。候选库内概率不代表真实身份认证，不用于认定模型造假。';
const button = (action, label, attrs = '') => `<button type="button" class="blora-button" data-variant="secondary" data-size="sm" data-trace-action="${action}" ${attrs}>${esc(tr(label))}</button>`;
let jobs = new Map();
let dismissed = new Set();
try {
  dismissed = new Set(JSON.parse(localStorage.getItem('modelTraceDismissed') || '[]'));
  // Migrate dismissals made before they were persisted across browser sessions.
  const legacy = JSON.parse(sessionStorage.getItem('modelTraceDismissed') || '[]');
  legacy.forEach(id => dismissed.add(String(id)));
  localStorage.setItem('modelTraceDismissed', JSON.stringify([...dismissed]));
  sessionStorage.removeItem('modelTraceDismissed');
} catch (_) { /* Storage may be unavailable. */ }
let timer, syncPromise, syncError = '', dialog, dialogState, epoch = 0, targets = [], bankSummary;
let pageNumber = 1, historyEpoch = 0, challenges = [], manualDirty = false, pageInitialized = false;

async function request(path, body) {
  const headers = {};
  if (body !== undefined) {
    const csrfResponse = await fetch('/api/csrf-token', { credentials: 'same-origin' });
    if (!csrfResponse.ok) throw new Error(tr('无法读取安全令牌，请重试'));
    const csrf = await csrfResponse.json();
    if (csrf.token) headers['X-CSRF-Token'] = csrf.token;
    headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(`${API}${path}`, { credentials: 'same-origin', headers, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || data.error || data.message || `HTTP ${response.status}`);
  return data;
}
const unwrap = (data) => data.job || data;
const listOf = (data) => data.jobs || data.items || [];
const targetId = (target) => String(target.model_id ?? target.id ?? '');
const jobTarget = (job) => job.target || job.target_snapshot || {};
function label(job) {
  const target = jobTarget(job);
  return [target.model_name || target.model_id, target.provider_name, target.key_label].filter(Boolean).join(' · ');
}
function ranking(result) {
  if (!result) return [];
  const values = result.results || result.model_ranking || result.models || result.ranking || result.candidates || result.model_probabilities || [];
  return Array.isArray(values) ? values : Object.entries(values).map(([name, probability]) => ({ name, probability }));
}
function best(job) {
  const first = ranking(job.result)[0];
  return first ? (first.display_name || first.model || first.model_name || first.name || first.label || '') : '';
}
function usage(job) {
  return `${tr('有效挑战')} ${Number(job.valid_outputs) || 0}/3 · ${tr('已尝试')} ${Number(job.attempted) || 0}/3 · ${tr('已知用量')} ${Number(job.total_tokens) || 0} token · ${tr('费用')} ${job.cost == null ? tr('未知') : String(job.cost)}${job.usage_unknown ? ` · ${tr('部分用量未知，不能视为零费用')}` : ''}`;
}
function resultHTML(result, valid) {
  if (!result) return `<p>${esc(tr('暂无归因结果'))}</p>`;
  const versionOf = (value) => typeof value === 'string' ? value : value?.bank_hash || value?.algorithm_version || value?.source_commit;
  const version = versionOf(result.bank_version) || versionOf(result.version) || versionOf(result.metadata) || versionOf(bankSummary?.bank_version) || versionOf(bankSummary?.version) || versionOf(bankSummary);
  const models = ranking(result);
  const families = result.family_ranking || result.families || result.family_probabilities || [];
  const familyRows = Array.isArray(families) ? families : Object.entries(families).map(([name, probability]) => ({ name, probability }));
  const row = (entry) => {
    const probability = entry.probability ?? entry.prob;
    const p = probability == null ? NaN : Number(probability);
    const similarity = entry.profile_similarity ?? entry.similarity ?? entry.distribution_similarity;
    return `<li><strong>${esc(entry.display_name || entry.model || entry.model_name || entry.family || entry.name || entry.label)}</strong><span>${Number.isFinite(p) ? `${(p * 100).toFixed(2)}%` : '—'}${similarity == null ? '' : ` · ${esc(tr('分布相似度'))} ${Number.isFinite(Number(similarity)) ? `${(Number(similarity) * 100).toFixed(2)}%` : '—'}`}</span></li>`;
  };
  return `<div class="trace-result">${result.evidence?.reason ? `<p class="trace-notice">${esc(tr(result.evidence.reason))}</p>` : ''}<p>${esc(tr('候选库内概率'))} · ${esc(tr('有效挑战'))} ${Number(valid) || 0}/3${Number(valid) < 3 ? ` · ${esc(tr('有效回答不足三份，仅提供未校准排名'))}` : ''}</p>${familyRows.length ? `<h4>${esc(tr('家族归因'))}</h4><ol>${familyRows.map(row).join('')}</ol>` : ''}<h4>${esc(tr('候选模型排行'))}</h4><ol>${models.map(row).join('') || `<li>${esc(tr('暂无候选数据'))}</li>`}</ol><p>${esc(tr('指纹库版本'))}：${esc(version || '—')}</p></div>`;
}
function taskHTML(job) {
  const result = job.result;
  const first = ranking(result)[0];
  const values = result?.family_probabilities || result?.family_ranking || result?.families || [];
  const families = Array.isArray(values) ? values : Object.entries(values).map(([family, probability]) => ({ family, probability }));
  const family = families.reduce((best, entry) => !best || Number(entry.probability) > Number(best.probability) ? entry : best, null);
  const percent = (value) => value != null && Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(2)}%` : '—';
  const familyName = result?.family_prediction_name || family?.display_name || family?.name || family?.family || result?.family_prediction;
  const attribution = result ? `<p>${esc(tr('家族归因'))}：${esc(familyName || '—')} · ${percent(result.family_probability ?? family?.probability)}<br>${esc(tr('最近候选'))}：${esc(best(job) || result.prediction_name || result.prediction || '—')} · ${percent(first?.probability ?? result.probability)} (${esc(tr('候选库内概率'))})</p>` : '';
  return `<article class="blora-card trace-task" data-variant="flat"><div><strong>${esc(tr(states[job.status] || job.status))}</strong><p>${esc(label(job))}</p><small>${esc(usage(job))}</small>${attribution}</div><div class="trace-actions">${button('view', active(job) ? '查看进度' : '查看结果', `data-job-id="${esc(job.id)}"`)}${active(job) ? button('cancel', '取消检测', `data-job-id="${esc(job.id)}"`) : button('dismiss', '关闭通知', `data-job-id="${esc(job.id)}"`)}</div></article>`;
}
function updateBar() {
  const root = document.getElementById('modelTraceTaskBar');
  if (root) {
    put(root, `${syncError ? `<div class="trace-error" role="status">${esc(tr('状态暂不可用'))}：${esc(syncError)} ${button('sync', '重新查询')}</div>` : ''}${[...jobs.values()].filter(job => active(job) || !dismissed.has(String(job.id))).map(taskHTML).join('')}`);
    root.hidden = !root.childElementCount;
    const parent = document.getElementById('modelLibraryTaskBar');
    if (parent) parent.style.display = (root.childElementCount || document.getElementById('sessionSummaryTaskBar')?.childElementCount) ? '' : 'none';
  }
  updateLatest();
}
function updateLatest() {
  document.querySelectorAll('[data-trace-latest]').forEach(node => {
    const match = [...jobs.values()].filter(job => String(jobTarget(job).model_id) === node.dataset.traceLatest && job.result).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
    const text = match ? `${tr('最近归因')}：${best(match)} · ${jobTarget(match).key_label || ''} · ${tr('历史结果对应检测时配置')}` : '';
    if (node.textContent !== text) node.textContent = text;
  });
}
function storeJob(job) {
  if (!job?.id) return;
  const previous = jobs.get(String(job.id));
  if (previous && !active(previous) && active(job)) return;
  jobs.set(String(job.id), job);
}
function remember(job) {
  if (!job?.id) return;
  storeJob(job);
  job = jobs.get(String(job.id));
  updateBar();
  if (dialogState?.jobId === String(job.id)) renderJob(job);
}
function schedule() {
  clearTimeout(timer);
  if (!syncError) timer = setTimeout(() => sync(), document.hidden ? 30000 : [...jobs.values()].some(active) ? 4000 : 30000);
}
async function sync() {
  if (syncPromise) return syncPromise;
  syncPromise = (async () => {
    try {
      const data = await request('/jobs?page=1&limit=20&page_size=20');
      listOf(data).forEach(storeJob);
      const ids = new Set([...jobs.values()].filter(active).map(job => String(job.id)));
      if (dialogState?.jobId) ids.add(dialogState.jobId);
      await Promise.all([...ids].map(async id => { const job = unwrap(await request(`/jobs/${encodeURIComponent(id)}`)); remember(job); }));
      syncError = '';
    } catch (error) { syncError = error.message; }
    finally { updateBar(); syncPromise = null; schedule(); }
  })();
  return syncPromise;
}
function notifyParent() {
  if (window.parent !== window) window.parent.postMessage({ type: 'crewrouter:model-trace-updated' }, location.origin);
}
function makeDialog() {
  epoch++;
  dialog?.remove();
  dialog = document.createElement('blora-dialog');
  dialog.style.setProperty('--blora-dialog-max-width', '760px');
  dialog.setAttribute('close-on-outside-click', 'true');
  const title = document.createElement('span');
  title.slot = 'title'; title.textContent = tr('模型归因');
  const body = document.createElement('div'); body.className = 'trace-dialog';
  dialog.append(title, body);
  const currentDialog = dialog;
  dialog.addEventListener('blora-close', () => {
    if (dialogState?.node === currentDialog) { dialogState = null; epoch++; }
    currentDialog.remove();
    if (dialog === currentDialog) dialog = null;
  });
  document.body.append(dialog);
  dialogState = { node: dialog, body, epoch };
  dialog.show();
  return dialogState;
}
async function loadTargets() {
  const data = await request('/targets');
  targets = data.targets || data.models || [];
  targets = targets.map(target => ({ ...target, keys: target.keys || target.provider_keys || data.keys?.filter(key => String(key.provider_id) === String(target.provider_id)) || [] }));
  return targets;
}
function renderSelection(state, modelId, providerId, parentJobId) {
  const choices = targets.filter(target => !providerId || String(target.provider_id) === String(providerId));
  const selected = choices.find(target => targetId(target) === String(modelId)) || choices[0];
  state.parentJobId = parentJobId;
  state.choices = choices;
  put(state.body, `<p class="trace-notice">${esc(tr(notice))}</p><p>${esc(tr('供应商直连诊断，不等同于客户端路由、Fusion 或插件链路。'))}</p><label>${esc(tr('目标模型'))}<select class="blora-input trace-select" data-trace-model>${choices.map(target => `<option value="${esc(targetId(target))}" ${target === selected ? 'selected' : ''}>${esc(target.model_name || target.name)} · ${esc(target.provider_name)}</option>`).join('')}</select></label><label>${esc(tr('脱敏 Key'))}<select class="blora-input trace-select" data-trace-key></select></label><p class="trace-notice">${esc(tr('仅手动启动。默认最多 3 次独立挑战请求，会消耗积分和上游额度；无自动重试。关闭对话框后后台继续，补测将创建新任务并再次确认费用。'))}</p><p>${esc(tr('输出上限与超时由服务端固定预算控制；实际费用按供应商价格和返回用量结算，用量缺失时标注未知。'))}</p><p data-trace-budget class="trace-notice"></p><div data-trace-error role="alert"></div><div class="trace-actions">${button('start', parentJobId ? '确认补测并创建新任务' : '确认费用并开始检测')}${button('close', '关闭')}</div>`);
  state.body.querySelector('[data-trace-model]').addEventListener('change', () => updateKeys(state));
  updateKeys(state);
}
function updateKeys(state) {
  const target = state.choices.find(item => targetId(item) === state.body.querySelector('[data-trace-model]').value);
  const keys = (target?.keys || []).filter(key => key.enabled !== false && key.is_enabled !== false);
  put(state.body.querySelector('[data-trace-key]'), keys.map(key => `<option value="${esc(key.key_id ?? key.id)}">${esc(key.key_label || key.label || key.masked_key || key.name || tr('已授权 Key'))}</option>`).join(''));
  state.body.querySelector('[data-trace-action="start"]').disabled = !keys.length;
  state.body.querySelector('[data-trace-error]').textContent = !target ? tr('没有可用的授权模型') : !keys.length ? tr('此模型没有可用的授权 Key') : '';
  state.idempotencyKey = null;
  const budget = state.body.querySelector('[data-trace-budget]');
  if (budget) budget.textContent = target ? `${tr('请求预算')} ${target.budget || 3} · ${tr('每次输出上限')} ${target.max_output_tokens ?? '—'} token · ${tr('超时')} ${target.timeout_ms == null ? '—' : Number(target.timeout_ms) / 1000 + 's'} · ${tr('每次积分估算上限')} ${target.estimated_max_points_per_probe == null ? tr('未知') : Number(target.estimated_max_points_per_probe).toFixed(6)} · ${tr('三次积分估算上限')} ${target.estimated_max_points_per_probe == null ? tr('未知') : (Number(target.estimated_max_points_per_probe) * 3).toFixed(6)} (${tr('以输入和输出 token 上限估算，实际用量结算')})` : '';
}
async function open(modelId, options = {}) {
  const state = makeDialog();
  put(state.body, `<p>${esc(tr('正在加载授权目标…'))}</p>`);
  try {
    await loadTargets();
    if (dialogState !== state) return;
    if (modelId && !targets.some(target => targetId(target) === String(modelId))) throw new Error(tr('目标已不可用或无访问权限'));
    renderSelection(state, modelId, options.providerId, options.parentJobId);
  } catch (error) { if (dialogState === state) put(state.body, `<p class="trace-error">${esc(error.message)}</p>${button('close', '关闭')}`); }
}
async function start(state) {
  if (state.submitting || state.jobId) return;
  const modelId = state.body.querySelector('[data-trace-model]').value;
  const keyId = state.body.querySelector('[data-trace-key]').value;
  if (!modelId || !keyId) return;
  const confirmed = await Dialog.confirm(tr('确认模型归因'), tr('此操作最多发送 3 次真实挑战请求，并消耗积分及上游额度。补测也是独立付费任务。是否继续？'));
  if (!confirmed || dialogState !== state || state.submitting) return;
  if (state.body.querySelector('[data-trace-model]').value !== modelId || state.body.querySelector('[data-trace-key]').value !== keyId) return;
  state.submitting = true;
  state.idempotencyKey ||= crypto.randomUUID();
  const controls = [...state.body.querySelectorAll('select, [data-trace-action="start"]')];
  controls.forEach(node => { node.disabled = true; });
  try {
    const job = unwrap(await request('/jobs', { model_id: modelId, key_id: keyId, idempotency_key: state.idempotencyKey, ...(state.parentJobId ? { parent_job_id: state.parentJobId } : {}) }));
    if (dialogState === state) state.jobId = String(job.id);
    remember(job); notifyParent(); syncError = ''; schedule();
  } catch (error) {
    if (dialogState === state) state.body.querySelector('[data-trace-error]').textContent = `${error.message} · ${tr('未自动重发；再次确认使用同一幂等标识查询创建结果。')}`;
  } finally {
    state.submitting = false;
    if (dialogState === state && !state.jobId) controls.forEach(node => { node.disabled = false; });
  }
}
function renderJob(job) {
  const state = dialogState;
  if (!state || state.jobId !== String(job.id)) return;
  put(state.body, `<p class="trace-notice">${esc(tr(notice))}</p><h3>${esc(label(job))}</h3><p><strong>${esc(tr(states[job.status] || job.status))}</strong> · ${esc(job.created_at)}</p><p>${esc(usage(job))}</p>${active(job) ? `<progress max="3" value="${Math.min(3, Number(job.attempted) || 0)}"></progress><p>${esc(tr('关闭只隐藏对话框，后台继续执行。取消可停止后续挑战，但远端是否停止推理由上游决定。'))}</p>` : resultHTML(job.result ? { ...job.result, bank_version: job.version || job.result.bank_version } : null, job.valid_outputs)}<ul class="trace-probes">${(job.probes || []).map((probe, index) => `<li>${index + 1}. ${esc(probe.status || '')} · ${esc(tr('有效数字'))} ${esc(probe.valid_numbers ?? probe.number_count ?? probe.numbers_count ?? '—')}${probe.error ? ` · ${esc(typeof probe.error === 'object' ? probe.error.message : probe.error)}` : ''}</li>`).join('')}</ul>${job.error ? `<p class="trace-error">${esc(typeof job.error === 'object' ? job.error.message : job.error)}</p>` : ''}<div class="trace-actions">${button('refresh-job', '刷新状态', `data-job-id="${esc(job.id)}"`)}${active(job) ? button('cancel', '取消检测', `data-job-id="${esc(job.id)}"`) : button('retest', '补测（新任务）', `data-job-id="${esc(job.id)}"`)}${button('close', '关闭')}</div><div data-trace-error role="alert"></div>`);
}
async function view(id) {
  const state = makeDialog(); state.jobId = String(id);
  put(state.body, `<p>${esc(tr('正在读取任务…'))}</p>`);
  try { const job = unwrap(await request(`/jobs/${encodeURIComponent(id)}`)); remember(job); }
  catch (error) { if (dialogState === state) put(state.body, `<p class="trace-error">${esc(error.message)}</p>${button('refresh-job', '重新查询', `data-job-id="${esc(id)}"`)}${button('close', '关闭')}`); }
}
async function cancel(id) {
  const state = dialogState;
  if (!await Dialog.confirm(tr('取消检测'), tr('取消将停止后续挑战并尝试中止传输，但无法保证上游停止推理。已发生的费用仍会结算。'))) return;
  const job = unwrap(await request(`/jobs/${encodeURIComponent(id)}/cancel`, {}));
  remember(job);
  if (dialogState === state) renderJob(job);
  notifyParent(); schedule();
}
async function history(page = pageNumber) {
  const root = document.getElementById('modelTraceHistory');
  if (!root) return;
  pageNumber = Math.max(1, page); const seq = ++historyEpoch;
  put(root, `<p>${esc(tr('正在加载历史…'))}</p>`);
  try {
    const data = await request(`/jobs?page=${pageNumber}&limit=10&page_size=10`);
    if (seq !== historyEpoch) return;
    const allRows = listOf(data);
    const rows = allRows.filter(job => !dismissed.has(String(job.id))); rows.forEach(storeJob); updateBar();
    const more = data.has_more ?? data.hasMore ?? (data.total != null ? pageNumber * 10 < Number(data.total) : allRows.length === 10);
    put(root, `${rows.map(taskHTML).join('') || `<p>${esc(tr('暂无检测历史。打开目标不会自动创建任务。'))}</p>`}<div class="trace-actions">${button('previous', '上一页', pageNumber === 1 ? 'disabled' : '')}<span>${pageNumber}</span>${button('next', '下一页', more ? '' : 'disabled')}${button('history', '刷新历史')}</div>`);
  } catch (error) { if (seq === historyEpoch) put(root, `<p class="trace-error">${esc(error.message)}</p>${button('history', '重新查询')}`); }
}
async function core() {
  const [fingerprint, generator, response, metadataResponse, detectorResponse] = await Promise.all([import('/vendor/modeltrace/fingerprint-core.mjs'), import('/vendor/modeltrace/challenge-browser.mjs'), fetch('/vendor/modeltrace/data/unified_bank.json', { credentials: 'same-origin' }), fetch('/vendor/modeltrace/metadata.json', { credentials: 'same-origin' }), fetch('/vendor/modeltrace/data/shared_detector.bin', { credentials: 'same-origin' })]);
  if (!response.ok || !metadataResponse.ok || !detectorResponse.ok) throw new Error(tr('指纹库加载失败'));
  const bankText = await response.text();
  const bank = fingerprint.parseBankJson(bankText);
  const metadataText = await metadataResponse.text();
  if (metadataText.length > 16384) throw new Error(tr('无效指纹库版本信息'));
  const metadata = JSON.parse(metadataText);
  if (metadata.schema !== 'crewrouter-modeltrace-metadata-v1' || typeof metadata.algorithm_version !== 'string' || !metadata.algorithm_version || metadata.algorithm_version.length > 256 || !/^[a-f0-9]{40}$/.test(metadata.source_commit || '') || !/^[a-f0-9]{64}$/.test(metadata.bank_hash || '')) throw new Error(tr('无效指纹库版本信息'));
  const detectorBytes = new Uint8Array(await detectorResponse.arrayBuffer());
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', detectorBytes)), byte => byte.toString(16).padStart(2, '0')).join('');
  const bankDigest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(bankText))), byte => byte.toString(16).padStart(2, '0')).join('');
  if (digest !== metadata.detector_hash || bankDigest !== metadata.bank_hash) throw new Error(tr('指纹库校验失败'));
  fingerprint.attachDetector(bank, detectorBytes);
  return { ...fingerprint, ...generator, bank, metadata };
}
let corePromise;
async function generate() {
  if (manualDirty && !await Dialog.confirm(tr('重新生成挑战'), tr('这会清空已粘贴的回答，是否继续？'))) return;
  const root = document.getElementById('modelTraceChallenges');
  try {
    const library = await (corePromise ||= core().catch(error => { corePromise = null; throw error; }));
    challenges = library.generateChallenges();
    if (!Array.isArray(challenges)) challenges = challenges.challenges || [];
    put(root, challenges.slice(0, 3).map((challenge, index) => `<section class="blora-card trace-challenge" data-variant="flat"><h3>${esc(tr('挑战'))} ${index + 1} · ${esc(tr('目标数字数量'))} ${esc(challenge.expected_count ?? challenge.target_count ?? challenge.count ?? '—')}</h3><pre>${esc(challenge.prompt || challenge.text || challenge)}</pre>${button('copy', '复制挑战', `data-index="${index}"`)}<label>${esc(tr('完整回答'))}<textarea class="blora-textarea" data-trace-answer="${index}" maxlength="65536" rows="6" placeholder="${esc(tr('粘贴模型的完整原始回答，支持代码块与文字'))}"></textarea></label><small data-trace-count="${index}"></small></section>`).join(''));
    manualDirty = false;
    put(document.getElementById('modelTraceManualResult'), '');
  } catch (error) { put(root, `<p class="trace-error">${esc(error.message)}</p>${button('generate', '重新生成挑战')}`); }
}
async function analyze() {
  const root = document.getElementById('modelTraceManualResult');
  try {
    const library = await (corePromise ||= core().catch(error => { corePromise = null; throw error; }));
    const outputs = [...document.querySelectorAll('[data-trace-answer]')].map(node => node.value);
    if (outputs.some(text => text.length > 65536)) throw new Error(tr('单份回答不得超过 65536 字符'));
    if (!outputs.some(text => text.trim())) throw new Error(tr('请先粘贴至少一份完整回答'));
    const parsed = outputs.map(text => library.parseNumbers(text));
    const expected = challenges.map(item => item.expected_count ?? item.target_count ?? item.count ?? 200);
    const valid = parsed.filter((numbers, index) => numbers.length >= Math.max(80, Math.ceil(expected[index] * 0.55))).length;
    document.querySelectorAll('[data-trace-count]').forEach((node, index) => { node.textContent = `${tr('有效数字')} ${parsed[index].length} · ${tr('最低有效阈值')} ${Math.max(80, Math.ceil(expected[index] * 0.55))}`; });
    if (!valid) throw new Error(tr('没有有效回答：请检查拒答、截断或数字数量不足，并粘贴完整输出。'));
    const result = library.analyzeGlobalOutputs(outputs.map((text, index) => ({ text, expected_count: expected[index] })), library.bank);
    put(root, resultHTML({ ...result, bank_version: library.metadata.bank_hash || library.metadata.algorithm_version }, valid));
  } catch (error) { put(root, `<p class="trace-error" role="alert">${esc(error.message)}</p>`); }
}
async function page() {
  const root = document.getElementById('modelTraceContent');
  if (!root) return;
  if (!pageInitialized) {
    pageInitialized = true;
    put(root, `<p class="trace-notice">${esc(tr(notice))}</p><div class="trace-actions">${button('open', '自动检测（手动启动）')}${button('generate', '生成三条挑战')}${button('analyze', '本地计算归因')}</div><p>${esc(tr('手动回答只在本机计算，不上传、不持久化。将挑战发送给外部模型时仍会消耗对应额度。'))}</p><div id="modelTraceBank"></div><div id="modelTraceChallenges" class="trace-challenges"></div><div id="modelTraceManualResult" aria-live="polite"></div><h2>${esc(tr('检测历史'))}</h2><div id="modelTraceHistory"></div>`);
  }
  history(1);
  try {
    bankSummary = await request('/bank');
    const summary = bankSummary;
    const readable = (value) => value == null ? '—' : typeof value === 'object' ? Object.entries(value).map(([key, item]) => `${key}: ${typeof item === 'object' ? JSON.stringify(item) : item}`).join('\n') : String(value);
    put(document.getElementById('modelTraceBank'), `<p>${esc(tr('候选覆盖范围'))}：${esc(summary.model_count ?? summary.candidate_count ?? summary.candidates?.length ?? (Array.isArray(summary.models) ? summary.models.length : '—'))} · ${esc(tr('指纹库版本'))}：${esc(summary.bank_version || summary.version || summary.bank_hash || '—')}<br>${esc(tr('数据来源'))}：${esc(readable(summary.source_repository || summary.source || 'ModelTrace'))}</p><pre class="trace-bank-declaration">${esc(tr('采集环境'))}：${esc(readable(summary.environment || summary.collection_declaration || tr('见上游元数据')))}</pre>`);
  } catch (error) { put(document.getElementById('modelTraceBank'), `<p class="trace-error">${esc(error.message)} ${button('bank', '重新查询')}</p>`); }
}
async function dispatch(event) {
  const providerEntry = event.target.closest?.('[data-trace-provider]');
  if (providerEntry) {
    event.preventDefault(); event.stopPropagation();
    await open(null, { providerId: providerEntry.dataset.traceProvider });
    return;
  }
  const node = event.target.closest?.('[data-trace-action]');
  if (!node) return;
  event.preventDefault(); event.stopPropagation();
  const action = node.dataset.traceAction, id = node.dataset.jobId;
  try {
    if (action === 'open') await open();
    else if (action === 'view') await view(id);
    else if (action === 'close') dialog?.close();
    else if (action === 'start' && dialogState) await start(dialogState);
    else if (action === 'cancel') { node.disabled = true; try { await cancel(id); } finally { node.disabled = false; } }
    else if (action === 'refresh-job') {
      const state = dialogState;
      const job = unwrap(await request(`/jobs/${encodeURIComponent(id)}`));
      storeJob(job); updateBar();
      if (dialogState === state) renderJob(jobs.get(String(job.id)));
    } else if (action === 'retest') { const job = jobs.get(String(id)); if (job) await open(jobTarget(job).model_id, { parentJobId: id }); }
    else if (action === 'dismiss') { dismissed.add(String(id)); try { localStorage.setItem('modelTraceDismissed', JSON.stringify([...dismissed])); } catch (_) { /* Storage may be unavailable. */ } updateBar(); }
    else if (action === 'sync') { syncError = ''; await sync(); }
    else if (action === 'history') await history();
    else if (action === 'previous') await history(pageNumber - 1);
    else if (action === 'next') await history(pageNumber + 1);
    else if (action === 'bank') await page();
    else if (action === 'generate') await generate();
    else if (action === 'analyze') await analyze();
    else if (action === 'copy') { const item = challenges[Number(node.dataset.index)]; await navigator.clipboard.writeText(item.prompt || item.text || String(item)); node.textContent = tr('已复制'); }
  } catch (error) {
    const target = node.closest('.trace-dialog')?.querySelector('[data-trace-error]');
    if (target) target.textContent = error.message;
    else { syncError = error.message; updateBar(); }
  }
}
window.ModelTrace = { open, view, page, sync, canLeave: async () => !manualDirty || await Dialog.confirm(tr('离开手动归因'), tr('回答未持久化，离开后仍仅保留在当前页面内存。是否继续？')) };
document.addEventListener('click', dispatch);
document.addEventListener('input', event => { if (event.target.matches?.('[data-trace-answer]')) manualDirty = true; });
window.addEventListener('beforeunload', event => { if (manualDirty) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('focus', () => sync());
document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); else schedule(); });
window.addEventListener('message', event => {
  const iframe = document.querySelector('iframe[src*="admin"]');
  if (event.origin === location.origin && iframe && event.source === iframe.contentWindow && event.data?.type === 'crewrouter:model-trace-updated') sync();
});
const modelList = document.getElementById('modelLibraryPage') || document.getElementById('adminModelsPage');
if (modelList) new MutationObserver(updateLatest).observe(modelList, { childList: true, subtree: true });
if (document.getElementById('modelTracePage')?.classList.contains('active')) page();
sync();
