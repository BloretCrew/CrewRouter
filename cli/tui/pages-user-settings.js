'use strict';

const { text } = require('./pages-common');

function securitySettingsPage(runtime) {
  return {
    id: 'security-settings', label: '安全设置', description: '管理双重认证（2FA）和通行密钥（Passkeys）。',
    async load(api) {
      const [statusResult, passkeysResult] = await Promise.allSettled([api('/api/2fa/status'), api('/api/passkey/list')]);
      const status = statusResult.status === 'fulfilled' ? statusResult.value : {};
      const passkeys = passkeysResult.status === 'fulfilled' && Array.isArray(passkeysResult.value) ? passkeysResult.value : [];
      const enabled = status.enabled === true;
      const passkeyRows = passkeys.map((passkey, index) => {
        const device = passkey.deviceType === 'multiDevice' ? '同步通行密钥' : '本机通行密钥';
        const credentialId = String(passkey.credentialID || '');
        const shortId = credentialId ? `${credentialId.slice(0, 12)}…` : '编号未知';
        return { label: `${device} ${index + 1} · ${shortId}`, detail: `创建于：${passkey.createdAt ? text(passkey.createdAt) : '未知'}`, run: async ctx => {
          const choice = await ctx.choose(`${device} · ${shortId}`, [{ label: '删除此通行密钥', value: 'delete' }, { label: '返回', value: 'cancel' }]);
          if (choice !== 'delete') return;
          if (!credentialId || !await ctx.confirm('删除通行密钥', '此设备将不能再使用该通行密钥登录。继续？')) return;
          await api(`/api/passkey/${encodeURIComponent(credentialId)}`, { method: 'DELETE' });
          ctx.notify('通行密钥已删除。'); await ctx.refresh();
        } };
      });
      const sections = [
        { title: '双重认证（2FA）', description: '使用身份验证器应用增强账户安全。启用时需要扫描二维码或手动录入密钥，并验证 6 位验证码。', rows: [
          { label: `状态：${enabled ? '已启用' : '未启用'}` },
          ...(enabled && (status.enabledAt || status.enabled_at) ? [{ label: `启用时间：${text(status.enabledAt || status.enabled_at)}` }] : []),
          ...(statusResult.status === 'rejected' ? [{ label: `双重认证状态读取失败：${statusResult.reason.message || '未知错误'}` }] : []),
        ], actions: [
          ...(!enabled && statusResult.status === 'fulfilled' ? [{ label: '开始设置双重认证', run: async ctx => {
            const generated = await api('/api/2fa/generate');
            if (!generated.secret) { await ctx.show('无法生成双重认证密钥', '服务器未返回可录入的身份验证器密钥。'); return; }
            await ctx.show('双重认证密钥（仅本次显示）', `在身份验证器应用中添加 CrewRouter 账户，并手动输入以下 Base32 密钥：\n\n${generated.secret}\n\n不要将密钥发送给他人；验证成功前不要关闭此页面。`);
            const token = String(await ctx.ask('输入身份验证器当前显示的 6 位验证码', { secret: true }) || '').replace(/\s/g, '');
            if (!/^\d{6}$/.test(token)) { await ctx.show('验证码格式错误', '验证码必须是 6 位数字。当前设置密钥仍有效；请重新输入身份验证器显示的验证码。'); return; }
            const result = await api('/api/2fa/enable', { method: 'POST', body: { token } });
            if (!result.success) { await ctx.show('双重认证未启用', `${result.error || '验证码验证失败。'}\n当前设置密钥仍有效；请确认身份验证器时间准确后重试，若已取消设置，请重新生成密钥。`); return; }
            ctx.notify('双重认证已启用。'); await ctx.refresh();
          } }] : []),
          ...(enabled ? [{ label: '关闭双重认证', run: async ctx => {
            const password = await ctx.ask('输入当前账户密码以关闭双重认证', { secret: true });
            if (!password) return;
            if (!await ctx.confirm('关闭双重认证', '关闭后，登录账户将不再需要 6 位验证码。继续？')) return;
            const result = await api('/api/2fa/disable', { method: 'POST', body: { password } });
            if (!result.success) { await ctx.show('无法关闭双重认证', result.error || '密码验证失败。'); return; }
            ctx.notify('双重认证已关闭。'); await ctx.refresh();
          } }] : []),
        ] },
        { title: '通行密钥（Passkeys）', description: '使用指纹、面部识别或硬件密钥登录。注册需要支持 WebAuthn 的浏览器；TUI 可查看或删除已有密钥。', rows: [
          ...(passkeysResult.status === 'rejected' ? [{ label: `通行密钥列表读取失败：${passkeysResult.reason.message || '未知错误'}` }] : passkeyRows.length ? passkeyRows : [{ label: '暂无绑定的通行密钥。' }]),
        ], actions: [
          { label: '在网页中添加通行密钥', run: async ctx => { const url = `${runtime.client.baseUrl}/console#settings`; const opened = require('../lib/context').openBrowser(url); ctx.notify(opened ? '已在浏览器打开安全设置中的通行密钥注册区域。' : `请在浏览器打开安全设置添加通行密钥：${url}`); } },
        ] },
      ];
      return { sections, actions: [
        { label: '在浏览器打开安全设置', toolbar: true, run: async ctx => { const url = `${runtime.client.baseUrl}/console#settings`; const opened = require('../lib/context').openBrowser(url); ctx.notify(opened ? '已在浏览器打开安全设置。' : `请在浏览器访问：${url}`); } },
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
            const endpoint = String(values.barkEndpoint || '').trim();
            let parsedEndpoint;
            try { parsedEndpoint = new URL(endpoint); } catch (_) { parsedEndpoint = null; }
            if (!parsedEndpoint || !['http:', 'https:'].includes(parsedEndpoint.protocol) || parsedEndpoint.username || parsedEndpoint.password || parsedEndpoint.search || parsedEndpoint.hash) {
              await ctx.show('Bark 服务地址无效', '请输入完整的 HTTP 或 HTTPS 地址，不要包含用户名、密码、查询参数或片段。'); return;
            }
            const privateHttpNotice = parsedEndpoint.protocol === 'http:' ? 'HTTP 地址仅适用于本机/内网，并且必须已由管理员加入 CR_BARK_PRIVATE_ORIGINS 白名单；公网地址必须使用 HTTPS。服务器会执行最终校验。\\n' : '';
            if (values.barkEnabled && !String(values.barkServerKey || '').trim()) {
              await ctx.show('需要 Server Key', '启用 Bark 前请输入 Server Key。'); return;
            }
            const keyAction = String(values.barkServerKey || '').trim() ? '更新已配置密钥' : settings.barkServerKey ? '清除已保存密钥' : '未配置密钥';
            if (!await ctx.confirm('保存通知设置', `${privateHttpNotice}Bark ${values.barkEnabled ? '启用' : '关闭'}\n服务地址：${endpoint}\nServer Key：${keyAction}\n额度不足通知：${values.notifyQuota ? '开启' : '关闭'} · 请求错误通知：${values.notifyErrors ? '开启' : '关闭'}\n密钥不会回显。`)) return;
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
