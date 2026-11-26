'use strict';

const { loadConfig, getSession, loadServiceState, configPath, servicePath, sessionsPath } = require('../lib/config');
const { serviceStatus, readLogs, probeHealth } = require('../lib/service');
const { formatBigNumber, formatCost, formatTime, relativePath } = require('../lib/format');
const { text, loadParts, errorRows, bar } = require('./pages-common');

function balancePage(runtime) {
  return {
    id: 'balance',
    label: '积分',
    description: '当前积分余额及所属 Team 的用量限额。',
    async load(api) {
      const [balanceResult, codesResult] = await Promise.allSettled([
        api('/api/user/balance'),
        api('/api/user/code-balances'),
      ]);
      const balance = balanceResult.status === 'fulfilled' ? balanceResult.value || {} : {};
      const codes = codesResult.status === 'fulfilled' ? (Array.isArray(codesResult.value) ? codesResult.value : codesResult.value?.items || []) : [];
      const codeSection = codesResult.status === 'fulfilled' && codes.length ? {
        title: '可退款兑换码明细（补充信息）',
        description: '该明细在网页积分页未单独展示；兑换码仅显示首尾字符，避免泄露完整凭证。',
        tableMinWidth: 88,
        columns: [
          { key: 'code', label: '兑换码（遮掩）', ratio: 0.25 }, { key: 'amount', label: '充值金额', ratio: 0.2 },
          { key: 'fee', label: '手续费率', ratio: 0.18 }, { key: 'net', label: '可退净额', ratio: 0.22 },
        ],
        rows: codes.map(item => {
          const amount = Number(item.amount || 0);
          const feeRate = Number(item.fee_rate || 0);
          const netAmount = item.net_amount == null ? amount / (1 + feeRate) : Number(item.net_amount);
          const code = String(item.code || '未知兑换码');
          const masked = code.length > 8 ? `${code.slice(0, 3)}…${code.slice(-3)}` : '已隐藏';
          return { label: `兑换码 ${masked}`, cells: { code: masked, amount: `${amount.toFixed(4)} 积分`, fee: `${(feeRate * 100).toFixed(2)}%`, net: `${netAmount.toFixed(4)} 积分` } };
        }),
      } : null;
      const sections = [{
        title: '当前积分',
        cards: [{ label: '当前积分', value: `${Number(balance.balance || 0).toFixed(0)} 积分`, detail: '可用于支付超出 Team 限额的用量' }],
        rows: [
          ...(balanceResult.status === 'rejected' ? [{ label: `余额读取失败：${balanceResult.reason.message || '未知错误'}` }] : []),
          { label: `可退款余额：${Number(balance.refund_balance || 0).toFixed(4)} 积分`, detail: '兑换码充值余额扣除手续费后的可退金额' },
          ...(Number(balance.rate_limit_rpm || 0) > 0 || Number(balance.rate_limit_tpm || 0) > 0 ? [{ label: '个人请求限额', detail: `${Number(balance.rate_limit_rpm || 0) > 0 ? `每分钟 ${Number(balance.rate_limit_rpm).toLocaleString()} 次请求` : '请求数不限制'} · ${Number(balance.rate_limit_tpm || 0) > 0 ? `每分钟 ${formatBigNumber(balance.rate_limit_tpm)} Token` : 'Token 数不限制'}` }] : []),
          ...(codesResult.status === 'rejected' ? [{ label: `补充兑换码余额明细读取失败：${codesResult.reason.message || '未知错误'}` }] : []),
        ],
      }];
      if (codeSection) sections.push(codeSection);
      const group = balance.group;
      const rules = Array.isArray(group?.rules) ? group.rules : [];
      sections.push({
        title: 'Team 与限额',
        description: group?.name ? `所属 Team：${group.name}${group.description ? ` · ${group.description}` : ''}` : '当前没有 Team 限额规则。',
        rows: rules.length ? rules.map(rule => {
          const limit = Number(rule.rule_value) || 0;
          const current = Number(rule.current) || 0;
          const duration = Number(rule.duration_hours) || 24;
          const durationLabel = duration % 24 === 0 ? `${duration / 24} 天` : `${duration} 小时`;
          const isTokens = rule.rule_type === 'tokens';
          const currentText = isTokens ? formatBigNumber(current) : current.toLocaleString();
          const limitText = isTokens ? formatBigNumber(limit) : limit.toLocaleString();
          const percent = limit > 0 ? Math.min(100, current / limit * 100) : 0;
          const filled = Math.round(percent / 100 * 20);
          return { label: `${durationLabel} · ${isTokens ? 'Token 用量' : '请求次数'}：${currentText} / ${limitText} · ${percent.toFixed(1)}%`, detail: `[${'█'.repeat(filled)}${'░'.repeat(20 - filled)}]${rule.description ? `\n${rule.description}` : ''}` };
        }) : [{ label: '不限制', detail: '暂无限额规则。' }],
      });
      return { sections, actions: [{ label: '刷新', run: ctx => ctx.refresh() }] };
    },
  };
}

