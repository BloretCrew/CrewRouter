#!/usr/bin/env python3
"""Batch 20: EN translations — the last 93 keys."""
import json
from pathlib import Path

ROOT = Path('/data/CrewRouter')
EN_PATH = ROOT / 'lang' / 'en.json'
en = json.loads(EN_PATH.read_text(encoding='utf-8'))

M = {
    "启用此 Key": "Enable this key",
    "拖动排序": "Drag to sort",
    "仅 1 个 Key 时无需排序": "Only 1 key — no sorting needed",
    "已配置，可修改": "Configured, editable",
    "使用系统全局代理池": "Use the system-wide proxy pool",
    "复制工作区路径\\\\": "Copy workspace path\\\\",
    "将以下 JSON 写入 <code>~/.claude/settings.json</code> 即可使用 CrewRouter 作为 API 代理": "Write this JSON into <code>~/.claude/settings.json</code> to use CrewRouter as your API proxy",
    "将以下内容写入 <code>~/.codex/config.toml</code>，然后重启 Codex CLI": "Write the following into <code>~/.codex/config.toml</code>, then restart Codex CLI",
    "将以下 JSON 写入项目根目录的 <code>opencode.json</code> 中": "Write this JSON into <code>opencode.json</code> in your project root",
    "将以下内容写入 <code>~/.grok/config.toml</code>，然后重启 Grok Build": "Write the following into <code>~/.grok/config.toml</code>, then restart Grok Build",
    "将以下内容写入 <code>~/.dsh/settings.yaml</code>": "Write the following into <code>~/.dsh/settings.yaml</code>",
    "将以下 JSON 写入 <code>~/.qwen/settings.json</code>（或对应 OpenAI 兼容配置），然后重启 Qwen Code": "Write this JSON into <code>~/.qwen/settings.json</code> (or the equivalent OpenAI-compatible config), then restart Qwen Code",
    "设置环境变量 <code>OPENAI_BASE_URL / OPENAI_API_KEY</code>": "Set environment variables <code>OPENAI_BASE_URL / OPENAI_API_KEY</code>",
    "<code>~/.hermes/config.json</code> 的 OpenAI 兼容段": "the OpenAI-compatible section of <code>~/.hermes/config.json</code>",
    "将以下 JSON 合并到 <code>~/.openclaw/openclaw.json</code> 的 providers 段": "Merge this JSON into the providers section of <code>~/.openclaw/openclaw.json</code>",
    "项请求": " requests",
    '<tr><td colspan="6">暂无事件</td></tr>': '<tr><td colspan="6">No events</td></tr>',
    "个结果": " results",
    "；其它工具仍用默认绑定": "; other tools keep their default binding",
    "个key": " keys",
    "在「更多」中查询或使用顶部「刷新本页额度」": "Check via \"More\" or \"Refresh quotas on this page\" at the top",
    "使用系统设置中的代理": "Use the proxy from system settings",
    "手动添加的代理\\\\": "Manually added proxy\\\\",
    "\\\\n过期时间: ": "\\\\nExpires: ",
    "确定要删除此供应商吗？<br><br><strong style=\"color:var(--destructive);\">": "Delete this provider? <br><br><strong style=\"color:var(--destructive);\">",
    "</strong>，并清理 Team 绑定、API Key 模型绑定等关联数据。此操作不可撤销。": "</strong>, along with team bindings, API key model bindings and other linked data. This cannot be undone.",
    "\\\\n\\\\n尝试过的路径:\\\\n": "\\\\n\\\\nPaths tried:\\\\n",
    "将依次从<strong>": "Models will be compared against each provider's upstream in turn from ",
    "</strong>本地已下架的模型记录（含 Team / API Key 绑定等关联数据）。": " and local records of delisted models will be removed (including team / API key bindings).",
    "</strong>（不会误删）。此操作可能耗时较长，且不可撤销。": " (nothing else is deleted). This may take a while and cannot be undone.",
    "当前<strong>": "Currently ",
    "</strong>。确定继续吗？": "</strong>. Continue?",
    "// 获取默认脚本失败:": "// Failed to get default script:",
    "文件通常位于 <code>~/.grok/auth.json</code>": "The file is usually at <code>~/.grok/auth.json</code>",
    "</code>。Token 会保存到当前供应商，请勿上传给第三方。": "</code>. Tokens are stored for this provider — never share them with third parties.",
    "文件通常位于 <code>~/.codex/auth.json</code>": "The file is usually at <code>~/.codex/auth.json</code>",
    "请输入或上传 auth.json": "Enter or upload auth.json",
    "配额内免费": "Free within quota",
    "添加标签\\\\": "Add tag\\\\",
    "）。建议在系统设置中一键更新。": "). One-click update in System settings is recommended.",
    "\\\\n\\\\n*[已停止]*": "\\\\n\\\\n*[Stopped]*",
    "加载中\\\\": "Loading\\\\",
    "过期时间: ": "Expires: ",
    "尝试过的路径:": "Paths tried:",
    "，已失效": ", delisted: ",
    "，重置于": ", resets at ",
    "可手动重置：": "Manual reset: ",
    "本地已下架的模型记录（含 Team / API Key 绑定等关联数据）。": "local records of delisted models (including team / API key bindings).",
    "。确定继续吗？": ". Continue?",
    "，并清理 Team 绑定、API Key 模型绑定等关联数据。此操作不可撤销。": ", plus team bindings, API key model bindings and other linked data. This cannot be undone.",
    "（约": "(~",
    "小时后）": "h)",
    "将以下 JSON 写入": "Write this JSON into ",
    "即可使用 CrewRouter 作为 API 代理": " to use CrewRouter as your API proxy",
    "将以下内容写入": "Write the following into ",
    "，然后重启 Codex CLI": ", then restart Codex CLI",
    "将以下 JSON 写入项目根目录的": "Write this JSON into ",
    "，然后重启 Grok Build": ", then restart Grok Build",
    "（或对应 OpenAI 兼容配置），然后重启 Qwen Code": " (or the equivalent OpenAI-compatible config), then restart Qwen Code",
    "将以下 JSON 合并到": "Merge this JSON into ",
    "的 providers 段": "'s providers section",
    "展开余下的": "Expand remaining",
    '模型测试将发送一条真实请求（"Hi"，max_tokens=5）到该模型，\\n并按照正常用量扣除积分。是否继续？': 'This sends a real request ("Hi", max_tokens=5) to the model, \\nand credits are deducted as usual. Continue?',
    "启用供应商": "Enable provider",
    "禁用供应商": "Disable provider",
    "脚本刷新模式": "Script refresh mode",
    "上次错误: ": "Last error: ",
    "禁用此 Key": "Disable this key",
}

n = 0
for k, v in M.items():
    if k in en and en[k] == k:
        en[k] = v
        n += 1

EN_PATH.write_text(json.dumps(en, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(f'{n}/{len(M)} filled; remaining: {sum(1 for k in en if en[k] == k)}')
