/* Classic-script twin of transcript.js (content scripts cannot use ESM imports).
   Keep in sync with transcript.js — see README / 交接备忘 on the dual-file rule. */
(function () {
  // 2.4.0: sanity rails only (unlimitedStorage granted). Keep in sync with transcript.js.
  const TRANSCRIPT_LIMITS = {perMessage: 200000, perSession: 5000000, maxMessages: 4000};

  function roleOf(node, maxHops = 4) {
    let parent = node?.parentElement || null;
    for (let hops = 0; parent && hops < maxHops; hops++) {
      const cls = ' ' + (typeof parent.className === 'string' ? parent.className : '') + ' ';
      if (cls.includes('text-text-primary')) return 'user';
      if (/\bpb-3\b/.test(cls)) return 'assistant';
      parent = parent.parentElement;
    }
    return null;
  }

  const clip = (text, max) => (typeof text === 'string' && text.length > max ? text.slice(0, max) : text);

  // innerText is empty while the tab is backgrounded; fall back to textContent.
  function readText(node) {
    const inner = typeof node?.innerText === 'string' ? node.innerText.trim() : '';
    if (inner) return inner;
    return typeof node?.textContent === 'string' ? node.textContent.trim() : '';
  }

  /* ---- Markdown 还原（2.8.1）。DOM 是渲染后的结果，textContent 会丢掉全部标记，
     所以这里按标签重建 Markdown。退化环境（测试 stub、未挂载节点）自动回落到纯文本。 ---- */
  const TICK = String.fromCharCode(96);
  const FENCE3 = TICK + TICK + TICK;
  // 内容本身可能含 ``` （例如一份 .md 文件的正文），外层围栏必须更长，否则会被提前闭合。
  function fenceFor(body) {
    const runs = String(body).match(new RegExp('^' + TICK + '{3,}', 'gm')) || [];
    return TICK.repeat(Math.max(3, runs.reduce((m, r) => Math.max(m, r.length), 0) + 1));
  }
  const richDom = node => !!node && typeof node.tagName === 'string' && !!node.childNodes && typeof node.querySelector === 'function';
  function inlineMd(node) {
    let out = '';
    for (const n of node.childNodes || []) {
      if (n.nodeType === 3) {
        out += n.nodeValue;
        continue;
      }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName.toLowerCase();
      const cls = typeof n.className === 'string' ? n.className : '';
      if (/\bkatex\b/.test(cls)) {
        const tex = n.querySelector('annotation[encoding="application/x-tex"]');
        out += tex ? '$' + tex.textContent.trim() + '$' : (n.textContent || '').trim();
        continue;
      }
      if (tag === 'strong' || tag === 'b') out += '**' + inlineMd(n).trim() + '**';
      else if (tag === 'em' || tag === 'i') out += '*' + inlineMd(n).trim() + '*';
      else if (tag === 'code') out += TICK + (n.textContent || '').trim() + TICK;
      else if (tag === 'a') out += '[' + inlineMd(n).trim() + '](' + (n.getAttribute('href') || '') + ')';
      else if (tag === 'br') out += '\n';
      else out += inlineMd(n);
    }
    return out;
  }
  function codeMd(pre) {
    const head = pre.querySelector('span.text-text-secondary');
    const lang = head ? head.textContent.trim().toLowerCase() : '';
    const clone = pre.cloneNode(true);
    for (const h of clone.querySelectorAll('span.text-text-secondary')) {
      const bar = h.closest('div');
      if (bar && (bar.textContent || '').trim().length < 40) bar.remove();
    }
    for (const s of clone.querySelectorAll('svg,button')) s.remove();
    const body = (clone.textContent || '').replace(/^\n+/, '').replace(/\s+$/, '');
    const fence = fenceFor(body);
    return fence + lang + '\n' + body + '\n' + fence;
  }
  function tableMd(t) {
    const rows = [...t.querySelectorAll('tr')].map(tr => [...tr.children].map(td => inlineMd(td).replace(/\s+/g, ' ').trim()));
    if (!rows.length) return '';
    return ['| ' + rows[0].join(' | ') + ' |', '| ' + rows[0].map(() => '---').join(' | ') + ' |', ...rows.slice(1).map(r => '| ' + r.join(' | ') + ' |')].join('\n');
  }
  function listMd(el, depth) {
    const ordered = el.tagName.toLowerCase() === 'ol';
    const pad = '  '.repeat(depth || 0);
    return [...el.children]
      .filter(li => li.tagName.toLowerCase() === 'li')
      .map((li, i) => {
        const nested = [...li.children].filter(c => /^(ul|ol)$/i.test(c.tagName));
        const clone = li.cloneNode(true);
        for (const n of clone.querySelectorAll('ul,ol')) n.remove();
        return [pad + (ordered ? i + 1 + '. ' : '- ') + inlineMd(clone).replace(/\s+/g, ' ').trim(), ...nested.map(n => listMd(n, (depth || 0) + 1))].join('\n');
      })
      .join('\n');
  }
  function blockMd(el) {
    const tag = el.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) return '#'.repeat(Number(tag[1])) + ' ' + inlineMd(el).trim();
    if (tag === 'pre') return codeMd(el);
    if (tag === 'table') return tableMd(el);
    if (tag === 'ul' || tag === 'ol') return listMd(el, 0);
    if (tag === 'blockquote')
      return inlineMd(el)
        .trim()
        .split('\n')
        .map(l => '> ' + l)
        .join('\n');
    if (tag === 'hr') return '---';
    if (tag === 'p')
      return inlineMd(el)
        .replace(/[ \t]+/g, ' ')
        .trim();
    if (el.querySelector('table')) return tableMd(el.querySelector('table'));
    if (el.querySelector('pre')) return codeMd(el.querySelector('pre'));
    return inlineMd(el)
      .replace(/[ \t]+/g, ' ')
      .trim();
  }
  // 正文节点 -> Markdown；退化环境回落纯文本，既有行为不变。
  function nodeToMarkdown(node) {
    if (!richDom(node)) return readText(node);
    try {
      const parts = [];
      for (const child of node.children) parts.push(blockMd(child));
      const md = parts.filter(s => s && s.trim()).join('\n\n');
      return md.trim() || readText(node);
    } catch {
      return readText(node);
    }
  }
  // 工具调用摘要 -> "> used Bash ×2"。只留名称与次数，命令与文件正文一律丢弃。
  function isToolSummary(el) {
    if (!richDom(el)) return false;
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    return t.length < 200 && /Ran commands?\s*\d|used\s*\S/i.test(t) && !el.querySelector('div.prose') && !el.querySelector('[class*="artifact"]');
  }
  function toolSummaryToMarkdown(el) {
    if (!richDom(el)) return '';
    const seq = [...el.querySelectorAll('*')].filter(e => !e.children.length && (e.textContent || '').trim()).map(e => (e.textContent || '').trim());
    const names = [];
    for (let i = 0; i < seq.length; i++) {
      if (/^used$/i.test(seq[i]) && seq[i + 1]) names.push('used ' + seq[i + 1]);
      else if (/^(Write|Read|Edit)$/i.test(seq[i]) && seq[i + 1] && /\./.test(seq[i + 1])) names.push(seq[i] + ' ' + seq[i + 1]);
    }
    if (!names.length) return '';
    const counted = new Map();
    for (const n of names) counted.set(n, (counted.get(n) || 0) + 1);
    return '> ' + [...counted].map(([n, c]) => n + (c > 1 ? ' ×' + c : '')).join(' · ');
  }

  // 紧邻在正文之前的工具调用摘要（DOM 上是兄弟节点），按出现顺序汇成引用行。
  function toolMarksBefore(node) {
    if (!richDom(node)) return '';
    const marks = [];
    let prev = node.previousElementSibling;
    while (prev && isToolSummary(prev)) {
      const md = toolSummaryToMarkdown(prev);
      if (md) marks.unshift(md);
      prev = prev.previousElementSibling;
    }
    return marks.join('\n\n');
  }

  function captureTranscript(doc = globalThis.document, limits = TRANSCRIPT_LIMITS, {includeToolCalls = true} = {}) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return null;
    const nodes = [...doc.querySelectorAll('main div.prose, main div.not-prose')];
    const messages = [];
    let total = 0,
      truncated = false,
      skipped = 0;
    for (const node of nodes) {
      const cls = typeof node.className === 'string' ? node.className : '';
      if (/ProseMirror|tiptap/.test(cls)) continue;
      // 2.8.3：实测 .not-prose 从来不是思考过程——它要么是代码块的外壳（在 <pre> 内），要么是
      // 工作区的文件预览。前者的内容已包含在所属 .prose 里，再抓一次会让同一段代码重复导出、
      // 并把语言名漏成正文；后者压根不是对话的一部分，却会被 roleOf 判成 user 消息。
      if (typeof node.closest === 'function') {
        if (/not-prose/.test(cls) && node.closest('pre')) continue;
        if (node.closest('[class*="artifact"]')) continue;
        if (node.closest('[hidden], [aria-hidden="true"], [inert], [style*="display: none"], [style*="display:none"]')) continue;
      }
      const marks = includeToolCalls ? toolMarksBefore(node) : '';
      const body = nodeToMarkdown(node);
      const raw = marks && body ? marks + '\n\n' + body : marks || body;
      if (!raw) continue;
      const role = roleOf(node);
      if (!role) {
        skipped++;
        continue;
      }
      if (messages.length >= limits.maxMessages) {
        truncated = true;
        break;
      }
      const text = clip(raw, limits.perMessage);
      if (text.length < raw.length) truncated = true;
      if (total + text.length > limits.perSession) {
        truncated = true;
        break;
      }
      total += text.length;
      // Reasoning becomes a field on the assistant message, never a message of its own.
      if (/not-prose/.test(cls) && role === 'assistant') {
        messages.push({role, text: '', reasoning: text});
        continue;
      }
      const prev = messages[messages.length - 1];
      if (prev && prev.role === 'assistant' && prev.text === '' && prev.reasoning && role === 'assistant') {
        prev.text = text;
        continue;
      }
      messages.push({role, text});
    }
    return {schemaVersion: 1, capturedAt: new Date().toISOString(), messages: messages.filter(m => m.text || m.reasoning), chars: total, truncated, unmatched: skipped || undefined};
  }

  globalThis.ArenaTranscript = {TRANSCRIPT_LIMITS, roleOf, readText, captureTranscript, nodeToMarkdown, toolMarksBefore};
})();
