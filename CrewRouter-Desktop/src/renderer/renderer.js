'use strict';

const api = window.crewrouterDesktop;
const statusEl = document.getElementById('status');
const introEl = document.getElementById('intro');
const urlEl = document.getElementById('remote-url');
const buttons = [...document.querySelectorAll('button')];
function setStatus(message, error = false) { statusEl.textContent = message; statusEl.classList.toggle('error', error); }
function busy(value) { buttons.forEach((button) => { button.disabled = value; }); }
function showError(error) { busy(false); setStatus(error?.message || '连接失败', true); }

document.getElementById('local').addEventListener('click', async () => { busy(true); setStatus('正在启动本地服务…'); try { await api.chooseMode('local'); } catch (error) { showError(error); } });
document.getElementById('remote').addEventListener('click', async () => { busy(true); setStatus('正在检查远程服务器…'); try { await api.connectRemote(urlEl.value); } catch (error) { showError(error); } });
document.getElementById('quit').addEventListener('click', () => api.quit());
api.onStatus((status) => { if (status?.error) showError(new Error(status.error)); else if (status?.message) setStatus(status.message); });
api.getStatus().then((status) => { if (status?.mode) introEl.textContent = `当前模式：${status.mode}`; }).catch(() => {});
