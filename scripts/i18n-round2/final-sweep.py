#!/usr/bin/env python3
"""Final sweep: the true last batch of admin.js/app.js leftovers."""
from pathlib import Path
import json, re, subprocess

ROOT = Path('/data/CrewRouter')
ZH = json.loads((ROOT/'lang/zh.json').read_text(encoding='utf-8'))
EN = json.loads((ROOT/'lang/en.json').read_text(encoding='utf-8'))

def add(k):
    k = k.strip()
    if k and re.search(r'[\u4e00-\u9fff]', k):
        ZH.setdefault(k, k); EN.setdefault(k, EN.get(k, k))

def apply(fname, fixes):
    p = ROOT / 'public/js' / fname
    src = p.read_text(encoding='utf-8')
    backup = src
    n = 0
    for old, new in fixes:
        if old not in src:
            continue
        idx = src.find(old)
        ls = src.rfind('\n', 0, idx)
        le = src.find('\n', idx)
        line = src[ls:le]
        has_tpl = '`' in line
        uses_expr = '${' in new
        if uses_expr and not has_tpl:
            # convert ${t('x')} → ' + t('x') + ' for concat lines
            new2 = re.sub(r"\$\{t\('([^']*)'\)\}", r"' + t('\1') + '", new)
            # collapse dangling quote pairs: '' + at edges
            new2 = new2.replace("'' + ", "").replace(" + ''", "")
            src = src.replace(old, new2)
        else:
            src = src.replace(old, new)
        n += 1
        for m in re.finditer(r"t\('([^']*[\u4e00-\u9fff][^']*)'\)", new):
            add(m.group(1))
    if n:
        p.write_text(src, encoding='utf-8')
        c = subprocess.run(['node', '--check', str(p)], capture_output=True, text=True)
        if c.returncode != 0:
            p.write_text(backup, encoding='utf-8')
            print(f'{fname}: SYNTAX ERROR reverted: {c.stderr[:250]}')
            return 0
    print(f'{fname}: {n} applied')
    return n

total = 0
total += apply('admin.js', [
    # L5431 tail (concat line)
    ("'</strong>，并清理 Team 绑定、API Key 模型绑定等关联数据。此操作不可撤销。'",
     "'</strong>' + t('，并清理 Team 绑定、API Key 模型绑定等关联数据。此操作不可撤销。')"),
    # L5589: template with broken ${} prefix
    ("`${}<strong style=\"color:var(--destructive);\">永久删除</strong>本供应商下 <strong>",
     "`<strong style=\"color:var(--destructive);\">${t('永久删除')}</strong>${t('本供应商下')} <strong>"),
    # L5994 （约 N 小时后）
    ("`（约 ${Math.ceil(period.resetAfterSeconds / 3600)} 小时后）`",
     "`${t('（约')} ${Math.ceil(period.resetAfterSeconds / 3600)} ${t('小时后）')}`"),
    # L6061 剩余
    ("`剩余 ${formatNumber(q.onDemandLimit", "`${t('剩余')} ${formatNumber(q.onDemandLimit"),
    # L6073 历史周期
    (">历史周期</div>", ">${t('历史周期')}</div>"),
    # L6171/6172 tails (concat)
    ("'</code>。Token 会保存到当前供应商，请勿上传给第三方。'",
     "'</code>' + t('。Token 会保存到当前供应商，请勿上传给第三方。')"),
    # L6484 table headers
    ("<th>成员</th><th>Team</th>", "<th>${t('成员')}</th><th>Team</th>"),
])
total += apply('app.js', [
    # L5663-5750: concat desc lines (single-quoted with <code> tags)
    ("'将以下 JSON 写入 <code>~/.claude/settings.json</code> 即可使用 CrewRouter 作为 API 代理'",
     "t('将以下 JSON 写入') + ' <code>~/.claude/settings.json</code> ' + t('即可使用 CrewRouter 作为 API 代理')"),
    ("'将以下内容写入 <code>~/.codex/config.toml</code>，然后重启 Codex CLI'",
     "t('将以下内容写入') + ' <code>~/.codex/config.toml</code>' + t('，然后重启 Codex CLI')"),
    ("'将以下 JSON 写入项目根目录的 <code>opencode.json</code> 中'",
     "t('将以下 JSON 写入项目根目录的') + ' <code>opencode.json</code> ' + t('中')"),
    ("'将以下内容写入 <code>~/.grok/config.toml</code>，然后重启 Grok Build'",
     "t('将以下内容写入') + ' <code>~/.grok/config.toml</code>' + t('，然后重启 Grok Build')"),
    ("'将以下内容写入 <code>~/.dsh/settings.yaml</code>'",
     "t('将以下内容写入') + ' <code>~/.dsh/settings.yaml</code>'"),
    ("'将以下 JSON 写入 <code>~/.qwen/settings.json</code>（或对应 OpenAI 兼容配置），然后重启 Qwen Code'",
     "t('将以下 JSON 写入') + ' <code>~/.qwen/settings.json</code>' + t('（或对应 OpenAI 兼容配置），然后重启 Qwen Code')"),
    ("'将以下 JSON 合并到 <code>~/.openclaw/openclaw.json</code> 的 providers 段'",
     "t('将以下 JSON 合并到') + ' <code>~/.openclaw/openclaw.json</code> ' + t('的 providers 段')"),
])
print(f'TOTAL: {total}')
(ROOT/'lang/zh.json').write_text(json.dumps(ZH, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
(ROOT/'lang/en.json').write_text(json.dumps({k: EN.get(k,k) for k in ZH}, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
print(f'zh={len(ZH)}')
