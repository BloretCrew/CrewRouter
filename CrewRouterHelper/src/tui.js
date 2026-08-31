'use strict';
const readline = require('readline');
const { scanStatus, formatStatus } = require('./status');
const { summary } = require('./queue');
const { get } = require('./machine');
const { compatibility } = require('./compatibility');

function plainSnapshot(status) {
  const q = status.queue || summary();
  const lines = [formatStatus(status), `当前 profile: ${status.profile || 'default'}`, `链路: ${status.service?.level || 'UNKNOWN'} · 最近事件: ${status.stats?.last_event || '暂无'}`, `队列: ${q.count ?? '不可读'} · 死信: ${q.dead_letter_count || 0}`, `兼容性: ${compatibility().compatible ? '兼容' : '不兼容'}`, `机器: ${get().name} (${get().id})`];
  return lines.join('\n');
}
async function runTui(command, handlers = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    try { const status = await scanStatus(command); console.log(plainSnapshot(status)); }
    catch (err) { console.log(`CrewRouterHelper 状态: ERROR\n恢复提示: ${err.message || '检查失败'}`); }
    return;
  }
  let raw = false; let busy = false; let confirmAction = null;
  const render = async () => {
    process.stdout.write('\x1b[2J\x1b[H');
    try { console.log(plainSnapshot(await scanStatus(command))); }
    catch (err) { console.log(`CrewRouterHelper 状态: ERROR\n恢复提示: ${err.message || '检查失败'}`); }
    console.log('\n[r]刷新 [t]本地测试 [T]远程测试 [i]安装 [u]卸载 [q]退出');
    if (confirmAction) console.log(`确认执行 ${confirmAction}？按 y 确认，其他键取消`);
  };
  const run = async (action) => { if (busy) return; busy = true; try { await action(); } catch (err) { console.error(`操作失败：${err.message || '未知错误'}`); } finally { busy = false; await render(); } };
  await render(); readline.emitKeypressEvents(process.stdin);
  let resolveDone; const done = () => resolveDone?.();
  const onKey = (str, key = {}) => {
    if (busy) return;
    if (confirmAction) { const action = confirmAction; confirmAction = null; if (str.toLowerCase() === 'y') run(action); else render(); return; }
    if (str === 'q' || key.name === 'q' || (key.ctrl && key.name === 'c')) return done();
    const action = str === 'r' ? render : str === 't' ? handlers.localTest : str === 'T' ? handlers.remoteTest : null;
    if (str === 'i') return (confirmAction = handlers.install, render());
    if (str === 'u') return (confirmAction = handlers.uninstall, render());
    if (action) run(action);
  };
  try { process.stdin.setRawMode(true); raw = true; process.stdin.resume(); process.stdin.on('keypress', onKey); await new Promise(resolve => { resolveDone = resolve; }); }
  finally { process.stdin.removeListener('keypress', onKey); try { if (raw) process.stdin.setRawMode(false); } catch {} process.stdin.pause(); }
}
module.exports = { runTui, plainSnapshot };
