import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { credentialKey } from '@deepseek-ai/dsh-credentials';

export const name = 'crewrouter-agent-tools';
export const inject = ['tools', 'credentials'];
export const Config = z.object({
  baseUrl: z.string().default(''),
});

const CREDENTIAL = credentialKey('bloret-crew-dsh-crewrouter', 'default');
const MAX_OUTPUT = 12000;

function safeBaseUrl(value) {
  let url;
  try { url = new URL(String(value || '')); }
  catch { throw new Error('请先配置有效的 CrewRouter 根地址（http/https）。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('CrewRouter 地址必须是无凭据、无查询串的 http/https 根地址。');
  }
  if (url.pathname !== '/' && url.pathname !== '/v1') throw new Error('CrewRouter 管理 API 地址不能带子路径。');
  return `${url.protocol}//${url.host}`;
}

function bounded(value) {
  let text;
  try { text = JSON.stringify(value, null, 2); }
  catch { text = String(value); }
  if (text === undefined) text = String(value);
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n…（结果已截断）` : text;
}

async function request(ctx, config, path, query, signal) {
  const key = await ctx.credentials.resolve(CREDENTIAL);
  if (!key?.value) throw new Error('尚未配置 CrewRouter API Key。请在 DSH credentials 中为 bloret-crew-dsh-crewrouter/default 保存一个拥有相应只读权限的 API Key。');
  const url = new URL(path, `${safeBaseUrl(config.baseUrl)}/`);
  for (const [name, value] of Object.entries(query || {})) url.searchParams.set(name, String(value));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('CrewRouter 请求超时')), 15000);
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${key.value}` },
      redirect: 'error',
      signal: controller.signal,
    });
    if (response.status === 401) throw new Error('CrewRouter API Key 无效、已过期或已停用。');
    if (response.status === 403) throw new Error('CrewRouter 拒绝访问（403）；请确认该 API Key 已授予此只读 API 所需的权限。');
    if (!response.ok) throw new Error(`CrewRouter 请求失败（HTTP ${response.status}）。`);
    const data = await response.json();
    return bounded(data);
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('CrewRouter 请求已取消或超时。');
    if (error?.message?.startsWith('CrewRouter ')) throw error;
    throw new Error(`CrewRouter 网络/API 错误：${String(error?.message || error).slice(0, 300)}`);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

function register(ctx, config, { name: toolName, description, parameters, path, query }) {
  ctx.tools.register(defineTool({
    name: toolName,
    description,
    parameters,
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      return request(ctx, config, path, query ? query(args) : {}, exec.signal);
    },
  }));
}

export function apply(ctx, config) {
  register(ctx, config, {
    name: 'crewrouter_overview',
    description: '读取当前 CrewRouter 账户用量统计；不会修改账户。',
    parameters: { days: { type: 'number', description: '用量统计天数，1–90，默认 7。' } },
    path: '/api/user/stats',
    query: args => ({ days: Math.min(90, Math.max(1, Math.floor(Number(args.days) || 7))) }),
  });
  register(ctx, config, {
    name: 'crewrouter_models',
    description: '列出当前 CrewRouter API Key 可访问的模型。',
    parameters: {},
    path: '/api/user/models',
  });
  register(ctx, config, {
    name: 'crewrouter_sessions',
    description: '分页读取当前账户最近的 CrewRouter 会话摘要，不读取消息正文。',
    parameters: {
      days: { type: 'number', description: '回看天数，1–90，默认 7。' },
      page: { type: 'number', description: '页码，默认 1。' },
    },
    path: '/api/user/sessions',
    query: args => ({ days: Math.min(90, Math.max(1, Math.floor(Number(args.days) || 7))), page: Math.min(100, Math.max(1, Math.floor(Number(args.page) || 1))), pageSize: 20 }),
  });
}
