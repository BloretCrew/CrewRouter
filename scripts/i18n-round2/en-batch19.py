#!/usr/bin/env python3
"""Batch 19: EN translations — final 150 keys."""
import json
from pathlib import Path

ROOT = Path('/data/CrewRouter')
EN_PATH = ROOT / 'lang' / 'en.json'
en = json.loads(EN_PATH.read_text(encoding='utf-8'))

M = {
    "已读取": "Read",
    "未出现": "Not seen",
    "项目布局": "Project layout",
    "设置已保存": "Settings saved",
    "配置文件/环境变量（尚未在后台保存）": "Config file / env vars (not yet saved in the panel)",
    "脚本刷新": "Script refresh",
    "[用户组] 开始加载用户组列表": "[Groups] Loading group list",
    "加载用户组...": "Loading groups...",
    "[用户组] API 响应状态:": "[Groups] API response status:",
    "[用户组] 获取到用户组数据:": "[Groups] Group data received:",
    "[用户组] 加载用户组列表失败:": "[Groups] Failed to load group list:",
    "[用户组] 渲染用户组列表, 数量:": "[Groups] Rendering group list, count:",
    "[用户组] 找不到 userGroupsList 容器": "[Groups] userGroupsList container not found",
    "[用户组] 创建按钮元素:": "[Groups] Create button element:",
    "[用户组] 创建按钮被点击": "[Groups] Create button clicked",
    "[用户组] 创建按钮事件已绑定": "[Groups] Create button event bound",
    "[用户组] 找不到 createUserGroupBtn 按钮": "[Groups] createUserGroupBtn button not found",
    "[用户组] 打开创建用户组弹窗": "[Groups] Opening create-group dialog",
    "[用户组] 弹窗已显示:": "[Groups] Dialog shown:",
    "[用户组] 确认按钮:": "[Groups] Confirm button:",
    "[用户组] 确认创建按钮被点击": "[Groups] Confirm-create button clicked",
    "[用户组] 输入数据:": "[Groups] Input data:",
    "[用户组] 发送创建请求...": "[Groups] Sending create request...",
    "[用户组] 创建响应状态:": "[Groups] Create response status:",
    "[用户组] 创建失败:": "[Groups] Create failed:",
    "[用户组] 创建成功": "[Groups] Created successfully",
    "[用户组] 创建请求异常:": "[Groups] Create request exception:",
    "加载用户组规则失败:": "Failed to load group rules:",
    "历史周期": "Historical periods",
    "次 ·": " times · ",
    "# Hermes (OpenAI 兼容) → CrewRouter\\nOPENAI_BASE_URL=": "# Hermes (OpenAI-compatible) → CrewRouter\\nOPENAI_BASE_URL=",
    "\\n# model: claude-fable-5\\n# 也可写入 ~/.hermes/config.json:\\n# { \\\"providers\\\": { \\\"crewrouter\\\": { \\\"baseUrl\\\": \\\"": "\\n# model: claude-fable-5\\n# You can also add it to ~/.hermes/config.json:\\n# { \\\"providers\\\": { \\\"crewrouter\\\": { \\\"baseUrl\\\": \\\"",
    "行": "rows",
    "项 · 成功": " items · success",
    "· 失败": " · failed",
    "确定要删除选中的": "Delete the selected",
    "个供应商吗？关联的模型也会被删除。": " providers? Their linked models will be deleted too.",
    "失败:": "failed:",
    "已删除": "Deleted",
    "个供应商": " providers",
    "已检测": "Detected",
    "个新模型（共": " new models (of ",
    "个新模型": " new models",
    "个模型吗？": " models?",
    "确定要": "Confirm ",
    "选中的": "selected",
    "已": "already ",
    "已更新": "Updated",
    "个模型的价格": " models' prices",
    "个模型吗？此操作不可撤销。": " models? This cannot be undone.",
    "已选择": "Selected",
    "清除全部隐藏偏好（供应商": "Clear all hidden preferences (providers",
    "/ 模型": "/ models",
    "已隐藏供应商「": "Provider \u201c",
    "已显示供应商「": "Provider \u201c",
    "已隐藏模型「": "Model \u201c",
    "已显示模型「": "Model \u201c",
}

n = 0
for k, v in M.items():
    if k in en and en[k] == k:
        en[k] = v
        n += 1

EN_PATH.write_text(json.dumps(en, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(f'{n}/{len(M)} filled; remaining: {sum(1 for k in en if en[k] == k)}')
