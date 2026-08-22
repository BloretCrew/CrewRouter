#!/usr/bin/env python3
"""Batch 12: EN translations — update flow, API key models, misc errors."""
import json
from pathlib import Path

ROOT = Path('/data/CrewRouter')
EN_PATH = ROOT / 'lang' / 'en.json'
en = json.loads(EN_PATH.read_text(encoding='utf-8'))

M = {
    "[Update] 静默检查官方版本…": "[Update] Silently checking the official version…",
    "[Update] 检查失败 HTTP": "[Update] Check failed HTTP",
    "[Update] 检查结果:": "[Update] Check result:",
    "[Update] checkUpdateBanner 异常:": "[Update] checkUpdateBanner exception:",
    "当前环境不支持一键更新": "One-click update isn't supported in this environment",
    "[Update] loadUpdatePanel 失败:": "[Update] loadUpdatePanel failed:",
    "检查中…": "Checking…",
    "正在检查更新…": "Checking for updates…",
    "[Update] 请求 /api/admin/update/check": "[Update] Requesting /api/admin/update/check",
    "[Update] 结果:": "[Update] Result:",
    "发现新版本": "New version available",
    "已是最新": "Up to date",
    "[Update] 检查更新失败:": "[Update] Check for updates failed:",
    "检查失败": "Check failed",
    "检查更新失败": "Failed to check for updates",
    "有可用更新": "Update available",
    "无需更新": "No update needed",
    "当前已是最新版本。": "You're already on the latest version.",
    "当前已是最新版本": "Already on the latest version",
    "无法更新": "Cannot update",
    "最新版": "Latest",
    "确认一键更新": "Confirm one-click update",
    "开始更新": "Start update",
    "[Update] 用户取消更新": "[Update] User cancelled update",
    "更新中…": "Updating…",
    "开始下载安装…": "Downloading and installing…",
    "[Update] apply 响应:": "[Update] apply response:",
    "安装完成，正在重启…": "Installed. Restarting…",
    "[Update] apply 请求结束:": "[Update] apply request finished:",
    "连接已断开，等待服务重启…": "Connection lost. Waiting for the service to restart…",
    "[Update] 状态轮询:": "[Update] Status polling:",
    "服务正在重启，请稍候…": "Service is restarting, please wait…",
    "[Update] 等待服务恢复，期望版本:": "[Update] Waiting for service recovery, expected version:",
    "[Update] 重启探测 /api/version:": "[Update] Probing /api/version after restart:",
    "更新完成": "Update complete",
    "[Update] 等待中…": "[Update] Waiting…",
    "等待超时：请手动刷新页面或检查服务是否已启动": "Timed out waiting. Refresh the page manually or check that the service has started",
    "请手动确认": "Please verify manually",
    "服务可能已更新并重启，但页面未能自动连上。请刷新页面或检查进程状态。": "The service may have updated and restarted, but this page couldn't reconnect automatically. Refresh or check the process status.",
    "请手动刷新页面确认更新结果": "Refresh the page manually to confirm the update result",
    "加载API密钥失败:": "Failed to load API keys:",
    "[标签] 加载失败:": "[Tags] Load failed:",
    "加载密钥模型列表失败:": "Failed to load key model list:",
    "保存密钥模型队列失败:": "Failed to save key model queue:",
    "保存密钥模型失败:": "Failed to save key models:",
    "[API Key 模型选择] 全局搜索失败:": "[API Key models] Global search failed:",
    "[API Key 模型选择] 渲染失败:": "[API Key models] Render failed:",
    "[API Key 模型选择] 加载供应商模型失败:": "[API Key models] Failed to load provider models:",
    "保存 Fusion 配置失败:": "Failed to save Fusion config:",
    "加载 Fusion 配置失败:": "Failed to load Fusion config:",
    "加载签名配置失败:": "Failed to load signature config:",
    "保存签名配置失败:": "Failed to save signature config:",
    "切换吞图失败:": "Failed to toggle image swallowing:",
    "切换额度预警失败:": "Failed to toggle quota alerts:",
    "切换 CrewRouter 指令失败:": "Failed to toggle CrewRouter commands:",
    "加载定时配置失败:": "Failed to load schedule config:",
    "保存定时配置失败:": "Failed to save schedule config:",
    "加载文档模型列表失败:": "Failed to load docs model list:",
    "加载统计筛选选项失败:": "Failed to load stats filter options:",
    "加载排行榜失败:": "Failed to load leaderboards:",
    "加载积分信息失败:": "Failed to load credit info:",
    "加载 2FA 状态失败:": "Failed to load 2FA status:",
    "生成 2FA 失败:": "Failed to generate 2FA:",
    "加载 PassKey 列表失败:": "Failed to load Passkey list:",
    "PassKey 注册失败:": "Passkey registration failed:",
    "加载当前模型失败:": "Failed to load current model:",
    "加载模型库失败:": "Failed to load model library:",
}

n = 0
for k, v in M.items():
    if k in en and en[k] == k:
        en[k] = v
        n += 1

EN_PATH.write_text(json.dumps(en, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(f'{n}/{len(M)} filled; remaining: {sum(1 for k in en if en[k] == k)}')
