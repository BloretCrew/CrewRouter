#!/usr/bin/env python3
"""Batch 9: EN translations — provider page, sync, proxies, key refresh."""
import json
from pathlib import Path

ROOT = Path('/data/CrewRouter')
EN_PATH = ROOT / 'lang' / 'en.json'
en = json.loads(EN_PATH.read_text(encoding='utf-8'))

M = {
    "加载供应商详情失败，回退列表数据": "Failed to load provider details — falling back to list data",
    "供应商不存在，请刷新后重试": "Provider not found — refresh and try again",
    "主 Key：获取模型列表 / 连通性 / 额度": "Primary key: model list / connectivity / quota",
    "设为主 Key": "Set as primary",
    "显示 Key": "Show key",
    "隐藏 Key": "Hide key",
    "选择": "Select",
    "拖拽标签到卡片可分配": "Drag tags onto cards to assign",
    "当前页没有供应商": "No providers on this page",
    "本页": "This page",
    "选中": "Selected",
    "已有批量同步任务进行中": "A bulk sync is already running",
    "正在停止…": "Stopping…",
    "同步中...": "Syncing...",
    "再次同步": "Sync again",
    "同步中…": "Syncing…",
    "无变化": "No changes",
    "[批量同步] 失败": "[Bulk sync] Failed",
    "搜索供应商名称或 Base URL...": "Search provider name or base URL...",
    "正在加载供应商列表...": "Loading provider list...",
    "加载供应商索引失败:": "Failed to load provider index:",
    "网络错误": "Network error",
    "输入 API Key，可留空稍后编辑补全": "Enter the API key; leave blank to fill in later",
    "已添加（未填 API Key，可稍后在编辑中补全）": "Added (no API key yet — fill it in later when editing)",
    "添加失败: ": "Add failed: ",
    "供应商已添加": "Provider added",
    "请先输入供应商名称，再点击查询": "Enter a provider name before looking it up",
    "已填充供应商信息": "Provider info filled in",
    "未在 models.dev 中找到该供应商，可手动填写": "Provider not found on models.dev — fill in manually",
    "查询供应商信息失败:": "Failed to query provider info:",
    "查询失败": "Query failed",
    "请填写供应商名称和 API 地址": "Enter the provider name and API address",
    "脚本模式下必须填写密钥刷新脚本": "Key refresh script is required in script mode",
    "代理模式下请填写自定义代理地址，或勾选使用系统代理": "In proxy mode enter a custom address or tick \"use system proxy\"",
    "供应商已保存": "Provider saved",
    "保存供应商失败:": "Failed to save provider:",
    "手动添加的代理": "Manually added proxy",
    "开启「为所有连接使用代理」时请填写代理地址": "Fill in the proxy address when \"use proxy for all connections\" is on",
    "代理地址需以 http://、https://、socks4://、socks5:// 或 socks5h:// 开头": "Proxy address must start with http://, https://, socks4://, socks5:// or socks5h://",
    "代理设置已保存": "Proxy settings saved",
    "保存系统代理失败:": "Failed to save system proxy:",
    "加载全局代理池设置失败:": "Failed to load global proxy pool settings:",
    "代理池设置已保存": "Proxy pool settings saved",
    "保存全局代理池设置失败:": "Failed to save global proxy pool settings:",
    "请输入代理 URL": "Enter a proxy URL",
    "代理 URL 格式不正确，支持 http://, https://, socks4://, socks5://": "Invalid proxy URL. Supported: http://, https://, socks4://, socks5://",
    "该代理已存在": "This proxy already exists",
    "请输入代理列表 URL": "Enter a proxy list URL",
    "获取失败: ": "Fetch failed: ",
    "代理列表为空": "Proxy list is empty",
    "导入失败: ": "Import failed: ",
    "请输入代理地址": "Enter a proxy address",
    "订阅地址: 检测中...": "Subscription URL: checking...",
    "✅ 密钥刷新成功": "✅ Key refreshed",
    "[密钥刷新失败]": "[Key refresh failed]",
    "❌ 请求失败: ": "❌ Request failed: ",
    "[密钥刷新请求失败]": "[Key refresh request failed]",
    "自动选择（按系统可用模型）": "Auto-select (by available system models)",
    "选择 AI 辅助模型": "Pick AI assistant model",
    "搜索模型名称 / ID / 供应商...": "Search model name / ID / provider...",
    "无匹配模型": "No matching models",
    "暂无可用模型（需启用且供应商已配置 API Key）": "No models available (must be enabled with provider API key configured)",
    "脚本执行错误": "Script execution error",
    "AI 分析中...": "AI analyzing...",
    "AI 分析失败": "AI analysis failed",
    "🤖 让 AI 分析错误并给出修改建议": "🤖 Let AI analyze the error and suggest fixes",
    "✅ 分析完成": "✅ Analysis complete",
}

n = 0
for k, v in M.items():
    if k in en and en[k] == k:
        en[k] = v
        n += 1

EN_PATH.write_text(json.dumps(en, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(f'{n}/{len(M)} filled; remaining: {sum(1 for k in en if en[k] == k)}')
