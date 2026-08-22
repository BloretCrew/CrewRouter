#!/usr/bin/env python3
"""Repair pass 6: manual targeted fixes for the remaining audit-final leftovers.

Each entry: (file, old_snippet, new_snippet). Applied verbatim; syntax-checked.
Keys auto-added to lang catalogs.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path('/data/CrewRouter')
ZH_PATH = ROOT / 'lang' / 'zh.json'
EN_PATH = ROOT / 'lang' / 'en.json'
ZH = json.loads(ZH_PATH.read_text(encoding='utf-8'))
EN = json.loads(EN_PATH.read_text(encoding='utf-8'))


def add_key(k):
    ZH.setdefault(k, k)
    EN.setdefault(k, EN.get(k, k))


FIXES = {
    'app.js': [
        # L3571 confirm() with escaped newline + quotes
        (
            "return confirm('模型测试将发送一条真实请求（\"Hi\"，max_tokens=5）到该模型，\\n并按照正常用量扣除积分。是否继续？');",
            "return confirm(t('模型测试将发送一条真实请求（\"Hi\"，max_tokens=5）到该模型，\\n并按照正常用量扣除积分。是否继续？'));",
        ),
        # L3317 nested-quote 暂无数据 (inside single-quoted fallback of ${rows || '...'})
        (
            "${rows || '<tr><td colspan=\"4\" style=\"text-align:center;padding:18px;color:var(--muted-foreground);\">暂无数据</td></tr>'}",
            "${rows || ('<tr><td colspan=\"4\" style=\"text-align:center;padding:18px;color:var(--muted-foreground);\">' + t('暂无数据') + '</td></tr>')}",
        ),
        # L2277 加载失败，重试 (nested quotes)
        (
            "加载失败，<a href=\"#\" onclick=\"event.preventDefault();app.retryKeyModelPickerProviderModels",
            "${t('加载失败，')}<a href=\"#\" onclick=\"event.preventDefault();app.retryKeyModelPickerProviderModels",
        ),
        # L5390 暂无共同成员
        (
            "'<p class=\"api-key-sub-muted\" style=\"text-align:center;padding:18px;\">暂无共同成员</p>'",
            "'<p class=\"api-key-sub-muted\" style=\"text-align:center;padding:18px;\">' + t('暂无共同成员') + '</p>'",
        ),
        # L5457 详情 summary
        (
            "<summary style=\"font-size:12px;color:var(--muted-foreground);cursor:pointer;\">详情</summary>",
            "<summary style=\"font-size:12px;color:var(--muted-foreground);cursor:pointer;\">${t('详情')}</summary>",
        ),
    ],
    'admin.js': [
        # L1953 · N 启用 (template with expr mid-text)
        (
            "` · ${enabled} 启用`",
            "` · ${enabled} ${t('启用')}`",
        ),
        # L2980 ternary button labels
        (
            "${provider.enabled ? '禁用供应商' : '启用供应商'}",
            "${provider.enabled ? t('禁用供应商') : t('启用供应商')}",
        ),
        # L3038 broken empty ${} from earlier repair — restore proper structure
        (
            "<span style=\"color:#f59e0b;font-size:12px;\" title=\"${}${hasError ? '\\n上次错误: ' + escapeHtml(lastError) : ''}",
            "<span style=\"color:#f59e0b;font-size:12px;\" title=\"${t('脚本刷新模式')}${hasError ? '\\n' + t('上次错误: ') + escapeHtml(lastError) : ''}",
        ),
        # L3040 weight/sequence mode ternary in attr
        (
            "${provider.api_key_select_mode === 'weight' ? '权重模式' : '顺序模式'}",
            "${provider.api_key_select_mode === 'weight' ? t('权重模式') : t('顺序模式')}",
        ),
        # L3176 broken nested badge html swallowed into t()
        (
            "${'<span class=\"provider-api-key-main-badge\" title=t(\\'主 Key：获取模型列表 / 连通性 / 额度\\')>主 Key</span>'}",
            "<span class=\"provider-api-key-main-badge\" title=\"${t('主 Key：获取模型列表 / 连通性 / 额度')}\">${t('主 Key')}</span>",
        ),
        # L3180 key enable/disable
        (
            "${enabled ? '禁用此 Key' : '启用此 Key'}",
            "${enabled ? t('禁用此 Key') : t('启用此 Key')}",
        ),
        # L3184 drag hint
        (
            "${multi ? '拖动排序' : '仅 1 个 Key 时无需排序'}",
            "${multi ? t('拖动排序') : t('仅 1 个 Key 时无需排序')}",
        ),
        # L3188 configured state
        (
            "${item.key ? (enabled ? '已配置，可修改' : '已禁用') : 'API Key'}",
            "${item.key ? (enabled ? t('已配置，可修改') : t('已禁用')) : 'API Key'}",
        ),
        # L1456 / L2200 test_error fallback 失败 inside escapeHtml concat — wrap the literal
        (
            "(model.test_error || '失败') + ' · '",
            "(model.test_error || t('失败')) + ' · '",
        ),
    ],
    'playground.js': [],
}


def main():
    for name, fixes in FIXES.items():
        p = ROOT / 'public' / 'js' / name
        src = p.read_text(encoding='utf-8')
        backup = src
        n = 0
        for old, new in fixes:
            if old in src:
                src = src.replace(old, new)
                n += 1
            else:
                print(f"  MISS {name}: {old[:60]!r}")
        p.write_text(src, encoding='utf-8')
        check = subprocess.run(['node', '--check', str(p)], capture_output=True, text=True)
        if check.returncode != 0:
            p.write_text(backup, encoding='utf-8')
            print(f"{name}: SYNTAX ERROR reverted: {check.stderr[:300]}")
            sys.exit(1)
        print(f"{name}: {n}/{len(fixes)} applied")

    # collect keys used in fixes
    for name, fixes in FIXES.items():
        for _, new in fixes:
            for m in re.finditer(r"""\bt\('((?:[^'\\]|\\.)*)'\)""", new):
                raw = m.group(1).replace("\\'", "'")
                if re.search(r'[\u4e00-\u9fff]', raw):
                    add_key(raw)
    ZH_PATH.write_text(json.dumps(ZH, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    EN_PATH.write_text(json.dumps({k: EN.get(k, k) for k in ZH}, ensure_ascii=False, indent=2) + '\n',
                       encoding='utf-8')
    print(f"zh={len(ZH)}")


if __name__ == '__main__':
    main()
