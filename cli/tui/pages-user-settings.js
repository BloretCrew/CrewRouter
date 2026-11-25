'use strict';

const { text } = require('./pages-common');

function securitySettingsPage(runtime) {
  return {
    id: 'security-settings', label: '安全设置', description: '双重验证需要二维码/密码挑战；Passkey 注册依赖浏览器 WebAuthn。',
    async load(api) {
      const result = await Promise.allSettled([api('/api/2fa/status')]);
      const status = result[0].status === 'fulfilled' ? result[0].value : {};
      return { sections: [{ title: '双重验证', rows: [
        { label: `状态：${status.enabled ? '已启用' : '未启用'}` },
        ...(status.enabled ? [{ label: `启用时间：${text(status.enabledAt || status.enabled_at)}` }] : []),
        ...(result[0].status === 'rejected' ? [{ label: result[0].reason.message || '双重验证状态暂不可用' }] : []),
      ] }, { title: 'Passkey', rows: [{ label: 'Passkey 注册和验证需要浏览器 WebAuthn；请从网页用户设置管理。' }] }], actions: [
        { label: '在浏览器打开安全设置', run: async ctx => { const url = `${runtime.client.baseUrl}/console#settings`; const opened = require('../lib/context').openBrowser(url); ctx.notify(opened ? '已在浏览器打开安全设置。' : `请在浏览器访问：${url}`); } },
        { label: '刷新状态', run: ctx => ctx.refresh() },
      ] };
    },
  };
}

function notificationSettingsPage(runtime) {
  return {
    id: 'notification-settings',
    label: '通知设置',
    description: 'Bark、额度不足与请求错误通知。',
    async load(api) {
      const [settingsResult, notificationsResult] = await Promise.allSettled([
        api('/api/user/notification-settings'),
        api('/api/user/notifications', { query: { limit: 50 } }),
      ]);
      const settings = settingsResult.status === 'fulfilled' ? settingsResult.value : {};
      const notifications = notificationsResult.status === 'fulfilled' ? (Array.isArray(notificationsResult.value) ? notificationsResult.value : notificationsResult.value?.items || []) : [];
      const rows = [
        { label: `Bark：${settings.barkEnabled ? '已启用' : '未启用'}` },
        { label: `Server Key：${settings.barkServerKey ? '已配置（为避免泄露不回显）' : '未配置'}` },
        { label: `Endpoint：${text(settings.barkEndpoint, 'https://api.day.app')}` },
        { label: `额度不足提醒：${settings.notifyQuota !== false ? '开启' : '关闭'}` },
        { label: `请求错误提醒：${settings.notifyErrors !== false ? '开启' : '关闭'}` },
        ...(settingsResult.status === 'rejected' ? [{ label: settingsResult.reason.message || '通知设置读取失败' }] : []),
      ];
      const notificationsRows = notifications.slice(0, 30).map(item => ({
        label: `${item.read_at ? '已读' : '未读'} · ${item.title || item.type || '通知'} · ${text(item.created_at)}`,
        detail: item.body || '',
        run: async ctx => {
          const choice = await ctx.choose('通知操作', [
            ...(item.read_at ? [] : [{ label: '标记已读', value: 'read' }]),
            { label: '删除通知', value: 'delete' },
          ]);
          if (choice === 'read') await api(`/api/user/notifications/${encodeURIComponent(item.id)}/read`, { method: 'PUT', body: {} });
          if (choice === 'delete') {
            if (!await ctx.confirm('删除通知', `删除「${item.title || item.type || '通知'}」？`)) return;
            await api(`/api/user/notifications/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
          }
          await ctx.refresh();
        },
      }));
      return {
        sections: [
          { title: '通知设置', rows },
          { title: '最近通知', description: notificationsResult.status === 'rejected' ? '当前实例或版本不支持通知列表。' : `${notifications.length} 条`, rows: notificationsRows.length ? notificationsRows : [{ label: notificationsResult.status === 'rejected' ? notificationsResult.reason.message || '通知列表读取失败' : '暂无通知。' }] },
        ],
        actions: [
          { label: '编辑通知设置', run: async ctx => {
            const values = await ctx.form('编辑通知设置', [
              { name: 'barkEnabled', label: '启用 Bark', type: 'boolean', value: settings.barkEnabled === true },
              { name: 'barkServerKey', label: 'Bark Server Key（密钥不回显）', secret: true, value: '' },
              { name: 'barkEndpoint', label: 'Bark Endpoint', value: settings.barkEndpoint || 'https://api.day.app' },
              { name: 'notifyQuota', label: '额度不足通知', type: 'boolean', value: settings.notifyQuota !== false },
              { name: 'notifyErrors', label: '请求错误通知', type: 'boolean', value: settings.notifyErrors !== false },
            ], { description: settings.barkServerKey ? '服务端不提供密钥遮蔽回填；保存配置时若启用 Bark，需要重新输入 Server Key。留空会清除已保存密钥。' : '启用 Bark 需要填写 Server Key。' });
            if (!values) return;
            if (values.barkEnabled && !String(values.barkServerKey || '').trim()) {
              await ctx.show('需要 Server Key', '启用 Bark 前请输入 Server Key；留空无法保留现有密钥。'); return;
            }
            if (!await ctx.confirm('保存通知设置', `Bark ${values.barkEnabled ? '启用' : '关闭'}\nEndpoint ${values.barkEndpoint}\n额度提醒 ${values.notifyQuota ? '开' : '关'} · 错误提醒 ${values.notifyErrors ? '开' : '关'}\nSecret 不会回显。`)) return;
            await api('/api/user/notification-settings', { method: 'PUT', body: values });
            ctx.notify('通知设置已保存。'); await ctx.refresh();
          } },
          { label: '清空所有通知', disabled: notifications.length === 0 || notificationsResult.status === 'rejected', run: async ctx => {
            if (notificationsResult.status === 'rejected' || notifications.length === 0) return;
            if (!await ctx.confirm('清空所有通知', `将永久删除当前账号的全部站内通知（网页最多显示 50 条；服务端会清空全部通知）。此操作不可撤销。继续？`)) return;
            await api('/api/user/notifications', { method: 'DELETE', body: {} });
            ctx.notify('所有通知已清空。'); await ctx.refresh();
          } },
          { label: '发送 Bark 测试通知', run: async ctx => {
            if (!await ctx.confirm('发送测试通知', `将向配置的 Bark Endpoint 发送测试消息：${settings.barkEndpoint || 'https://api.day.app'}。继续？`)) return;
            const result = await api('/api/user/notification-settings/test', { method: 'POST', body: {} });
            await ctx.show('测试通知', result && result.success ? '测试通知已发送。' : JSON.stringify(result, null, 2));
          } },
          { label: '刷新', run: ctx => ctx.refresh() },
        ],
      };
    },
  };
}

module.exports = { notificationSettingsPage, securitySettingsPage };
