const state = {
    session: null,
    server: null,
    activities: [],
    editingActivityId: '',
    submitting: false,
    readonly: false
};

const elements = {};
const { displayServerAuthor } = window.ChaFuWangDisplay || { displayServerAuthor: (server, fallback = '未知作者') => String(server?.authorNickname || server?.author || fallback).trim() || fallback };

document.addEventListener('DOMContentLoaded', () => {
    void init();
});

async function init() {
    cacheElements();
    bindEvents();

    const targetHost = getTargetHostFromQuery();
    if (!targetHost) {
        showPageError('缺少有效的服务器地址参数，无法管理活动。');
        setReadonlyState(true);
        return;
    }

    try {
        await hydrateSession();
        if (!state.session?.authenticated) {
            window.location.href = '/api/oauth/entry';
            return;
        }

        const server = await loadServerByHost(targetHost);
        if (!server) {
            showPageError(`未找到服务器：${targetHost}`);
            setReadonlyState(true);
            return;
        }

        state.server = server;
        state.activities = normalizeServerActivities(server.activities);
        state.readonly = !canCurrentUserManageServer(server);

        renderServerMeta();
        renderActivityList();
        updatePageSubtitle();

        if (state.readonly) {
            showPageError('你不是该服务器作者，且没有管理员权限，无法修改活动。');
            setReadonlyState(true);
        }
    } catch (error) {
        showPageError(error.message || '加载失败，请稍后重试。');
        setReadonlyState(true);
    }
}

function cacheElements() {
    elements.pageSubtitle = document.getElementById('page-subtitle');
    elements.serverMeta = document.getElementById('server-meta');
    elements.reloadButton = document.getElementById('reload-button');

    elements.formTitle = document.getElementById('form-title');
    elements.activityForm = document.getElementById('activity-form');
    elements.activityTitle = document.getElementById('activity-title');
    elements.activitySummary = document.getElementById('activity-summary');
    elements.activityBanner = document.getElementById('activity-banner');
    elements.activityStart = document.getElementById('activity-start');
    elements.activityEnd = document.getElementById('activity-end');
    elements.activityLink = document.getElementById('activity-link');
    elements.formError = document.getElementById('form-error');
    elements.cancelEdit = document.getElementById('cancel-edit');
    elements.submitButton = document.getElementById('submit-button');

    elements.activityList = document.getElementById('activity-list');
}

function bindEvents() {
    elements.reloadButton?.addEventListener('click', () => {
        window.location.reload();
    });

    elements.activityForm?.addEventListener('submit', async (event) => {
        event.preventDefault();
        await handleSubmitActivity();
    });

    elements.cancelEdit?.addEventListener('click', () => {
        resetFormState();
    });

    elements.activityList?.addEventListener('click', async (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target) {
            return;
        }

        const actionButton = target.closest('button[data-action][data-activity-id]');
        if (!actionButton) {
            return;
        }

        const action = String(actionButton.dataset.action || '').trim();
        const activityId = String(actionButton.dataset.activityId || '').trim();
        if (!action || !activityId) {
            return;
        }

        if (action === 'edit') {
            handleEditActivity(activityId);
            return;
        }

        if (action === 'delete') {
            await handleDeleteActivity(activityId);
        }
    });
}

async function hydrateSession() {
    const response = await fetch('/api/auth/session', {
        method: 'GET',
        headers: {
            Accept: 'application/json'
        },
        cache: 'no-store'
    });

    const payload = await parseJsonResponse(response);
    if (!response.ok) {
        throw new Error(payload?.message || `读取登录状态失败（${response.status}）`);
    }

    state.session = {
        authenticated: Boolean(payload?.authenticated),
        username: String(payload?.username || '').trim(),
        admin: Boolean(payload?.admin)
    };
}

