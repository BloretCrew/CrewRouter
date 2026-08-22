#!/usr/bin/env python3
"""Batch 11: EN translations — groups/teams management, update, model test."""
import json
from pathlib import Path

ROOT = Path('/data/CrewRouter')
EN_PATH = ROOT / 'lang' / 'en.json'
en = json.loads(EN_PATH.read_text(encoding='utf-8'))

M = {
    "例如：VIP用户": "e.g. VIP users",
    "可选描述": "Optional description",
    "1 小时": "1 hour",
    "5 小时": "5 hours",
    "次请求": "requests",
    "小时数": "Hours",
    "限额": "Limit",
    "确定删除此规则？": "Delete this rule?",
    "请输入有效的小时数": "Enter valid hours",
    "请输入有效的限额": "Enter a valid limit",
    "加载用户组成员失败:": "Failed to load group members:",
    "确定移除此成员？": "Remove this member?",
    "请选择用户": "Select a user",
    "用户组不存在": "Group not found",
    "编辑用户组": "Edit group",
    "加载用户组信息失败": "Failed to load group info",
    "确定删除此用户组？成员将被移除但不会被删除。": "Delete this group? Members will be removed but not deleted.",
    "加载 Team...": "Loading teams...",
    "加载 Team 列表失败:": "Failed to load team list:",
    "暂无描述": "No description",
    "点击展开": "Click to expand",
    "点击折叠": "Click to collapse",
    "例如：研发组": "e.g. R&D team",
    "取消默认": "Unset default",
    "更新默认按钮状态失败:": "Failed to update default button state:",
    "取消前沿": "Unset frontier",
    "更新前沿按钮状态失败:": "Failed to update frontier button state:",
    "加载 Team 成员失败:": "Failed to load team members:",
    "获取成员列表失败": "Failed to get member list",
    "获取用户列表失败": "Failed to get user list",
    "加载用户列表失败: ": "Failed to load user list: ",
    "加载 Team 模型失败:": "Failed to load team models:",
    "本供应商模型均未启用": "No models of this provider are enabled",
    "本供应商模型已全部启用": "All models of this provider are enabled",
    "本供应商模型部分启用": "Some models of this provider are enabled",
    "一键启用该供应商下全部模型": "Enable all models of this provider",
    "一键禁用该供应商下全部模型": "Disable all models of this provider",
    "请先选择 Team": "Pick a team first",
    "批量操作失败": "Bulk operation failed",
    "该供应商下没有可操作的模型": "No actionable models under this provider",
    "当前筛选结果为空": "Current filter returned no results",
    "例如：claude、gpt-4、gemini": "e.g. claude, gpt-4, gemini",
    "按名称批量启用/禁用": "Bulk enable/disable by name",
    "请输入名称关键字": "Enter a name keyword",
    "没有匹配的模型": "No matching models",
    "Team 不存在": "Team not found",
    "编辑 Team": "Edit team",
    "加载 Team 信息失败": "Failed to load team info",
    "确定删除此 Team？成员将被移除但不会被删除。": "Delete this team? Members will be removed but not deleted.",
    "[模型测试] modelId 为空": "[Model test] modelId is empty",
    "模型 ID 为空": "Model ID is empty",
    "请先选择要测试的模型": "Pick models to test first",
    "点击筛选 · 拖拽到供应商分配 · 铅笔编辑": "Click to filter · drag onto providers to assign · pencil to edit",
    "删除标签": "Delete tag",
    "添加标签": "Add tag",
    "未能识别拖拽的标签，请重试": "Couldn't recognize the dragged tag — try again",
    "[供应商标签] toggle 失败:": "[Provider tags] toggle failed:",
    "确定删除此标签？供应商上已有的该标签也会被移除。": "Delete this tag? It will also be removed from providers using it.",
}

n = 0
for k, v in M.items():
    if k in en and en[k] == k:
        en[k] = v
        n += 1

EN_PATH.write_text(json.dumps(en, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(f'{n}/{len(M)} filled; remaining: {sum(1 for k in en if en[k] == k)}')
