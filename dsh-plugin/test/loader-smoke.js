import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { apply } from '../index.js';

const profileDir = process.env.DSH_PROFILE_DIR;
if (!profileDir) throw new Error('run with DSH_PROFILE_DIR set to an initialized DSH profile directory');
const dshRoot = process.env.DSH_INSTALL_ROOT || '/opt/dsh/dsh';
const hostRequire = createRequire(resolve(dshRoot, 'package.json'));
const credentialsModule = hostRequire('@deepseek-ai/dsh-credentials');
const { credentialKey } = credentialsModule;
const manifest = JSON.parse(readFileSync(resolve(profileDir, 'node_modules/@bloret-crew/dsh-crewrouter/package.json'), 'utf8'));
const pluginRoot = resolve(profileDir, 'node_modules/@bloret-crew/dsh-crewrouter');
if (manifest.name !== '@bloret-crew/dsh-crewrouter' || !manifest.dsh?.bundle?.patch) throw new Error('profile package is not the expected CrewRouter bundle');
const registrations = [];
const ctx = {
  tools: { register(definition) { registrations.push(definition); return () => {}; } },
  credentials: { async resolve(key) { if (key !== credentialKey('bloret-crew-dsh-crewrouter', 'default')) throw new Error('unexpected credential ref'); return { value: 'test-key', source: 'test' }; } },
};
apply(ctx, { baseUrl: 'http://localhost:20003' });
if (registrations.length !== 3) throw new Error(`expected 3 tools; got ${registrations.length}`);
for (const tool of registrations) {
  if (typeof tool.execute !== 'function' || !tool.parameters || !tool.output) throw new Error(`invalid tool registration: ${tool.name}`);
}
console.log(JSON.stringify({ package: manifest.name, pluginRoot, tools: registrations.map(tool => tool.name) }));