async function loadServerByHost(host) {
    const response = await fetch('/data/part.json', {
        method: 'GET',
        headers: {
            Accept: 'application/json'
        },
        cache: 'no-store'
    });

    if (!response.ok) {
        throw new Error(`读取服务器数据失败（${response.status}）`);
    }

    const payload = await response.json();
    const list = Array.isArray(payload?.Servers) ? payload.Servers : [];

    const targetHost = normalizeServerHostInput(host);
    return list.find((server) => normalizeServerHostInput(server?.url || '') === targetHost) || null;
}

function canCurrentUserManageServer(server) {
    if (!state.session?.authenticated || !server) {
        return false;
    }

    if (state.session.admin) {
        return true;
    }

    const author = String(server?.author || '').trim();
    const currentUser = String(state.session.username || '').trim();
    return Boolean(author && currentUser && author === currentUser);
}

function updatePageSubtitle() {
    if (!elements.pageSubtitle) {
        return;
    }

    if (!state.server) {
        elements.pageSubtitle.textContent = '未找到目标服务器。';
        return;
    }

    const author = displayServerAuthor(state.server, '未知作者');
    const title = String(state.server.title || '未命名服务器').trim() || '未命名服务器';
    elements.pageSubtitle.textContent = `正在管理「${title}」的活动，作者：${author}`;
}

function renderServerMeta() {
    if (!elements.serverMeta) {
        return;
    }

    if (!state.server) {
        elements.serverMeta.innerHTML = '<p class="empty">未找到服务器信息。</p>';
        return;
    }

    const tags = normalizeStringArray(state.server.type);
    const activityCount = state.activities.length;

    elements.serverMeta.innerHTML = `
        <article class="meta-item">
            <p class="meta-label">服务器名称</p>
            <p class="meta-value">${escapeHtml(state.server.title || '未命名服务器')}</p>
        </article>
        <article class="meta-item">
            <p class="meta-label">服务器地址</p>
            <p class="meta-value">${escapeHtml(state.server.url || '未提供地址')}</p>
        </article>
        <article class="meta-item">
            <p class="meta-label">作者</p>
            <p class="meta-value">${escapeHtml(displayServerAuthor(state.server, '未知作者'))}</p>
        </article>
        <article class="meta-item">
            <p class="meta-label">标签</p>
            <p class="meta-value">${escapeHtml(tags.join('、') || '暂无标签')}</p>
        </article>
        <article class="meta-item">
            <p class="meta-label">当前活动数</p>
            <p class="meta-value">${activityCount} 个</p>
        </article>
        <article class="meta-item">
            <p class="meta-label">提交规则</p>
            <p class="meta-value">普通作者提交后进入审核，超级管理员提交直接生效。</p>
        </article>
    `;
}

function renderActivityList() {
    if (!elements.activityList) {
        return;
    }

    if (state.activities.length === 0) {
        elements.activityList.innerHTML = '<p class="empty">暂无活动，请先创建活动。</p>';
        return;
    }

    const sorted = state.activities
        .slice()
        .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0));

    elements.activityList.innerHTML = sorted
        .map((activity) => {
            const linkNode = activity.link
                ? `<a class="item-link" href="${escapeHtml(activity.link)}" target="_blank" rel="noopener noreferrer">查看活动链接</a>`
                : '<span class="item-link">暂无活动链接</span>';
            const timeRange = formatActivityTimeRange(activity);
            const actionNode = state.readonly
                ? ''
                : `
                    <div class="activity-item-actions">
                        <button class="ghost-button" type="button" data-action="edit" data-activity-id="${escapeHtml(activity.id)}">编辑</button>
                        <button class="ghost-button item-danger" type="button" data-action="delete" data-activity-id="${escapeHtml(activity.id)}">删除</button>
                    </div>
                `;

            return `
                <article class="activity-item">
                    ${activity.banner
                        ? `<img class="activity-item-banner" src="${escapeHtml(activity.banner)}" alt="${escapeHtml(activity.title)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none'">`
                        : ''}
                    <div class="activity-item-main">
                        <h3 class="activity-item-title">${escapeHtml(activity.title)}</h3>
                        <p class="activity-item-summary">${escapeHtml(activity.summary || '活动简介待补充。')}</p>
                        <div class="activity-item-meta">
                            <span>${escapeHtml(timeRange)}</span>
                            ${linkNode}
                        </div>
                    </div>
                    ${actionNode}
                </article>
            `;
        })
        .join('');
}