function overviewPage(runtime) {
  return {
    id: 'overview',
    label: '概览',
    description: '连接状态、账户余额与近期用量。',
    async load(api) {
      const days = runtime.days || 30;
      const parts = await loadParts(api, [
        { key: 'version', path: '/api/version' },
        { key: 'instance', path: '/api/instance' },
        { key: 'balance', path: '/api/user/balance' },
        { key: 'stats', path: '/api/user/stats', options: { query: { days } } },
        { key: 'keys', path: '/api/user/api-keys' },
        { key: 'current', path: '/api/user/current-model' },
      ]);
      const { values, errors } = parts;
      const summary = values.stats && values.stats.summary ? values.stats.summary : {};
      const daily = Array.isArray(values.stats && values.stats.daily) ? values.stats.daily : [];
      const max = Math.max(...daily.map(row => Number(row.tokens) || 0), 1);
      const sections = [];
      sections.push({
        title: '连接',
        description: '当前 TUI 使用的服务与登录身份。',
        rows: [
          { label: `Profile：${runtime.profileName} · ${runtime.client.baseUrl}` },
          ...(values.version ? [{ label: `服务端：${text(values.version.name, 'CrewRouter')} ${text(values.version.version, '')}` }] : []),
          ...(values.instance ? [{ label: `实例：${text(values.instance.edition)} · ${text(values.instance.runtime)} · 认证 ${(values.instance.auth && values.instance.auth.methods || []).join('/') || '未知'}` }] : []),
          ...(runtime.user ? [{ label: `用户：${runtime.user.username || runtime.client.username || '已登录'}${runtime.client.isAdmin === true ? ' · 管理员' : runtime.client.isAdmin === false ? ' · 普通用户' : ''}` }] : []),
          ...errorRows(errors, { version: '版本', instance: '实例' }),
        ],
      });
      if (errors.stats || errors.balance) {
        sections.push({ title: '账户与用量', rows: errorRows(errors, { stats: '用量', balance: '余额' }) });
      } else {
        sections.push({
          title: '账户与用量',
          description: `最近 ${days} 天。`,
          cards: [
            { label: '余额', value: `${formatCost(values.balance && values.balance.balance)} 积分`, detail: values.balance && values.balance.group ? `所属团队：${values.balance.group.name || ''}` : '' },
            { label: '请求', value: Number(summary.total_requests || 0).toLocaleString(), detail: '成功计费的请求' },
            { label: 'Token 用量', value: `${formatBigNumber(summary.total_tokens)} Token`, detail: '输入与输出 Token 合计' },
            { label: '费用（积分）', value: `${formatCost(summary.total_cost)} 积分`, detail: Number.isFinite(Number(summary.avg_latency)) && summary.avg_latency != null ? `平均响应时间 ${Math.round(Number(summary.avg_latency))} 毫秒` : '平均响应时间：暂无数据' },
            ...(Array.isArray(values.keys) ? [{ label: 'API Key', value: `${values.keys.length} 个` }] : []),
          ],
          rows: [
            ...(values.current && values.current.currentModel ? [{ label: `当前模型：${values.current.currentModel.name || values.current.currentModel.id}` }] : []),
          ],
        });
        if (daily.length) {
          sections.push({
            title: '最近每日用量',
            rows: daily.slice(-7).map(row => ({
              label: `${row.date || '未知日期'} · ${Number(row.requests || 0).toLocaleString()} 次请求 · ${formatBigNumber(row.tokens)} Token · ${formatCost(row.cost)} 积分`,
              detail: bar(row.tokens, max, 24),
            })),
          });
        }
      }
      return {
        sections,
        actions: [
          { label: '打开用量', run: ctx => ctx.navigate('usage') },
          { label: '服务与连接', run: ctx => ctx.navigate('service') },
          { label: '刷新', run: ctx => ctx.refresh() },
        ],
      };
    },
  };
}

