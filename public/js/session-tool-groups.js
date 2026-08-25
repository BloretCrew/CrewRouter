// 会话时间线连续工具折叠 —— 把连续的 tool_call/tool_result 事件分组为客户端风格摘要行
// 例：「搜索了5次文件，写入了两个文件，提交了 35af87f」
// 规则表按优先级匹配；摘要行可点击展开该组全部工具明细。

const TOOL_CATEGORY_RULES = [
  // [分类名, 匹配函数(name, argsObj, resultPreview)]
  ['commit', (name, a, res) => /^(bash|run_terminal_command|terminal|shell)$/i.test(name) && /git\s+commit/.test(String(a && a.command || '') || '')],
  ['search', (name) => /^(grep|web_search|websearch|glob)$/i.test(name)],
  ['read', (name) => /^(read|ls)$/i.test(name)],
  ['write', (name) => /^(write|edit|multiedit|notebookedit)$/i.test(name)],
  ['todo', (name) => /^(todowrite|todo_write)$/i],
  ['bash', (name) => /^(bash|run_terminal_command|terminal|shell)$/i.test(name)],
];

function classifyToolEvent(evt) {
  let args = evt.argsObj || null;
  if (!args && evt.argsPreview) { try { args = JSON.parse(evt.argsPreview); } catch (_) {} }
  const res = evt.resultPreview || '';
  for (const [cat, match] of TOOL_CATEGORY_RULES) {
    try { if (match(evt.name || '', args, res)) return cat; } catch (_) {}
  }
  return 'other';
}

// 从 git commit 输出/命令里提取短 hash
function extractCommitHash(evt) {
  const text = String((evt.argsPreview || '') + ' ' + (evt.resultPreview || ''));
  const m = text.match(/\b([0-9a-f]{7,40})\b/i);
  if (!m) return null;
  const h = m[1];
  return h.length > 8 ? h.slice(0, 8) : h;
}

// 主入口：把事件流中的连续工具段折叠为摘要组
// 返回 [{type:'summary', groups:{cat:count, ...}, hashes:[...], events:[原始事件]}, ..., {type:'single', event}]
function groupToolRuns(events) {
  const out = [];
  let run = [];
  const flushRun = () => {
    if (!run.length) return;
    if (run.length < 3) {
      // 少于3个工具不折叠，逐个渲染
      for (const e of run) out.push({ type: 'single', event: e });
    } else {
      const counts = {};
      const hashes = [];
      for (const e of run) {
        if (e.type !== 'tool_call') continue;  // 只统计调用侧，结果成对不重复计数
        const cat = classifyToolEvent(e);
        counts[cat] = (counts[cat] || 0) + 1;
        if (cat === 'commit') {
          // hash 从对应的 result 提取（run 中紧跟的 tool_result）
          const h = extractCommitHash(e);
          if (h) hashes.push(h);
        }
      }
      out.push({ type: 'summary', groups: counts, hashes, events: run.slice() });
    }
    run = [];
  };
  for (const e of events) {
    if (e.type === 'tool_call' || e.type === 'tool_result') {
      run.push(e);
    } else {
      flushRun();
      out.push({ type: 'single', event: e });
    }
  }
  flushRun();
  return out;
}

// 摘要文案（中文序数化：5→"搜索了5次文件"，2→"写入了两个文件"）
function summarySentence(groups, hashes, t) {
  const numCn = ['零','一','两','三','四','五','六','七','八','九'];
  const cnNum = (n) => n <= 9 ? numCn[n] : String(n);
  const parts = [];
  if (groups.search) parts.push(t('搜索了') + groups.search + t('次文件'));
  if (groups.read) parts.push(t('读取了') + cnNum(groups.read) + t('个文件'));
  if (groups.write) parts.push(t('写入了') + cnNum(groups.write) + t('个文件'));
  if (hashes.length) parts.push(t('提交了') + ' ' + hashes.map(escapeHtml).join(', '));
  else if (groups.commit) parts.push(t('提交了') + cnNum(groups.commit) + t('次'));
  if (groups.todo) parts.push(t('更新了任务清单'));
  if (groups.bash) parts.push(t('执行了') + groups.bash + t('条命令'));
  if (groups.other) parts.push(t('调用了') + groups.other + t('个其他工具'));
  return parts.join('，');
}