function handleEditActivity(activityId) {
    if (state.readonly || state.submitting) {
        return;
    }

    const target = state.activities.find((item) => item.id === activityId);
    if (!target) {
        return;
    }

    state.editingActivityId = target.id;

    if (elements.formTitle) {
        elements.formTitle.textContent = '编辑活动';
    }
    if (elements.submitButton) {
        elements.submitButton.textContent = '保存修改';
    }
    if (elements.cancelEdit) {
        elements.cancelEdit.hidden = false;
    }

    if (elements.activityTitle) elements.activityTitle.value = target.title;
    if (elements.activitySummary) elements.activitySummary.value = target.summary;
    if (elements.activityBanner) elements.activityBanner.value = target.banner;
    if (elements.activityStart) elements.activityStart.value = toDateTimeLocalValue(target.startAt);
    if (elements.activityEnd) elements.activityEnd.value = toDateTimeLocalValue(target.endAt);
    if (elements.activityLink) elements.activityLink.value = target.link;

    setFormError('');
}

async function handleDeleteActivity(activityId) {
    if (state.readonly || state.submitting) {
        return;
    }

    const target = state.activities.find((item) => item.id === activityId);
    if (!target) {
        return;
    }

    const confirmed = window.confirm(`确认删除活动「${target.title}」吗？`);
    if (!confirmed) {
        return;
    }

    const nextList = state.activities.filter((item) => item.id !== activityId);
    await persistActivities(nextList);

    if (state.editingActivityId === activityId) {
        resetFormState();
    }
}

async function handleSubmitActivity() {
    if (state.readonly || state.submitting) {
        return;
    }

    if (!state.server) {
        setFormError('服务器信息未加载，无法提交。');
        return;
    }

    const result = collectActivityFromForm();
    if (!result.ok) {
        setFormError(result.error || '表单数据无效，请检查后重试。');
        return;
    }

    const activity = result.activity;
    const nextList = state.editingActivityId
        ? state.activities.map((item) => (item.id === state.editingActivityId ? { ...activity, id: state.editingActivityId } : item))
        : [...state.activities, activity];
    await persistActivities(nextList);
    resetFormState();
}

function collectActivityFromForm() {
    const title = String(elements.activityTitle?.value || '').trim();
    const summary = String(elements.activitySummary?.value || '').trim();
    const banner = normalizeBackgroundUrl(elements.activityBanner?.value || '');
    const startAt = normalizeActivityDate(elements.activityStart?.value || '');
    const endAt = normalizeActivityDate(elements.activityEnd?.value || '');
    const link = normalizeActivityLink(elements.activityLink?.value || '');

    if (!title) {
        return {
            ok: false,
            error: '活动标题不能为空。'
        };
    }

    return {
        ok: true,
        activity: {
            id: state.editingActivityId || createActivityId(),
            title,
            summary,
            banner,
            startAt,
            endAt,
            link,
            updatedAt: Date.now()
        }
    };
}

async function persistActivities(activities) {
    if (!state.server) {
        return;
    }

    setSubmittingState(true);
    setFormError('');

    try {
        const normalized = normalizeServerActivities(activities);
        const payloadServer = buildServerUpsertPayload(state.server, normalized);

        const response = await fetch('/api/server/upsert', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json'
            },
            body: JSON.stringify({
                mode: 'edit',
                originalUrl: state.server.url,
                server: payloadServer
            })
        });

        const payload = await parseJsonResponse(response);
        if (!response.ok || !payload?.success) {
            throw new Error(payload?.message || `保存失败（${response.status}）`);
        }

        state.activities = normalized;
        state.server = {
            ...state.server,
            ...payloadServer,
            activities: normalized
        };

        renderServerMeta();
        renderActivityList();

        if (payload?.pending) {
            window.alert(payload?.message || '提交成功，等待超级管理员审核。');
        } else {
            window.alert('活动保存成功。');
        }
    } catch (error) {
        setFormError(error.message || '保存失败，请稍后重试。');
    } finally {
        setSubmittingState(false);
    }
}

