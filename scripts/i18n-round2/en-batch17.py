#!/usr/bin/env python3
"""Batch 17: EN translations — remaining round-2 keys, part 2 of 3."""
import json
from pathlib import Path

ROOT = Path('/data/CrewRouter')
EN_PATH = ROOT / 'lang' / 'en.json'
en = json.loads(EN_PATH.read_text(encoding='utf-8'))

M = {
    "日均 ¥": "Daily avg ¥",
    "供应商 ": "Provider ",
    "Git率": "Git rate",
    "项目/工作区": "Project / workspace",
    "来源": "Source",
    "[Chart] update 失败，回退重建:": "[Chart] update failed — rebuilding:",
    "平均Token/请求": "Avg tokens/request",
    "未分配": "Unassigned",
    "暂无成员用量数据": "No member usage data",
    "暂无 Team 用量数据": "No team usage data",
    "暂无用户组用量数据": "No group usage data",
    "加载错误记录...": "Loading error records...",
    "加载错误记录失败:": "Failed to load error records:",
    "时间": "Time",
    "上游模型 ID": "Upstream model ID",
    "错误类型": "Error type",
    "是否最终错误": "Final error?",
    "是（返回客户端）": "Yes (returned to client)",
    "否（队列回退中间失败）": "No (intermediate queue fallback)",
    "加载调用记录...": "Loading call records...",
    "点击查看详情": "Click for details",
    "加载调用记录失败:": "Failed to load call records:",
    "导出调用记录失败:": "Failed to export call records:",
    "加载用量详情失败:": "Failed to load usage details:",
    "消息数量": "Message count",
    "元数据消息索引": "Metadata message index",
    "工作区路径": "Workspace path",
    "操作系统": "OS",
    "Git/JJ 状态": "Git/JJ status",
    "· 调用状态（近 24 小时）": "· uptime (last 24h)",
    "· 成功": " · success",
    "/ 失败": "/ failed",
    "（再次点击打开工具菜单）": " (click again for the tools menu)",
    "请选择模型，将单独绑定到": "Pick a model to bind individually to",
    "已清除": "Cleared",
    "的单独绑定，将跟随默认": "'s individual binding — following default now",
    "（点击打开菜单）": " (click to open menu)",
    "已绑定：": "Bound: ",
    "已为": "Bound",
    "绑定：": "to:",
    "(费率": "(fee ",
    "确认为该用户退款 ¥": "Confirm refunding ¥",
    "？系统将按手续费从高到低扣除。": " for this user? Deductions are taken from the highest-fee keys first.",
    "退款成功！实际扣除 ¥": "Refund succeeded! Actually deducted ¥",
    "，新可退款余额 ¥": ", new refundable balance ¥",
    "个模型 ·": " models ·",
    "个供应商（展开后加载）": " providers (loaded on expand)",
    "加载失败 (": "Load failed (",
    "将测试": "This will test",
    "个模型，可能较久，是否继续？": " models — it may take a while. Continue?",
    "选中模型": "selected models",
    "批量": "bulk",
    "模型失败:": "models failed:",
    "匹配": "matched",
    "个 · 本页": " · this page",
    "正在查询": "Querying",
    "个供应商额度…": " provider quotas…",
    "已停止 · 成功": "stopped · success",
    "· 剩余未处理": " · remaining unprocessed",
    "正在同步": "Syncing",
    "启": "enabled",
    "禁": "disabled",
    "上游": "upstream",
    "完成 · 成功": "done · success",
    "· 新增": " · new",
    "· 启用": " · enabled",
    "· 禁用": " · disabled",
    "获取模型失败 (": "Failed to fetch models (",
    "同步失败 (": "Sync failed (",
    "个代理未显示（共": " proxies not shown (of",
    "✅ 成功导入": "✅ Imported",
    "个代理": "proxies",
    "✅ 成功添加": "✅ Added",
    "供应商已删除，并清理了": "Provider deleted along with",
    "个关联模型": "linked models",
    "[获取模型] 请求: GET": "[Fetch models] Request: GET",
    "[获取模型] 响应: status=": "[Fetch models] Response: status=",
    "尝试": "attempt",
    "状态:": "status:",
    "错误:": "error:",
    "响应预览:": "response preview:",
    "成功! 模型数:": "Success! Model count:",
    "成功路径:": "Successful path:",
    "[获取模型] 失败:": "[Fetch models] Failed:",
}

n = 0
for k, v in M.items():
    if k in en and en[k] == k:
        en[k] = v
        n += 1

EN_PATH.write_text(json.dumps(en, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(f'{n}/{len(M)} filled; remaining: {sum(1 for k in en if en[k] == k)}')
