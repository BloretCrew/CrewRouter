'use strict';

const { EventEmitter } = require('node:events');

// 主进程唯一的状态模型。renderer 与 IPC 只读取 snapshot()，写入只经过 set()/helpers。
const MODES = Object.freeze(['idle', 'starting-local', 'connecting', 'awaiting-official-login', 'connected', 'error']);
const PENDING_KINDS = Object.freeze(['local', 'custom', 'official-login', 'profile']);

function cloneLocalServer(value) {
  return { ready: false, pid: null, port: null, baseUrl: null, logsDir: null, ...(value || {}) };
}

class AppState extends EventEmitter {
  constructor() {
    super();
    this.mode = 'idle';
    this.target = null;
    this.instance = null;
    this.profile = null;
    this.localProfile = null;
    this.localServer = cloneLocalServer();
    this.pending = null;
    this.progress = null;
    this.error = null;
    this.prefill = null;
    this.theme = 'system';
    this.language = 'zh';
  }

  set(patch = {}) {
    if (patch.mode !== undefined && !MODES.includes(patch.mode)) throw new Error(`未知状态 mode=${patch.mode}`);
    if (patch.pending && !PENDING_KINDS.includes(patch.pending.kind)) throw new Error(`未知 pending kind=${patch.pending.kind}`);
    if (patch.localServer !== undefined) patch = { ...patch, localServer: cloneLocalServer(patch.localServer) };
    Object.assign(this, patch);
    this.emit('change', this.snapshot('launcher'));
    return this;
  }

  begin(kind, extra = {}) {
    const mode = kind === 'local' ? 'starting-local' : kind === 'official-login' ? 'awaiting-official-login' : 'connecting';
    return this.set({ mode, pending: { kind, startedAt: Date.now(), ...extra }, progress: null, error: null });
  }

  step(step, total, label) { return this.set({ progress: { step, total, label } }); }

  connected({ target, instance, profile }) {
    return this.set({ mode: 'connected', target, instance, profile, pending: null, progress: null, error: null });
  }

  fail(message, { kind = null, retry = null } = {}) {
    // 连接失败后启动页需要重新获得信任，因此 target 必须清空。
    return this.set({ mode: 'error', target: null, pending: null, progress: null, error: { message: String(message || '未知错误'), kind, retry } });
  }

  reset() {
    return this.set({ mode: 'idle', target: null, instance: null, profile: null, pending: null, progress: null, error: null });
  }

  isBusy() { return ['starting-local', 'connecting', 'awaiting-official-login'].includes(this.mode); }

  snapshot(audience = 'launcher') {
    const base = {
      mode: this.mode,
      target: this.target,
      runtime: this.instance?.runtime || (this.localServer.ready ? 'desktop-local' : null),
      edition: this.instance?.edition || null,
      profile: this.profile ? { id: this.profile.id, name: this.profile.name, mode: this.profile.mode || null, lastConnectedAt: this.profile.lastConnectedAt || null } : null,
      theme: this.theme,
      language: this.language
    };
    if (audience === 'remoteConsole') {
      return { mode: base.mode, target: base.target, edition: base.edition, runtime: base.runtime, profile: base.profile ? { name: base.profile.name } : null, theme: base.theme, language: base.language };
    }
    return {
      ...base,
      auth: this.instance?.auth || null,
      capabilities: this.instance?.capabilities || {},
      protocolVersion: this.instance?.protocolVersion || null,
      localProfile: this.localProfile ? { id: this.localProfile.id, displayName: this.localProfile.displayName || null, localIdentityId: this.localProfile.localIdentityId || null } : null,
      localServer: { ...this.localServer },
      pending: this.pending ? { ...this.pending } : null,
      progress: this.progress ? { ...this.progress } : null,
      error: this.error ? { ...this.error } : null,
      prefill: this.prefill ? { ...this.prefill } : null
    };
  }
}

module.exports = { AppState, MODES, PENDING_KINDS };
