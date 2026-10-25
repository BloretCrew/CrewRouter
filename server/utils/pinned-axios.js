'use strict';

const axios = require('axios');
const { validateUrl } = require('./url-validator');
const { createPinnedHttpAgents } = require('./pinned-http-agents');

async function pinnedAxiosRequest(url, config = {}) {
  const check = await validateUrl(String(url), { allowPrivate: false });
  if (!check.ok || check.url.protocol !== 'https:' || check.url.username || check.url.password) {
    throw new Error(`出站 Axios URL 安全校验失败: ${check.error || '必须使用无凭据的公网 HTTPS 地址'}`);
  }
  const agents = createPinnedHttpAgents(check);
  try {
    const response = await axios.request({
      ...config,
      url: check.url.toString(),
      maxRedirects: 0,
      proxy: false,
      httpAgent: agents.httpAgent,
      httpsAgent: agents.httpsAgent,
    });
    if (config.responseType === 'stream' && response.data?.once) {
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        agents.destroy();
      };
      response.data.once('end', cleanup);
      response.data.once('close', cleanup);
      response.data.once('error', cleanup);
    } else {
      agents.destroy();
    }
    return response;
  } catch (error) {
    agents.destroy();
    throw error;
  }
}

module.exports = { pinnedAxiosRequest };