function buildServerUpsertPayload(server, activities) {
    return {
        title: String(server?.title || '').trim(),
        text: String(server?.text || '').trim(),
        url: normalizeServerHostInput(server?.url || ''),
        type: normalizeStringArray(server?.type),
        background: normalizeBackgroundUrl(server?.background || ''),
        tip: String(server?.tip || '').trim(),
        authorAvatar: String(server?.authorAvatar || '').trim(),
        category: String(server?.category || '').trim(),
        client: String(server?.client || '').trim(),
        language: String(server?.language || '').trim(),
        version: String(server?.version || '').trim(),
        mode: String(server?.mode || '').trim(),
        build: String(server?.build || '').trim(),
        updatedAt: String(server?.updatedAt || server?.updateTime || server?.lastUpdate || '').trim(),
        privacy: String(server?.privacy || server?.policy || server?.privacyPolicy || '').trim(),
        BestTime: String(server?.BestTime || '').trim(),
        OnlineCheck: server?.OnlineCheck !== false,
        otherip: normalizePlainObject(server?.otherip),
        links: normalizePlainObject(server?.links),
        activities
    };
}

function resetFormState() {
    state.editingActivityId = '';

    if (elements.formTitle) {
        elements.formTitle.textContent = '新增活动';
    }
    if (elements.submitButton) {
        elements.submitButton.textContent = '添加活动';
    }
    if (elements.cancelEdit) {
        elements.cancelEdit.hidden = true;
    }

    if (elements.activityForm) {
        elements.activityForm.reset();
    }

    setFormError('');
}

function setReadonlyState(readonly) {
    state.readonly = Boolean(readonly);

    const disabled = state.readonly;
    const controls = [
        elements.activityTitle,
        elements.activitySummary,
        elements.activityBanner,
        elements.activityStart,
        elements.activityEnd,
        elements.activityLink,
        elements.submitButton,
        elements.cancelEdit
    ];

    controls.forEach((control) => {
        if (control) {
            control.disabled = disabled;
        }
    });
}

function setSubmittingState(submitting) {
    state.submitting = Boolean(submitting);

    if (elements.submitButton) {
        elements.submitButton.disabled = state.submitting || state.readonly;
        elements.submitButton.textContent = state.submitting ? '提交中...' : (state.editingActivityId ? '保存修改' : '添加活动');
    }

    if (elements.cancelEdit) {
        elements.cancelEdit.disabled = state.submitting || state.readonly;
    }
}

function setFormError(message) {
    if (!elements.formError) {
        return;
    }

    const text = String(message || '').trim();
    elements.formError.textContent = text;
    elements.formError.hidden = !text;
}

function showPageError(message) {
    if (elements.pageSubtitle) {
        elements.pageSubtitle.textContent = String(message || '发生未知错误。');
    }
}

function getTargetHostFromQuery() {
    const searchParams = new URLSearchParams(window.location.search);
    const host = normalizeServerHostInput(searchParams.get('host') || '');
    return isValidHost(host) ? host : '';
}