function servicePage(runtime) {
  return {
    id: 'service',
    label: '服务/连接',
    description: '启动、停止本机服务，或切换远程 profile。',
    async load() {
      const cfg = loadConfig();
      const health = await probeHealth(runtime.client.baseUrl, { timeoutMs: 2000 });
      const local = await serviceStatus({ baseUrl: runtime.client.baseUrl });
      const profiles = Object.entries(cfg.profiles);
      const sections = [];
      sections.push({
        title: '当前连接',
        rows: [
          { label: `Profile：${runtime.profileName}（${runtime.profile && runtime.profile.type === 'local' ? '本机' : '远程'}）` },
          { label: `地址：${runtime.client.baseUrl}` },
          { label: health.ok ? `服务：在线 · ${text(health.version && health.version.version, '')} · 响应时间 ${health.latencyMs} 毫秒` : `服务：离线 · ${health.error || '连接失败'}` },
          ...(health.ok && health.instance ? [{ label: `实例：${text(health.instance.edition)} · ${text(health.instance.runtime)}` }] : []),
          ...(health.ok && health.setup && (health.setup.needsSetup || health.setup.needsEdition) ? [{ label: '初始化：尚未完成，请打开 /setup' }] : []),
        ],
      });
      if (local.managed && local.state) {
        sections.push({
          title: '本机服务进程',
          description: '由 cr 启动的进程；停止前会校验 PID 归属。',
          rows: [
            { label: `PID：${local.state.pid} · ${local.alive ? '运行中' : '已退出'}` },
            { label: `端口：${local.state.port} · ${local.state.demo ? 'Demo 模式' : '正常模式'}` },
            { label: `日志：${local.state.logPath ? relativePath(local.state.logPath) : '未知'}` },
            { label: `配置：${local.state.configPath ? relativePath(local.state.configPath) : '继承服务端 config.json'}` },
          ],
        });
      } else {
        sections.push({
          title: '本机服务进程',
          description: '当前没有 cr 管理的本机进程；如果端口上已有 CrewRouter，会显示为外部运行。',
          rows: [{ label: local.health && local.health.ok ? `外部服务正在运行：${runtime.client.baseUrl}` : '未运行' }],
        });
      }
      sections.push({
        title: '服务器 profiles',
        description: '点击一行切换 profile；切换后会要求重新登录。',
        rows: profiles.length ? profiles.map(([name, profile]) => ({
          label: `${name === cfg.currentProfile ? '›' : ' '} ${name} · ${profile.type === 'local' ? '本机' : '远程'} · ${profile.baseUrl}`,
          detail: name === cfg.currentProfile ? '当前 profile' : '点击切换',
          run: name === cfg.currentProfile ? undefined : ctx => runtime.switchProfile(ctx, name),
        })) : [{ label: '尚无 profile。' }],
      });
      sections.push({
        title: '配置文件',
        rows: [
          { label: `cli.json：${relativePath(configPath())}` },
          { label: `sessions.json：${relativePath(sessionsPath())}` },
          { label: `service.json：${relativePath(servicePath())}` },
        ],
      });
      return {
        sections,
        actions: [
          { label: '启动本机服务', run: async ctx => { await runtime.startLocal(ctx, false); await ctx.relogin('本机服务已启动，请登录。'); } },
          { label: '启动本机 Demo（无需数据库）', run: async ctx => { await runtime.startLocal(ctx, true); await ctx.relogin('本机 Demo 服务已启动，请登录。'); } },
          { label: '停止本机服务', run: async ctx => { await runtime.stopLocal(ctx); await ctx.refresh(); } },
          { label: '重启本机服务', run: async ctx => {
            const previous = loadServiceState();
            await runtime.stopLocal(ctx);
            await runtime.startLocal(ctx, Boolean(previous && previous.demo));
            await ctx.relogin('本机服务已重启，请登录。');
          } },
          { label: '查看日志', run: async ctx => { const log = readLogs(120); await ctx.show('本地服务日志', log || '暂无日志。'); } },
          { label: '添加远程服务器', run: async ctx => { await runtime.addRemote(ctx); } },
          { label: '测试当前连接', run: async ctx => { const probe = await probeHealth(runtime.client.baseUrl, { timeoutMs: 3000 }); await ctx.show('连接测试', probe.ok ? `在线 · 响应延迟 ${probe.latencyMs} 毫秒 · ${text(probe.version && probe.version.version, '')}` : `失败：${probe.error || '连接失败'}`); } },
          { label: '刷新', run: ctx => ctx.refresh() },
        ],
      };
    },
  };
}

