#!/usr/bin/env python3
"""Batch 16: EN translations — remaining round-2 keys, part 1 of 3."""
import json
from pathlib import Path

ROOT = Path('/data/CrewRouter')
EN_PATH = ROOT / 'lang' / 'en.json'
en = json.loads(EN_PATH.read_text(encoding='utf-8'))

M = {
    "/home/你的用户名/.codex/auth.json": "/home/<your-username>/.codex/auth.json",
    "测试此供应商下当前筛选模型": "Test filtered models of this provider",
    "加载供应商列表失败": "Failed to load provider list",
    "AI 修复中...": "AI fixing...",
    "AI 修复失败": "AI fix failed",
    "🔧 让 AI 修复错误": "🔧 Let AI fix the error",
    "✅ 修复完成": "✅ Fix complete",
    "✅ AI 已修复脚本，请检查后保存": "✅ AI fixed the script — review and save",
    "Token 请求失败: ": "Token request failed: ",
    "登录失败: ": "Login failed: ",
    "密钥获取失败: HTTP ": "Key fetch failed: HTTP ",
    "轮换失败: ": "Rotation failed: ",
    "文档已复制到剪贴板": "Docs copied to clipboard",
    "复制失败": "Copy failed",
    "已开启额度查询": "Quota query enabled",
    "已关闭额度查询": "Quota query disabled",
    "操作失败: ": "Operation failed: ",
    "查询中...": "Querying...",
    "查询额度": "Query quota",
    "删除供应商": "Delete provider",
    "确认删除": "Confirm delete",
    "删除供应商失败:": "Failed to delete provider:",
    "[获取模型] 请求尝试详情": "[Fetch models] Attempt details",
    "获取失败": "Fetch failed",
    "未获取到模型": "No models fetched",
    "获取供应商模型失败:": "Failed to fetch provider models:",
    "网络错误: ": "Network error: ",
    "没有可清理的已下架模型": "No delisted models to clean up",
    "确认清理": "Confirm cleanup",
    "清理中...": "Cleaning up...",
    "清理失败": "Cleanup failed",
    "清理已下架模型失败:": "Delisted model cleanup failed:",
    "清理失败: ": "Cleanup failed: ",
    "清理任务进行中，请稍候": "Cleanup in progress, please wait",
    "拉取失败的供应商会": "Providers whose fetch failed will be",
    "跳过": "skipped",
    "开始清理": "Start cleanup",
    "清理全部已下架模型失败:": "Full delisted-model cleanup failed:",
    "禁用全部模型？": "Disable all models?",
    "确认禁用全部": "Disable all",
    "保存成功：": "Saved: ",
    "当前周期": "Current period",
    "按需额度上限": "On-demand quota cap",
    "按需已使用": "On-demand used",
    "统一周池计费": "Unified weekly pool billing",
    "额外购买余额": "Extra purchased balance",
    "旧版月额度": "Legacy monthly quota",
    "重置失败: ": "Reset failed: ",
    "SuperGrok 使用 ~/.grok/auth.json 查询订阅周池、按需额度和 prepaid credits，接口为非公开接口，字段可能变化": "SuperGrok queries the subscription weekly pool, on-demand quota and prepaid credits via ~/.grok/auth.json. Unofficial endpoint; fields may change.",
    "/home/你的用户名/.grok/auth.json": "/home/<your-username>/.grok/auth.json",
    "JSON 格式错误: ": "Invalid JSON: ",
    "绑定失败": "Linking failed",
    "绑定失败: ": "Linking failed: ",
    "请输入供应商名称": "Enter the provider name",
    "请输入或上传配置内容": "Enter or upload the config content",
    "未识别的配置格式": "Unrecognized config format",
    "导入失败": "Import failed",
    "导入 OpenCode 配置失败:": "Failed to import OpenCode config:",
    "多维统计筛选项加载失败": "Failed to load analytics filters",
    "多维统计加载失败": "Failed to load analytics",
    "总请求": "Total requests",
    "总积分": "Total credits",
    "活跃成员": "Active members",
    "模型 / 供应商": "Model / provider",
    "暂无关联数据": "No related data",
    "未知成员": "Unknown member",
    "未分配 Team": "No team assigned",
    "未分配用户组": "No group assigned",
    "未识别项目": "Unidentified project",
    "加载统计数据失败:": "Failed to load statistics:",
    "加载统计数据失败": "Failed to load statistics",
}

n = 0
for k, v in M.items():
    if k in en and en[k] == k:
        en[k] = v
        n += 1

EN_PATH.write_text(json.dumps(en, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(f'{n}/{len(M)} filled; remaining: {sum(1 for k in en if en[k] == k)}')