function createActivityId() {
    return `activity-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeServerActivities(value) {
    const source = Array.isArray(value) ? value : [];

    return source
        .map((item, index) => normalizeSingleActivity(item, index))
        .filter(Boolean)
        .slice(0, 20);
}

function normalizeSingleActivity(item, index = 0) {
    if (!item || typeof item !== 'object') {
        return null;
    }

    const title = String(item.title || item.name || '').trim();
    if (!title) {
        return null;
    }

    return {
        id: String(item.id || `activity-${index + 1}`).trim(),
        title,
        summary: String(item.summary || item.desc || item.description || '').trim(),
        banner: normalizeBackgroundUrl(item.banner || item.cover || item.image || item.poster),
        startAt: normalizeActivityDate(item.startAt || item.start || item.beginAt || item.startTime),
        endAt: normalizeActivityDate(item.endAt || item.end || item.finishAt || item.endTime),
        link: normalizeActivityLink(item.link || item.url),
        updatedAt: Number.isFinite(Number(item.updatedAt)) ? Number(item.updatedAt) : Date.now()
    };
}

function formatActivityTimeRange(activity) {
    const start = formatActivityDateForDisplay(activity?.startAt);
    const end = formatActivityDateForDisplay(activity?.endAt);

    if (start && end) {
        return `${start} - ${end}`;
    }

    if (start) {
        return `开始时间：${start}`;
    }

    if (end) {
        return `结束时间：${end}`;
    }

    return '活动时间待定';
}

function formatActivityDateForDisplay(rawValue) {
    if (rawValue === null || rawValue === undefined || rawValue === '') {
        return '';
    }

    if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
        return new Date(rawValue).toLocaleString('zh-CN', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        });
    }

    const text = String(rawValue).trim();
    if (!text) {
        return '';
    }

    const numeric = Number(text);
    if (Number.isFinite(numeric)) {
        return new Date(numeric).toLocaleString('zh-CN', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        });
    }

    const parsed = Date.parse(text);
    if (Number.isFinite(parsed)) {
        return new Date(parsed).toLocaleString('zh-CN', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        });
    }

    return text;
}

function normalizeActivityDate(rawValue) {
    if (rawValue === null || rawValue === undefined) {
        return '';
    }

    const text = String(rawValue || '').trim();
    if (!text) {
        return '';
    }

    const numeric = Number(text);
    if (Number.isFinite(numeric)) {
        return numeric;
    }

    const parsed = Date.parse(text);
    if (Number.isFinite(parsed)) {
        return parsed;
    }

    return text;
}

function toDateTimeLocalValue(rawValue) {
    const formatted = formatActivityDateForDisplay(rawValue);
    if (!formatted) {
        return '';
    }

    const value = typeof rawValue === 'number' && Number.isFinite(rawValue)
        ? new Date(rawValue)
        : new Date(String(rawValue || ''));

    if (Number.isNaN(value.getTime())) {
        return '';
    }

    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    const hour = String(value.getHours()).padStart(2, '0');
    const minute = String(value.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day}T${hour}:${minute}`;
}

function normalizeActivityLink(rawValue) {
    const value = String(rawValue || '').trim();
    if (!value) {
        return '';
    }

    if (/^https?:\/\//i.test(value) || value.startsWith('/')) {
        return value;
    }

    if (isValidHost(value)) {
        return `https://${value}`;
    }

    return '';
}

function normalizeServerHostInput(rawValue) {
    const value = String(rawValue || '').trim();
    if (!value) {
        return '';
    }

    if (/^https?:\/\//i.test(value)) {
        try {
            const parsed = new URL(value);
            return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
        } catch (error) {
            return '';
        }
    }

    return value;
}

function isValidHost(value) {
    return /^[a-zA-Z0-9][a-zA-Z0-9.-]*(?::\d+)?$/.test(String(value || '').trim());
}

function normalizeBackgroundUrl(rawValue) {
    const value = String(rawValue || '').trim();
    if (!value) {
        return '';
    }

    if (/^https?:\/\//i.test(value) || value.startsWith('/')) {
        return value;
    }

    return '';
}

function normalizePlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {};
    }

    return value;
}

function normalizeStringArray(value) {
    if (Array.isArray(value)) {
        return value
            .map((item) => String(item || '').trim())
            .filter(Boolean);
    }

    if (typeof value === 'string') {
        return value
            .split(/[\n,，]/)
            .map((item) => item.trim())
            .filter(Boolean);
    }

    return [];
}

async function parseJsonResponse(response) {
    const text = await response.text();
    try {
        return JSON.parse(text || '{}');
    } catch (error) {
        return {
            success: false,
            message: text || '解析响应失败'
        };
    }
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
