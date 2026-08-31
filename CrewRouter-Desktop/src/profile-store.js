'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 1;
const emptyState = () => ({ schemaVersion: SCHEMA_VERSION, activeProfileId: null, profiles: [] });

class ProfileStore {
  constructor(filePath) { this.filePath = filePath; }

  _normalize(raw) {
    if (!raw || typeof raw !== 'object' || raw.schemaVersion !== SCHEMA_VERSION || !Array.isArray(raw.profiles)) return emptyState();
    const profiles = raw.profiles.filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string' && typeof p.url === 'string')
      .map((p) => ({ id: p.id, name: p.name, url: p.url, mode: p.mode || 'remote', edition: p.edition || null,
        capabilities: p.capabilities && typeof p.capabilities === 'object' ? p.capabilities : {},
        protocolVersion: p.protocolVersion || null, lastConnectedAt: p.lastConnectedAt || null }));
    const activeProfileId = profiles.some((p) => p.id === raw.activeProfileId) ? raw.activeProfileId : (profiles[0]?.id || null);
    return { schemaVersion: SCHEMA_VERSION, activeProfileId, profiles };
  }

  load() {
    try { return this._normalize(JSON.parse(fs.readFileSync(this.filePath, 'utf8'))); }
    catch { return emptyState(); }
  }

  save(state) {
    const normalized = this._normalize({ ...state, schemaVersion: SCHEMA_VERSION });
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.filePath);
    return normalized;
  }

  upsert(profile) {
    const state = this.load();
    const index = state.profiles.findIndex((p) => p.id === profile.id);
    const candidate = { ...profile, mode: profile.mode || 'remote' };
    if (typeof candidate.id !== 'string' || typeof candidate.name !== 'string' || typeof candidate.url !== 'string') throw new Error('profile 无效');
    const next = this._normalize({ schemaVersion: SCHEMA_VERSION, activeProfileId: candidate.id, profiles: [candidate] });
    if (!next.profiles.length) throw new Error('profile 无效');
    if (index < 0) state.profiles.push(next.profiles[0]); else state.profiles[index] = next.profiles[0];
    state.activeProfileId = profile.id;
    return this.save(state);
  }

  remove(id) { const state = this.load(); state.profiles = state.profiles.filter((p) => p.id !== id); if (state.activeProfileId === id) state.activeProfileId = state.profiles[0]?.id || null; return this.save(state); }
  setActive(id) { const state = this.load(); if (!state.profiles.some((p) => p.id === id)) throw new Error('profile 不存在'); state.activeProfileId = id; return this.save(state); }
  getActive() { const state = this.load(); return state.profiles.find((p) => p.id === state.activeProfileId) || null; }
}

module.exports = { ProfileStore, SCHEMA_VERSION };