function accountPage(runtime) {
  return {
    id: 'account',
    label: '账户',
    description: '登录身份、会话状态与本地凭证。',
    async load(api) {
      const isApiKey = runtime.client.authType() === 'api-key';
      const parts = await loadParts(api, [
        ...(isApiKey ? [] : [{ key: 'me', path: '/auth/me' }]),
        { key: 'balance', path: '/api/user/balance' },
        { key: 'codes', path: '/api/user/code-balances' },
      ]);
      const { values, errors } = parts;
      const session = getSession(runtime.profileName);
      const me = values.me || runtime.user || {};
      const sections = [{
        title: '账户',
        rows: [
          { label: `用户名：${text(me.username || runtime.client.username, '未知')}` },
          ...(me.email ? [{ label: `邮箱：${me.email}` }] : []),
          { label: `权限：${runtime.client.isAdmin === true ? '管理员' : runtime.client.isAdmin === false ? '普通用户' : '未知'}` },
          { label: `认证：${isApiKey ? 'API Key' : '密码会话'}` },
          ...(runtime.client.authWarning ? [{ label: runtime.client.authWarning }] : []),
          { label: `Profile：${runtime.profileName} · ${runtime.client.baseUrl}` },
        ],
      }, {
        title: '余额与限额',
        rows: [
          { label: `余额：${text(values.balance && values.balance.balance, '未知')}` },
          { label: `可退款余额：${text(values.balance && values.balance.refund_balance, '0')}` },
          ...(values.balance && values.balance.rate_limit_rpm ? [{ label: `个人速率限制：每分钟 ${values.balance.rate_limit_rpm} 次请求 · ${values.balance.rate_limit_tpm || 0} Token` }] : []),
          ...(Array.isArray(values.codes) ? [{ label: `兑换码余额记录：${values.codes.length} 条` }] : []),
          ...errorRows(errors, { me: '账户', balance: '余额', codes: '兑换码余额' }),
        ],
      }, {
        title: '本地会话',
        rows: [
          { label: `保存时间：${session && session.savedAt ? formatTime(session.savedAt) : '未保存'}` },
          { label: `凭证文件：${relativePath(sessionsPath())}` },
          ...(isApiKey && runtime.client.apiKey ? [{ label: `API Key：${runtime.client.apiKey.slice(0, 8)}••••` }] : []),
          ...(!isApiKey && session && Array.isArray(session.cookieJar) ? [{ label: `Cookie：${session.cookieJar.map(cookie => cookie.name).join(', ') || '无'}` }] : []),
        ],
      }];
      return {
        sections,
        actions: [
          { label: '重新登录', run: ctx => ctx.relogin('请重新登录。') },
          { label: '切换服务器', run: async ctx => {
            const cfg = loadConfig();
            const options = Object.entries(cfg.profiles).filter(([name]) => name !== runtime.profileName).map(([name, profile]) => ({ label: `${name} · ${profile.baseUrl}`, value: name }));
            if (!options.length) { await ctx.show('切换服务器', '没有其他 profile，请先添加远程服务器。'); return; }
            const choice = await ctx.choose('切换服务器', options);
            if (choice) await runtime.switchProfile(ctx, choice);
          } },
          { label: '修改密码', run: async ctx => {
            if (isApiKey) { await ctx.show('修改密码', 'API Key 登录不支持修改密码，请使用密码会话登录。'); return; }
            const values = await ctx.form('修改密码', [
              { name: 'oldPassword', label: '旧密码', secret: true },
              { name: 'newPassword', label: '新密码（至少 6 位）', secret: true },
            ], { submitLabel: '保存' });
            if (!values) return;
            await api('/auth/change-password', { method: 'POST', body: values });
            ctx.notify('密码已修改。');
          } },
          { label: '查看脱敏凭证', run: async ctx => {
            await ctx.show('本地凭证', JSON.stringify({
              profile: runtime.profileName,
              authType: runtime.client.authType(),
              username: runtime.client.username,
              isAdmin: runtime.client.isAdmin,
              cookieJar: Array.isArray(runtime.client.cookieJar) ? runtime.client.cookieJar.map(cookie => ({ name: cookie.name, value: '••••', domain: cookie.domain, path: cookie.path })) : [],
              apiKey: runtime.client.apiKey ? `${runtime.client.apiKey.slice(0, 8)}••••` : '',
            }, null, 2));
          } },
          { label: '退出登录', run: async ctx => { if (await ctx.confirm('退出登录', '将清除本地保存的会话并返回登录界面。')) await runtime.logout(ctx); } },
        ],
      };
    },
  };
}

module.exports = { overviewPage, servicePage, accountPage, balancePage };
