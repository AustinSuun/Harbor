/* Shared renderer. Every external value is rendered with textContent, never HTML. */
(() => {
  const css = `
.ati{--bg:#111a20;--surface:#172229;--line:#2b3b42;--text:#e8f1f0;--muted:#94a8ae;--green:#9ae9ca;box-sizing:border-box;color:var(--text);font:13px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;overflow-wrap:anywhere}
.ati *{box-sizing:border-box}.ati button,.ati summary{font:inherit}.ati button{cursor:pointer}.ati button:disabled{opacity:.4;cursor:default}.ati button:focus-visible,.ati summary:focus-visible{outline:2px solid var(--green);outline-offset:3px}.ati .result{border:1px solid #426957;border-radius:14px;padding:18px;background:linear-gradient(135deg,#172d25,#142322)}
.ati .eyebrow{font-size:13px;font-weight:600;letter-spacing:1.2px;text-transform:uppercase;color:var(--green)}.ati .row{display:flex;align-items:center;justify-content:space-between;gap:10px}.ati .source{font-size:10px;padding:3px 8px;border:1px solid #456052;border-radius:20px;color:#bee4d3;white-space:nowrap}.ati .model{font:650 24px/1.28 ui-monospace,Consolas,monospace;letter-spacing:-.6px;margin:13px 0 4px;color:#acf0ce;word-break:break-word}.ati .provider{font-size:12px;color:#b0c8bd;margin-bottom:10px}.ati .provider-kind{margin-bottom:3px;color:#9fb8ad}.ati .extra-model{border-top:1px solid #355044;margin-top:12px;padding-top:4px}.ati .idrow{display:flex;align-items:center;gap:7px;color:#abc2b8;font:11px/1.6 ui-monospace,Consolas,monospace}.ati .idrow code{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}.ati .iconbutton,.ati .secondary{border:1px solid #40564f;color:#cce7dc;background:#ffffff06;border-radius:7px;padding:5px 9px;font-size:11px;white-space:nowrap;width:auto}.ati .iconbutton:hover,.ati .secondary:hover{background:#ffffff10}.ati .toplabel{font-size:10px;color:var(--muted);letter-spacing:1.1px;margin:17px 0 9px}.ati .metrics{display:grid;grid-template-columns:1fr 1fr;gap:8px}.ati .metric{min-width:0;padding:13px 14px;background:var(--surface);border:1px solid var(--line);border-radius:10px}.ati .metric-label{color:#a6b7bb;font-size:11px}.ati .metric-value{font:600 20px/1.3 ui-monospace,Consolas,monospace;margin-top:5px;color:#edf5f2}.ati .metric-value.state{font:600 14px/1.9 system-ui,sans-serif}.ati .metric-note{color:var(--muted);font-size:10px;margin-top:4px;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}.ati .footnote{font-size:10px;color:var(--muted);margin:10px 1px 15px}.ati .fold{border:1px solid var(--line);border-radius:10px;background:#141f25;margin-top:9px;overflow:hidden}.ati summary{list-style:none;cursor:pointer;padding:11px 14px;display:flex;align-items:center;gap:10px;font-weight:600}.ati .fold-head{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}.ati .fold-title{line-height:1.35}.ati summary::-webkit-details-marker{display:none}.ati summary:after{content:'+';font-size:17px;color:#a1b7b7;font-weight:400}.ati details[open]>summary:after{content:'−'}.ati .count{font-size:10px;font-weight:400;color:var(--muted);line-height:1.4}.ati .grouplabel{font-size:10px;color:var(--muted);letter-spacing:1.1px;margin:16px 0 8px}.ati .empty-hint{font-size:11px;color:var(--muted);line-height:1.6;padding:11px 13px;border:1px dashed var(--line);border-radius:10px}.ati .fold-body{border-top:1px solid var(--line);padding:13px}.ati .call+.call{border-top:1px solid var(--line);padding-top:13px;margin-top:13px}.ati .call-title{font-size:12px;font-weight:650;color:#d8ece4}.ati .call-index{font:11px ui-monospace,Consolas,monospace;color:var(--green);margin-right:7px}.ati .call-state{font-size:10px;color:var(--muted)}.ati .call-sub{color:var(--muted);font-size:11px;margin:5px 0 8px}.ati .call-metrics{display:flex;gap:15px;font-size:12px;margin:8px 0;color:#c4dcd1}.ati .evidence-intro{color:#9ab3b8;font-size:11px;margin:0 0 14px}.ati .evidence-item{border-left:2px solid #466a5a;padding:2px 0 2px 10px;margin:12px 0}.ati .evidence-label{font-size:11px;color:#9eb7ac}.ati .evidence-value{font:12px/1.6 ui-monospace,Consolas,monospace;color:#d9eddf;white-space:pre-wrap}.ati .path{font:10px/1.55 ui-monospace,Consolas,monospace;color:#8da1a8;overflow-wrap:anywhere;margin-top:3px}.ati .legacy{background:#29281f;border:1px solid #514b33;border-radius:8px;padding:10px 12px;font-size:11px;color:#d3c9a8;line-height:1.7}.ati .evidence-actions{display:flex;gap:7px;flex-wrap:wrap;border-top:1px solid var(--line);padding-top:12px;margin-top:12px}.ati .empty{padding:8px 0;font-size:12px;color:var(--muted)}.ati .notice{font-size:11px;min-height:18px;color:#9ae9ca;margin-top:8px}.ati .checked{color:#8fa49e;font-size:10px;margin:9px 0 0}.ati .model-actions{display:flex;flex-direction:column;gap:6px;flex-shrink:0}.ati .rename-status{font-size:11px;color:#9ae9ca;margin:7px 0;white-space:normal}.ati .rename-status:empty{display:none}.ati .rename-status[data-error="true"]{color:#e6c598}.ati .caption{font-size:10px;color:var(--muted)}
.ati .evidence-group>summary{padding:3px 0;font-weight:400;gap:8px;align-items:flex-start}.ati .evidence-group>summary:after{font-size:14px;line-height:1.15}.ati .evidence-group .fold-head{gap:3px}
.ati .group-item{font:10px/1.55 ui-monospace,Consolas,monospace;color:var(--muted);margin-top:6px;overflow-wrap:anywhere}.ati .evidence-group>.group-item:first-of-type{margin-top:8px;padding-top:7px;border-top:1px dashed #334742}
`;
  const balanceCss = `.ati .quota{border:1px solid #2e4a40;border-radius:14px;background:linear-gradient(160deg,#152522,#111b1f);margin:0 0 12px;overflow:hidden}
.ati .quota-head{display:flex;align-items:center;gap:8px;padding:8px 14px;border-bottom:1px solid #24383a}.ati .quota-dot{width:7px;height:7px;border-radius:50%;background:#4ade80;box-shadow:0 0 8px #4ade80aa;flex-shrink:0}.ati .quota-dot[data-tone=warn]{background:#fbbf24;box-shadow:0 0 8px #fbbf24aa}.ati .quota-dot[data-tone=low]{background:#f87171;box-shadow:0 0 8px #f87171aa}.ati .quota-dot[data-tone=none]{background:#6b7f7c;box-shadow:none}
.ati .quota-title{flex:1;font:650 13px/1.4 system-ui,sans-serif;color:#e6f2ee;letter-spacing:.3px}.ati .quota-refresh{width:26px;height:26px;padding:0;border:1px solid #33514a;border-radius:7px;background:#ffffff05;color:#bfe0d3;font-size:14px;line-height:1}.ati .quota-refresh:disabled{opacity:.45;cursor:wait}.ati .quota-refresh.spin{animation:ati-spin 1s linear infinite}@keyframes ati-spin{to{transform:rotate(360deg)}}
.ati .quota-body{display:flex;align-items:center;gap:14px;padding:11px 14px}.ati .quota-ring{position:relative;width:64px;height:64px;flex-shrink:0}.ati .quota-ring svg{width:64px;height:64px;transform:rotate(-90deg)}.ati .quota-ring circle{fill:none;stroke-width:10;stroke-linecap:round}.ati .quota-ring .track{stroke:#22332f}.ati .quota-ring .bar{stroke:#4ade80;transition:stroke-dashoffset .6s ease}.ati .quota-ring[data-tone=warn] .bar{stroke:#fbbf24}.ati .quota-ring[data-tone=low] .bar{stroke:#f87171}.ati .quota-ring[data-tone=none] .bar{stroke:#3c4f4b}
.ati .quota-pct{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font:800 15px/1 system-ui,sans-serif;color:#f4fbf8;letter-spacing:-.4px}.ati .quota-pct small{font-size:10px;font-weight:700;margin-left:1px}
.ati .quota-main{min-width:0;flex:1}.ati .quota-big{font:800 21px/1.1 system-ui,sans-serif;color:#f4fbf8;letter-spacing:-.5px;margin-bottom:6px;white-space:nowrap}.ati .quota-big span{font:600 15px/1 system-ui,sans-serif;color:#8ea6a0;margin-left:5px}
.ati .quota-rows{display:grid;grid-template-columns:auto 1fr;gap:3px 10px;font:11px/1.45 system-ui,sans-serif;margin:0}.ati .quota-rows.two-col{grid-template-columns:auto auto auto 1fr;gap:3px 8px}.ati .quota-rows.two-col dt:nth-of-type(2n){margin-left:8px}.ati .quota-rows dt{color:#93aaa5;margin:0;white-space:nowrap}.ati .quota-rows dd{color:#e3eeea;margin:0;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.ati .quota-foot{padding:6px 14px 8px;font-size:9.5px;line-height:1.4;color:#7f958f}.ati .quota-foot[data-error]{color:#e6c598}
.ati .quota.compact{display:flex;align-items:center;gap:8px;margin:0;padding:7px 8px 7px 9px;min-height:62px;cursor:default}.ati .quota.compact .quota-ring,.ati .quota.compact .quota-ring svg{width:46px;height:46px}.ati .quota.compact .quota-ring circle{stroke-width:11}
.ati .quota.compact .quota-pct{font-size:12px;letter-spacing:-.3px}.ati .quota.compact .quota-pct small{font-size:8px}.ati .quota.compact .quota-big{font-size:15px;margin-bottom:3px;overflow:hidden;text-overflow:ellipsis}.ati .quota.compact .quota-big span{font-size:10px;margin-left:3px}
.ati .quota-sub{font-size:10px;line-height:1.35;color:#8ea6a0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ati .quota-sub[data-error]{color:#e6c598}.ati .quota.compact .quota-sub{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ati .quota.compact .quota-sub .quota-read{display:inline;margin-left:5px}.ati .quota.compact .quota-refresh{width:18px;height:18px;font-size:11px;border-radius:5px;align-self:flex-start;flex-shrink:0}`;
  const actionCss = `.ati .recovery-card{border-color:#355044}.ati .recovery-steps{font-size:10px;color:#8ea6a0;margin:7px 0;line-height:1.6}.ati .recovery-message{font-size:12px;line-height:1.5;margin:6px 0}.ati .recovery-retry{margin-top:8px}.ati .raw-archive-status{border-top:1px solid var(--line);margin-top:12px;padding-top:10px;font-size:11px;color:var(--muted)}.ati .raw-archive-title{font-weight:600;color:var(--green);margin-bottom:4px}.ati .raw-archive-status[data-warning="true"] .raw-archive-title,.ati .diagnostics-card[data-warning="true"]>summary .count,.ati .model-identity[data-warning="true"]>summary .count,.ati .diag-section.recovery-card[data-warning="true"]>.evidence-label,.ati .compatibility-status>summary{color:#e6c598}.ati .diag-section{border-top:1px solid var(--line);margin-top:11px;padding-top:9px}.ati .diag-section:first-child{border-top:0;margin-top:0;padding-top:0}.ati .compatibility-status{border-color:#655637}.ati .recovery-info{font-size:11px;color:var(--muted);line-height:1.6;margin-top:4px}.ati .switch-alert{margin:8px 0 6px;padding:10px 12px;border-radius:10px;font:650 13px/1.45 system-ui,sans-serif}.ati .switch-alert.switched{background:#3a1c1c;border:1px solid #a45a5a;color:#ffc9c9}.ati .switch-alert.suspected{background:#3a3420;border:1px solid #a4944a;color:#f0e0a0}.ati .model.switched{color:#ffc9c9}.ati .run-meta{margin-top:14px}.ati .rename-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-start;width:100%}.ati .auto-rename{display:flex;align-items:center;gap:4px;font-size:10px;color:#bad9ce;cursor:pointer;white-space:nowrap}.ati .auto-rename input{accent-color:#9ae9ca;width:14px;height:14px;margin:0}.ati .delete-button{color:#f0b3ad;border-color:#78504d}.ati .model-actions{align-items:flex-start;margin-top:16px;padding-top:12px;border-top:1px solid #355044}.ati .model-actions .iconbutton{padding:5px 6px;font-size:9px}.ati .model-actions .rename-row{max-width:100%}.ati .run-idrow code{flex:0 1 auto}.ati .idrow .rerun-button{width:18px;height:18px;padding:0;border:1px solid #40564f;border-radius:6px;background:#ffffff06;color:#cce7dc;font-size:11px;line-height:1;flex:none;cursor:pointer}.ati .idrow .rerun-button:disabled{opacity:.45;cursor:default}.ati .idrow .rerun-button.spin{animation:ati-spin 1s linear infinite}`;
  const el = (tag, className, text) => {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const date = x => (x && Number.isFinite(Date.parse(x)) ? new Date(x).toLocaleString() : '未记录时间');
  function archiveStatus(a) {
    const events = {captured: '已保存', 'size-limit': '超出保存上限', missing: '未保存', 'legacy-unverified': '旧版记录，完整性未核验'};
    const details = {complete: '已保存', reading: '保存中', partial: '部分保存', failed: '保存失败', 'not-requested': '尚未读取', unknown: '未核验'};
    const warning =
      !!a.error || !!a.limited || ['partial', 'failed'].includes(a.detail) || ['size-limit', 'legacy-unverified'].includes(a.events) || (a.detail === 'complete' && a.events !== 'captured');
    const label = a.error
      ? '保存失败'
      : warning
        ? '部分保存'
        : a.detail === 'reading'
          ? '保存中'
          : a.events === 'captured' && a.detail === 'complete'
            ? '已保存'
            : a.events === 'captured'
              ? '事件已保存'
              : '等待保存';
    const count = n => (Number.isSafeInteger(n) && n >= 0 ? n : 0);
    return {label, warning, events: events[a.events] || '未保存', detail: details[a.detail] || '尚未读取', captured: count(a.capturedSpans), selected: count(a.selectedSpans)};
  }
  function coverageSummary(c) {
    const base = 'stream 详情 ' + c.streamDetails + '/' + c.totalCalls,
      bad = [];
    if (c.missingStream) bad.push('未关联 ' + c.missingStream);
    if (c.ambiguousStream) bad.push('冲突 ' + c.ambiguousStream);
    if (c.partialStream) bad.push('部分 ' + c.partialStream);
    return bad.length ? base + ' · ' + bad.join(' · ') : base;
  }
  // Summaries must be readable while collapsed: state the problem when there is one, otherwise the counts that prove there is not.
  // Only real failures raise the warning flag. Thin evidence or an unstarted session is reported in the text
  // but must not hijack the panel, or the diagnostics card would sit expanded on every ordinary run.
  function diagnosticsSummary({recovery, archive, runtime, freshness, collection, historical} = {}) {
    const problems = [],
      phases = {expired: '授权已过期', error: '会话核对失败', partial: '回放不完整'};
    if (recovery && phases[recovery.phase]) problems.push(phases[recovery.phase]);
    // 部分调用取到了原始标签、另一部分没有 ⇒ 本次采集中途缺失，按异常处理。
    // 一条都没有（0/n）通常是旧版记录，已由证据来源栏的旧版提示覆盖，不在此重复告警。
    if (runtime && runtime.observedCalls > 0 && runtime.observedCalls < runtime.modelCalls) problems.push('证据不全 ' + runtime.observedCalls + '/' + runtime.modelCalls);
    if (archive?.warning) problems.push('原始归档 · ' + archive.label);
    if (freshness && (freshness.limited || freshness.partial || freshness.stopped)) problems.push('详情覆盖受限');
    if (problems.length) return {warning: true, text: problems.slice(0, 2).join(' · ')};
    const parts = [recovery ? (recovery.phase === 'waiting' ? '等待授权' : recovery.label) : historical ? '历史快照' : '未开始会话'];
    if (runtime) parts.push('证据 ' + runtime.observedCalls + '/' + runtime.modelCalls);
    parts.push(freshness?.label || (collection ? '只读阶段记录' : '详情未记录'));
    // 后段若已包含前段（「历史快照，未重新验证」⊃「历史快照」），前段即冗余。
    return {warning: false, text: parts.filter((p, i) => !parts.slice(i + 1).some(q => q.includes(p))).join(' · ')};
  }
  function identitySummary(identity, historical) {
    const matches = identity?.matches || [],
      rows = identity?.rows || [],
      layers = ['server', 'internal', 'request', 'response'].filter(k => rows.some(r => r.layer === k)).length,
      tail = ' · 四层取到 ' + layers + ' 层',
      head = historical ? '历史快照 · ' : '',
      count = s => matches.filter(m => m.status === s).length;
    if (count('conflict')) return {warning: true, text: head + count('conflict') + ' 项冲突' + tail};
    if (count('mismatch')) return {warning: true, text: head + count('mismatch') + ' 项未匹配' + tail};
    if (identity?.hasAnonymous) return {warning: true, text: head + '含匿名待确认' + tail};
    if (identity?.limited || identity?.stopped) return {warning: true, text: head + '读取受限' + tail};
    if (!matches.length) return {warning: false, text: head + '无标签可匹配' + tail};
    return {warning: false, text: head + '匹配 ' + count('matched') + '/' + matches.length + tail};
  }
  // 同层内「值 + 字段路径」都相同的记录只是轮次不同，合并成一组。
  // 合并键含值本身，因此任何值的差异（模型切换、层内冲突）都会落进不同组，永远不会被折叠隐藏。
  function groupIdentityRows(rows) {
    const groups = [],
      index = new Map();
    for (const row of rows || []) {
      const key = row.value + '\u0000' + row.path;
      let group = index.get(key);
      if (!group) {
        group = {value: row.value, path: row.path, items: []};
        index.set(key, group);
        groups.push(group);
      }
      group.items.push(row);
    }
    return groups;
  }
  async function copy(text, button, notice) {
    const before = button.textContent;
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = '已复制';
      notice.textContent = '已复制，不含令牌、Cookie 或正文。';
    } catch {
      notice.textContent = '复制失败，请使用“下载证据 JSON”，或手动选中文本复制。';
    }
    setTimeout(() => {
      if (button.isConnected) button.textContent = before;
    }, 1500);
  }
  function create(parent, options = {}) {
    const pulseCss = `.ati .quota.compact{display:flex;flex-direction:column;justify-content:space-between;align-items:stretch;gap:0;margin:0;padding:0;min-height:124px;border-radius:12px;cursor:default}.ati .quota.compact .quota-body{position:relative;display:flex;align-items:center;gap:9px;padding:8px 9px 7px}.ati .quota.compact .quota-ring,.ati .quota.compact .quota-ring svg{width:48px;height:48px}.ati .quota.compact .quota-ring circle{stroke-width:11}.ati .quota.compact .quota-pct{font-size:12px;letter-spacing:-.3px}.ati .quota.compact .quota-pct small{font-size:8.5px}.ati .quota.compact .quota-head-row{display:flex;align-items:baseline;gap:5px;margin-bottom:4px;padding-right:22px;white-space:nowrap}.ati .quota.compact .quota-big{font-size:15.5px;margin-bottom:0;overflow:hidden;text-overflow:ellipsis}.ati .quota.compact .quota-big span{font-size:11px;margin-left:3px}.ati .quota.compact .tier-pill{display:inline-block;font:600 9.5px/1.2 ui-monospace,Consolas,monospace;color:#98c9b8;background:#19302a;border:1px solid #2d5045;padding:0 4px;border-radius:4px;flex-shrink:0}.ati .quota.compact .quota-rows{font:10px/1.38 system-ui,sans-serif;gap:1.5px 5px}.ati .quota.compact .quota-rows.two-col dt:nth-of-type(2n){margin-left:4px}.ati .quota.compact .quota-rows dd{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ati .quota-sub{font-size:10px;line-height:1.35;color:#8ea6a0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ati .quota-sub[data-error]{color:#e6c598}.ati .quota.compact .quota-refresh{position:absolute;top:6px;right:7px;width:20px;height:20px;font-size:11.5px;border-radius:5px}.ati .ratelimit-section{border-top:1px solid #223638;padding:9px 14px 10px;background:#101a1e88;display:flex;flex-direction:column;gap:8px}.ati .quota.compact .ratelimit-section{padding:6px 9px 7px;gap:5px}.ati .ratelimit-head{display:flex;align-items:center;justify-content:space-between;font-size:10.5px;color:#8ea6a0;letter-spacing:.3px}.ati .ratelimit-title{color:#c9e4da;font-weight:600}.ati .ratelimit-badge{font:500 9.5px/1.2 ui-monospace,Consolas,monospace;color:#7f958f}.ati .ratelimit-grid{display:flex;flex-direction:column;gap:8px}.ati .quota.compact .ratelimit-grid{gap:5px}.ati .rl-item{display:flex;flex-direction:column;gap:4px}.ati .quota.compact .rl-item{gap:3px}.ati .rl-top{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:11px;font-variant-numeric:tabular-nums}.ati .quota.compact .rl-top{gap:4px;font-size:10px;white-space:nowrap}.ati .rl-name{color:#b7cfca;font-weight:600;display:flex;align-items:center;gap:5px}.ati .quota.compact .rl-name{gap:4px}.ati .rl-tag{font:500 9.5px/1.2 ui-monospace,Consolas,monospace;padding:1px 5px;border-radius:4px;background:#1b2d33;color:#88a4a0;border:1px solid #2a4147}.ati .quota.compact .rl-tag{font-size:8.5px;line-height:1.15;padding:0 4px;border-radius:3px}.ati .rl-meta{display:flex;align-items:baseline;gap:5px;font-variant-numeric:tabular-nums}.ati .quota.compact .rl-meta{gap:4px}.ati .rl-val{font:700 11.5px/1.2 ui-monospace,Consolas,monospace;color:#e8f4f0}.ati .quota.compact .rl-val{font-size:10.5px;line-height:1.15}.ati .rl-val[data-tone="warn"]{color:#fbbf24}.ati .rl-val[data-tone="low"]{color:#f87171}.ati .rl-val[data-tone="none"]{color:#7c949a;font-weight:500;font-size:10.5px}.ati .quota.compact .rl-val[data-tone="none"]{font-size:9.5px}.ati .rl-timer{font-weight:400;font-size:10px;color:#86a09a}.ati .quota.compact .rl-timer{font-size:9.5px}.ati .rl-track{height:6px;border-radius:99px;background:#1f3033;overflow:hidden}.ati .quota.compact .rl-track{height:4.5px}.ati .rl-fill{height:100%;border-radius:99px;background:linear-gradient(90deg,#34d399,#4ade80);transition:width .35s ease}.ati .rl-fill[data-tone="warn"]{background:linear-gradient(90deg,#f59e0b,#fbbf24)}.ati .rl-fill[data-tone="low"]{background:linear-gradient(90deg,#ef4444,#f87171)}.ati .rl-fill[data-tone="none"]{background:#3b514e}`;
    const style = el('style');
    style.textContent = css + actionCss + balanceCss + pulseCss;
    const root = el('section', 'ati');
    parent.append(style, root);
    let lastRun = '',
      lastSession = '',
      currentView = null,
      renameBusy = false,
      renameMessage = '',
      renameFailed = false,
      renameView = null;
    // Optional host outside the panel root (HUD top row, beside the listen button): the unified quota card renders there in compact form.
    const quotaHost = options.quotaHost || null;
    // popup 不再显示余额：那里的百分比长期取不到值（见 2.8.2 的 ATI_PULSE 守卫问题），
    // 只剩一个灰环和美元数字，不如交给 HUD 单独承担。
    const hideQuota = options.hideQuota === true;
    if (quotaHost) quotaHost.classList.add('ati');
    function updateRename() {
      for (const b of root.querySelectorAll('.rename-button')) {
        b.disabled = renameBusy || !!currentView?.archivePending || !currentView?.models.length;
        b.textContent = renameBusy ? '重命名中…' : '重命名对话';
      }
      const message = root.querySelector('.rename-status');
      if (message) {
        message.textContent = renameMessage;
        message.dataset.error = String(renameFailed);
      }
    }
    let pulse = null;
    const spanQuotaFromView = () => {
      if (currentView?.accountQuota) return currentView.accountQuota;
      const d = globalThis.ArenaAgentDetailView?.detailView(currentView?.detail);
      return d?.quota || null;
    };
    const spanReadAt = () => currentView?.accountQuota?.checkedAt || currentView?.detail?.checkedAt || currentView?.checkedAt || null;
    const rateLimitsFromView = () => globalThis.ArenaBilling?.mergeRateLimits?.(pulse?.rateLimits, currentView?.rateLimits) || currentView?.rateLimits || pulse?.rateLimits || null;
    const formatBucketItem = (key, label, routeTag, emptyText, emptyTip, item) => {
      if (!item) {
        return {
          key,
          label,
          routeTag,
          ready: false,
          tone: 'none',
          pct: 0,
          valueText: emptyText,
          waitText: '',
          expired: false,
          pillText: emptyText,
          tip: emptyTip
        };
      }
      const tone = item.tone === 'good' ? 'ok' : item.tone || 'ok';
      const valueText = item.remaining + ' / ' + item.limit;
      const waitText = item.remainSec === null || item.expired ? '' : item.remainSec >= 60 ? Math.floor(item.remainSec / 60) + 'm ' + (item.remainSec % 60) + 's 后重置' : item.remainSec + 's 后重置';
      const pillText = item.remaining + '/' + item.limit + (item.shortReset && !item.expired ? ' · ' + item.shortReset : '');
      const tip = label + '限流（同号 × 当前 IP）：剩余 ' + item.remaining + '/' + item.limit + (item.resetText ? ' · ' + item.resetText : '');
      return {
        key,
        label,
        routeTag,
        ready: true,
        tone,
        pct: typeof item.pct === 'number' ? item.pct : 0,
        valueText,
        waitText,
        expired: !!item.expired,
        pillText,
        tip
      };
    };
    const formatRateLimitsView = (nowMs = Date.now()) => {
      const raw = rateLimitsFromView();
      const f = globalThis.ArenaBilling?.formatRateLimits ? globalThis.ArenaBilling.formatRateLimits(raw, nowMs) : null;
      return {
        createChat: formatBucketItem('createChat', '新建会话', 'create-chat', '待触发', '新建会话限流：待首次发送消息后捕获响应头', f?.createChat),
        apiGeneral: formatBucketItem('apiGeneral', 'API 通用', 'api/me/pulse', '待读取', 'API 通用限流：待读取 /api/me/pulse 响应头', f?.apiGeneral)
      };
    };
    let rlTickTimer = null;
    function stopRateLimitTick() {
      if (rlTickTimer !== null) {
        if (typeof clearInterval === 'function') clearInterval(rlTickTimer);
        rlTickTimer = null;
      }
    }
    function tickRateLimits(nowMs = Date.now()) {
      const host = quotaHost || root;
      const card = host?.querySelector?.('.quota');
      if (!card) {
        stopRateLimitTick();
        return false;
      }
      const rl = formatRateLimitsView(nowMs);
      let hasActiveCountdown = false;
      const rows = card.querySelectorAll ? [...card.querySelectorAll('.rl-item')] : [];
      for (const item of [rl.createChat, rl.apiGeneral]) {
        if (item.waitText) hasActiveCountdown = true;
        const row = rows.find(n => n.dataset?.bucket === item.key);
        if (!row) continue;
        row.dataset.tone = item.tone || 'none';
        if (item.tip) row.title = item.tip;
        const val = row.querySelector?.('.rl-val');
        if (val) {
          val.textContent = item.valueText;
          val.dataset.tone = item.tone || 'none';
        }
        const meta = row.querySelector?.('.rl-meta');
        const timerText = item.waitText || (item.expired ? '可使用' : '');
        let timer = row.querySelector?.('.rl-timer');
        if (timerText) {
          if (!timer && meta) {
            timer = el('span', 'rl-timer', timerText);
            meta.append(timer);
          } else if (timer) {
            timer.textContent = timerText;
          }
        } else if (timer) {
          timer.remove();
        }
        const fill = row.querySelector?.('.rl-fill');
        if (fill) {
          fill.dataset.tone = item.tone || 'none';
          fill.style.width = (typeof item.pct === 'number' ? item.pct : 0) + '%';
        }
      }
      if (!hasActiveCountdown) stopRateLimitTick();
      return hasActiveCountdown;
    }
    function scheduleRateLimitTick() {
      const rl = formatRateLimitsView();
      const hasActive = Boolean(rl.createChat.waitText || rl.apiGeneral.waitText);
      if (!hasActive) {
        stopRateLimitTick();
        return;
      }
      if (rlTickTimer !== null || typeof setInterval !== 'function') return;
      rlTickTimer = setInterval(() => {
        tickRateLimits(Date.now());
      }, 1000);
      rlTickTimer?.unref?.();
    }
    async function renameModel(model, view) {
      if (renameBusy) return {ok: false, retryable: false, error: '正在重命名'};
      renameBusy = true;
      renameMessage = '';
      renameFailed = false;
      renameView = view;
      updateRename();
      try {
        const result = await options.onRename(model, view);
        if (!result || result.title !== model || typeof result.unchanged !== 'boolean') {
          const error = Error('页面未返回可确认的命名结果');
          error.submitted = true;
          throw error;
        }
        if (currentView?.runId === view.runId && currentView?.sessionId === view.sessionId) renameMessage = (result?.unchanged ? '当前对话已命名为：' : '已重命名为：') + (result?.title || model);
        return {ok: true, ...result};
      } catch (error) {
        if (currentView?.runId === view.runId && currentView?.sessionId === view.sessionId) {
          renameFailed = true;
          renameMessage = error?.message || '重命名失败，请重试';
        }
        return {ok: false, error: error?.message || '重命名失败', retryable: error?.retryable === true, submitted: error?.submitted === true, previousTitle: error?.previousTitle || null};
      } finally {
        renameBusy = false;
        updateRename();
      }
    }
    function render(view) {
      currentView = view;
      if (renameView && (renameView.runId !== view.runId || renameView.sessionId !== view.sessionId)) {
        renameMessage = '';
        renameFailed = false;
      }

      const sameRun = lastRun === view.runId && lastSession === view.sessionId;
      const opens = sameRun ? [...root.querySelectorAll('details[open]')].map(x => x.dataset.section) : [];
      lastRun = view.runId;
      lastSession = view.sessionId;
      root.replaceChildren();
      if (quotaHost) quotaHost.replaceChildren(quotaCard(true));
      const notice = el('div', 'notice');
      notice.setAttribute('role', 'status');
      notice.setAttribute('aria-live', 'polite');
      const result = el('article', 'result');
      const top = el('div', 'row');
      top.append(el('div', 'eyebrow', view.models.some(m => m.internal) ? '模型（Arena 内部名）' : '服务端模型标签'), el('span', 'source', view.source));
      result.append(top);
      if (!view.models.length) {
        result.append(el('h2', 'model', '模型待确认'), el('div', 'provider', view.runId ? '等待本次 trace 返回模型标签' : '开启监听后发送消息，或查看本地会话记录'));
      }
      for (const [i, m] of view.models.entries()) {
        const group = el('div', i ? 'extra-model' : '');
        const row = el('div', 'row');
        const title = i === 0 && view.renameTitle ? view.renameTitle : m.model;
        row.append(el('h2', 'model' + (view.switch?.state === 'switched' && !i ? ' switched' : ''), title));
        group.append(row);
        // Two lines under the title when the internal name is shown: ① what the title is, ② the server label + provider.
        if (m.internal) group.append(el('div', 'provider provider-kind', 'Arena 内部 modelName'), el('div', 'provider', '服务端标签 ' + m.serverLabel + ' · ' + (m.provider || '供应商未提供')));
        else group.append(el('div', 'provider', m.provider || '供应商未提供'));
        result.append(group);
      }
      const identity = view.modelEvidence || globalThis.ArenaTraceView?.modelEvidence?.(view.serverModels || view.models, view.detail) || {rows: [], matches: []};
      const unmatched = identity.matches.some(m => m.status !== 'matched');
      if (unmatched || (!view.models.length && identity.rows.some(r => r.layer === 'internal'))) {
        const names = [...new Set(identity.rows.filter(r => r.layer === 'internal').map(r => r.value))];
        if (names.length) {
          result.append(
            el('div', 'provider provider-kind', '已读取内部名 · 尚未唯一匹配'),
            el('div', 'evidence-value internal-unmatched', names.join(' / ')),
            el('div', 'caption', '保留原始值供核对；不会因展示它而确认身份。')
          );
        }
      }
      if (view.switch?.state === 'switched') {
        const alert = el('div', 'switch-alert switched');
        alert.setAttribute('role', 'alert');
        alert.textContent = '模型已切换：' + (view.switch.from || '原模型') + ' → ' + (view.switch.to || '未知');
        result.append(alert);
      } else if (view.switch?.state === 'suspected') {
        const alert = el('div', 'switch-alert suspected');
        alert.setAttribute('role', 'status');
        alert.textContent = String(view.status || '').includes('下一轮开始') ? '疑似被路由，下一轮开始时确认' : '上游调用挂起，正在核对模型…';
        result.append(alert);
      }
      if (options.onRename) {
        const actions = el('div', 'model-actions'),
          row = el('div', 'rename-row');
        if (options.onAutoRenameChange) {
          const label = el('label', 'auto-rename'),
            check = el('input');
          check.type = 'checkbox';
          check.checked = !!view.autoRename;
          check.disabled = !!view.autoRenamePending;
          check.addEventListener('change', () => void options.onAutoRenameChange(check.checked));
          label.append(check, el('span', '', '自动重命名'));
          label.title = '等待当前 trace 详情成功返回后统一命名；读取失败不提前改名，历史恢复不触发';
          row.append(label);
        }
        const rename = el('button', 'iconbutton rename-button', '重命名对话');
        rename.type = 'button';
        rename.disabled = !view.models.length;
        rename.addEventListener('click', () => {
          if (view.models.length) void renameModel(view.renameTitle || view.models[0].model, view);
        });
        row.append(rename);
        actions.append(row);
        if (options.onArchive) {
          const archive = el('button', 'iconbutton delete-button archive-button', view.archivePending ? '归档中…' : '归档聊天并删除本地记录');
          archive.type = 'button';
          archive.disabled = !view.sessionId || !!view.actionPending || renameBusy;
          archive.title = '归档 Arena 聊天，并删除扩展本地记录；不等于永久删除聊天';
          archive.addEventListener('click', () => void options.onArchive(view));
          row.append(archive);
        }
        result.append(actions);
      }
      if (view.runId) {
        const meta = el('div', 'run-meta'),
          row = el('div', 'idrow run-idrow');
        row.append(el('span', '', 'run'));
        const code = el('code', '', view.runId);
        code.title = view.runId;
        row.append(code);
        if (options.onRerun) {
          // 放在 run 这一行的末尾：要重拉的就是本行显示的这个 run，位置本身即说明对象。
          // 用图标而非文字按钮：run 行是信息行，带边框的文字按钮会撑高行距、压掉 runId 的宽度，
          // 也与右上角余额卡的 ↻ 形成一致的「重新读取」语汇。功能由 aria-label 与 title 承担。
          const ready = view.rerun?.available === true;
          const rerun = el('button', 'rerun-button' + (view.rerunPending ? ' spin' : ''), '↻');
          rerun.type = 'button';
          rerun.disabled = !ready || !!view.rerunPending;
          rerun.setAttribute('aria-label', '重拉当前 run');
          rerun.title = view.rerunPending ? '正在重拉当前 run…' : ready ? '重拉当前 run：用当前授权重新读取本轮 span 详情，不改变监听开关；至少间隔 5 秒' : view.rerun?.reason || '暂不可重拉';
          rerun.addEventListener('click', () => {
            if (!rerun.disabled) void options.onRerun(view);
          });
          row.append(rerun);
        }
        meta.append(row, el('div', 'checked', '记录时间 · ' + date(view.checkedAt)));
        const expiresAt = view.authorization?.expiresAt;
        if (expiresAt && Number.isFinite(Date.parse(expiresAt))) meta.append(el('div', 'checked run-expiry', '授权到期 · ' + date(expiresAt)));
        result.append(meta);
      }
      if (options.onRename && view.models.length) {
        const renameStatus = el('div', 'rename-status');
        renameStatus.setAttribute('role', 'status');
        renameStatus.setAttribute('aria-live', 'polite');
        result.append(renameStatus);
      }
      if ((pulse || spanQuotaFromView() || rateLimitsFromView()) && !quotaHost && !hideQuota) root.append(quotaCard());
      root.append(result);
      root.append(el('div', 'toplabel', view.historical && view.runId ? '所选历史快照 · 已保存元数据（非重新验证）' : '本次运行 · 已捕获元数据'));
      // 2x2 grid, reading order: 状态 (completion + the live background status as its note) → 调用次数 → Token → trace 费用.
      // The note is clamped to two lines by CSS; the full text is always in the title.
      const metrics = el('div', 'metrics');
      const statusNote = typeof view.statusText === 'string' ? view.statusText.trim() : '';
      for (const [label, value, note, state] of [
        ['状态', view.completion, statusNote || '仅指已捕获的模型调用，不代表整个 Agent 工作流', true],
        ['调用次数', view.count, view.calls.length ? '按 runId + spanId 去重' : '尚无调用明细'],
        ['Token', view.tokens, view.tokenMissing ? '部分缺失 · 覆盖 ' + view.tokenCoverage + ' 次调用' : '缩写标为约数；不推算输入／输出'],
        ['trace 费用', view.cost, view.costMissing ? '部分缺失 · 覆盖 ' + view.costCoverage + ' 次调用' : 'trace 展示值，非实际账单']
      ]) {
        const card = el('div', 'metric' + (state ? ' metric-state' : ''));
        const noteEl = el('div', 'metric-note', note);
        noteEl.title = note;
        if (state) {
          noteEl.setAttribute('role', 'status');
          noteEl.setAttribute('aria-live', 'polite');
        }
        card.append(el('div', 'metric-label', label), el('div', 'metric-value' + (state ? ' state' : ''), value), noteEl);
        metrics.append(card);
      }
      root.append(metrics);
      // 采集与授权诊断：会话恢复／运行证据／详情采集合成一栏。异常时上提到指标卡正下方并自动展开（仅限新 run，同一 run 内尊重手动开关）。
      const runtime = view.evidenceStatus || {label: '尚无证据', note: '等待已白名单的模型调用记录。', modelCalls: 0, observedCalls: 0};
      const recovery = (view.sessionId && view.recovery) || view.rawArchive ? view.recovery || {label: '等待授权', source: '尚未远端核对'} : null;
      const archive = view.rawArchive ? archiveStatus(view.rawArchive) : null;
      const diagSum = diagnosticsSummary({recovery, archive, runtime, freshness: view.freshness, collection: view.collection, historical: view.historical});
      const diagLabel = el('div', 'grouplabel', '采集诊断');
      const diag = makeFold('diagnostics', '采集与授权诊断', diagSum.text, 'diagnostics-card');
      diag.el.setAttribute('data-warning', String(diagSum.warning));
      if (diagSum.warning && !sameRun) diag.el.open = true;
      if (view.historical) diag.body.append(el('p', 'footnote', '历史快照未重新验证；未监听的调用不计入本机累计。'));
      if (recovery) {
        const card = el('div', 'diag-section recovery-card');
        card.setAttribute('data-warning', String(!!archive?.warning));
        card.append(el('div', 'evidence-label', '授权与会话恢复 · ' + recovery.label));
        card.append(el('div', 'provider', recovery.source));
        const steps = el('div', 'recovery-steps', '页面授权 → 会话核对 → 事件回放 → 运行授权 → 运行详情');
        card.append(steps);
        const message = el('p', 'recovery-message', recovery.message || '可在开启监听后补读当前会话，不会发送消息');
        message.setAttribute('role', 'status');
        card.append(message);
        if (recovery.checkedAt) card.append(el('div', 'recovery-info', '读取时间 · ' + date(recovery.checkedAt)));
        if (recovery.currentRunId) card.append(el('div', 'recovery-info', '当前运行 · ' + recovery.currentRunId));
        if (recovery.closedAt) card.append(el('div', 'recovery-info', '会话已关闭 · ' + date(recovery.closedAt)));
        if (recovery.expiresAt) card.append(el('div', 'recovery-info', '会话有效期' + (Date.parse(recovery.expiresAt) < Date.now() ? '（已过期）' : '') + ' · ' + date(recovery.expiresAt)));
        if (options.onRecover) {
          const retry = el('button', 'iconbutton recovery-retry', recovery.busy ? '补读中…' : '重新补读当前会话');
          retry.type = 'button';
          retry.disabled = !recovery.canRetry || !!view.recoveryPending;
          retry.title = '只读补读当前会话，不改变监听开关；至少间隔 5 秒';
          retry.addEventListener('click', () => {
            if (!retry.disabled) void options.onRecover(view);
          });
          card.append(retry);
        }
        if (['waiting', 'partial', 'error', 'expired'].includes(recovery.phase)) card.append(el('div', 'recovery-info', '回放可能不完整，或授权已过期。'));
        if (archive) {
          const raw = el('div', 'raw-archive-status');
          raw.setAttribute('data-warning', String(archive.warning));
          raw.setAttribute('role', 'status');
          raw.append(el('div', 'raw-archive-title', '原始归档 · ' + archive.label), el('div', 'recovery-info', '事件响应 · ' + archive.events + '；调用详情 · ' + archive.detail));
          raw.append(el('div', 'recovery-info', '已归档 ' + archive.captured + ' 个调用片段 · 本次选取 ' + archive.selected + ' 个'));
          if (view.rawArchive.error) raw.append(el('div', 'recovery-info', view.rawArchive.error));
          if (view.rawArchive.limited) raw.append(el('div', 'recovery-info', '已达到读取或归档上限，未覆盖全部片段。'));
          raw.append(el('div', 'recovery-info', '仅包含本次收到的响应，不代表全部历史记录。'));
          card.append(raw);
        }
        diag.body.append(card);
      }
      const runtimeCard = el('div', 'diag-section runtime-evidence');
      runtimeCard.append(el('div', 'evidence-label', '运行证据 · ' + runtime.label));
      runtimeCard.append(el('div', 'path', runtime.note));
      const timeline = Array.isArray(view.timeline) ? view.timeline : [];
      if (!timeline.length) runtimeCard.append(el('div', 'empty', '尚无带时间戳的运行证据。'));
      for (const item of timeline) {
        const row = el('div', 'evidence-item');
        row.append(
          el('div', 'evidence-label', item.title || '运行证据'),
          el('div', 'evidence-value', item.detail || '未提供'),
          el('div', 'caption', item.at ? '观测于 ' + date(item.at) : '时间未保存')
        );
        runtimeCard.append(row);
      }
      diag.body.append(runtimeCard);
      const collectionCard = el('div', 'diag-section detail-collection');
      collectionCard.append(el('div', 'evidence-label', '详情采集过程 · ' + (view.freshness?.label || (view.collection ? '只读阶段记录' : '旧快照未记录'))));
      for (const [label, value] of globalThis.ArenaCollection?.freshnessRows(view.freshness) || []) {
        const item = el('div', 'evidence-item detail-freshness');
        item.append(el('div', 'evidence-label', label), el('div', 'evidence-value', value));
        collectionCard.append(item);
      }
      const collectionRows = globalThis.ArenaCollection?.collectionRows(view.collection) || [['采集过程', '旧记录未保存阶段诊断；缺失原因未知']];
      for (const [label, value] of collectionRows) {
        const item = el('div', 'evidence-item');
        item.append(el('div', 'evidence-label', label), el('div', 'evidence-value', value));
        collectionCard.append(item);
      }
      collectionCard.append(el('p', 'caption', '仅保留最近一次诊断，不回填历史失败原因；没有终止／保存确认时仍属未知。诊断不参与命名、筛选或归档，不增加请求或自动重试。'));
      diag.body.append(collectionCard);
      if (diagSum.warning) root.append(diagLabel, diag.el);
      function makeFold(key, title, count, className = '') {
        const d = el('details', 'fold' + (className ? ' ' + className : ''));
        d.setAttribute('aria-label', title);
        d.dataset.section = key;
        d.open = opens.includes(key);
        const sum = el('summary'),
          headBox = el('div', 'fold-head');
        headBox.append(el('span', 'fold-title', title));
        if (count) headBox.append(el('span', 'count', count));
        sum.append(headBox);
        const body = el('div', 'fold-body');
        d.append(sum, body);
        return {el: d, body};
      }
      function fold(key, title, count, className = '') {
        const f = makeFold(key, title, count, className);
        root.append(f.el);
        return f.body;
      }
      const detailView = globalThis.ArenaAgentDetailView?.detailView(view.detail) || {turns: [], note: ''};
      root.append(el('div', 'grouplabel', '调用数据'));
      if (!view.calls.length && !detailView.turns.length) {
        root.append(el('div', 'empty-hint', '尚无调用数据 · 开启监听并发送消息后，明细与分层会在此展开'));
      } else {
        const callBody = fold('calls', '调用明细', view.calls.length ? view.calls.length + ' 次' : '暂无明细');
        if (!view.calls.length) callBody.append(el('div', 'empty', '此运行尚未记录调用明细。旧版本未保存的数据不会自动补录。'));
        for (const [i, c] of view.calls.entries()) {
          const item = el('article', 'call'),
            head = el('div', 'row'),
            title = el('div', 'call-title');
          title.append(el('span', 'call-index', String(i + 1).padStart(2, '0')), el('span', '', c.model || '模型未提供'));
          head.append(title, el('span', 'call-state', ArenaTraceView.completion([c])));
          item.append(head, el('div', 'call-sub', c.provider || '供应商未提供'));
          const stats = el('div', 'call-metrics');
          stats.append(el('span', '', 'Token ' + ArenaTraceView.tokens(c.tokens, c.tokensApproximate)), el('span', '', 'trace ' + ArenaTraceView.money(c.costUsd)));
          item.append(stats);
          const row = el('div', 'idrow');
          row.append(el('span', '', 'span'));
          const id = el('code', '', c.spanId);
          id.title = c.spanId;
          const b = el('button', 'iconbutton', '复制');
          b.type = 'button';
          b.setAttribute('aria-label', '复制调用 ' + (i + 1) + ' 的 span ID');
          b.addEventListener('click', () => copy(c.spanId, b, notice));
          row.append(id, b);
          item.append(row);
          callBody.append(item);
        }
        const detailBody = fold('detail', '模型分层与参数（span 详情）', detailView.turns.length ? detailView.turns.length + ' 轮' : '未读取');
        if (!detailView.turns.length)
          detailBody.append(
            el('div', 'empty', detailView.note || '此运行未保存 span 详情。1.5.0 起完成的运行会自动读取 ai.streamText.doStream / token.usage.recorded / spend.recorded 三类 span；旧记录不会补录。')
          );
        else
          detailBody.append(
            el(
              'p',
              'evidence-intro',
              '三层分开显示：Arena 内部 modelName（公开模型含档位后缀，匿名模型为代号）、供应商请求 model、供应商响应 model。不会用任何一层去推断另一层。' +
                (detailView.note ? ' ' + detailView.note + '。' : '')
            )
          );
        if (detailView.quota) {
          const q = el('div', 'evidence-item');
          q.append(
            el('div', 'evidence-label', '账户配额快照（最新一轮 spend.recorded；账户级信息，仅本地保存）'),
            el('div', 'evidence-value', globalThis.ArenaAgentDetailView.quotaText(detailView.quota))
          );
          detailBody.append(q);
        }
        for (const t of detailView.turns) {
          const item = el('article', 'call');
          item.append(el('div', 'call-title', t.title + (t.partial ? '（进行中）' : '')));
          for (const [k, v] of t.rows) {
            const e = el('div', 'evidence-item');
            e.append(el('div', 'evidence-label', k), el('div', 'evidence-value', v));
            item.append(e);
          }
          item.append(el('div', 'path', 'span: ' + t.spanIds.join(', ') + (t.messageId ? ' · message: ' + t.messageId : '')));
          detailBody.append(item);
        }
        if (detailView.turns.length) detailBody.append(el('p', 'footnote', '本卡仅展示已保存字段；显式请求参数、内部名称档位与响应推理 Token 是不同证据，未记录不等于未配置。'));
      }
      root.append(el('div', 'grouplabel', '身份证据'));
      const identitySum = identitySummary(identity, view.historical);
      const identityCard = fold('model-identity', '模型身份与匹配证据', identitySum.text, 'model-identity');
      identityCard.parentElement.setAttribute('data-warning', String(identitySum.warning));
      identityCard.append(
        el(
          'p',
          'evidence-intro',
          '四层值分别来自服务端标签、Arena 内部名、请求侧与响应侧模型字段；不跨层推断实际供应商。' + (view.historical ? '这是历史快照，不是本次重新读取。' : '名称匹配不等于运行完成或已获命名确认。')
        )
      );
      const statuses = {matched: '通过', conflict: '冲突：无法唯一匹配', missing: '内部名未读取', anonymous: '匿名代号：待确认', mismatch: '未匹配：保留待确认'},
        methods = {exact: '名称一致', base: '基础名匹配（既有规则）', 'prefix-boundary': '完整标签前缀＋分隔符边界', namespace: '已知命名空间规范化（仅 zai-org/GLM）'};
      for (const match of identity.matches) {
        const row = el('div', 'evidence-item');
        row.append(
          el('div', 'evidence-label', match.serverLabel),
          el('div', 'evidence-value', statuses[match.status] || '待确认'),
          el('div', 'caption', methods[match.method] || '不选择未经确认的内部名')
        );
        if (match.candidates.length) row.append(el('div', 'evidence-value', match.candidates.join(' / ')));
        identityCard.append(row);
      }
      const origin = row => (row.turn ? '第 ' + row.turn + ' 轮' : '轮次未记录') + (row.spanId ? ' · span ' + row.spanId : '') + (row.partial ? ' · 部分结果' : '');
      for (const [key, title] of [
        ['server', '服务端模型标签'],
        ['internal', 'Arena 内部 modelName'],
        ['request', '请求侧模型字段'],
        ['response', '响应侧模型字段']
      ]) {
        const entries = identity.rows.filter(r => r.layer === key);
        identityCard.append(el('div', 'evidence-label', title));
        if (!entries.length) identityCard.append(el('div', 'empty', '未观察到此层字段'));
        for (const group of groupIdentityRows(entries)) {
          const [first, ...rest] = group.items;
          if (!rest.length) {
            const item = el('div', 'evidence-item');
            item.append(el('div', 'evidence-value', group.value), el('div', 'path', group.path), el('div', 'caption', origin(first)));
            identityCard.append(item);
            continue;
          }
          const item = el('details', 'evidence-item evidence-group'),
            summary = el('summary'),
            head = el('div', 'fold-head');
          head.append(
            el('div', 'evidence-value', group.value),
            el('div', 'path', group.path),
            el('div', 'caption', origin(first) + ' · 共 ' + group.items.length + ' 条' + (!first.partial && rest.some(r => r.partial) ? ' · 含部分结果' : ''))
          );
          summary.append(head);
          item.append(summary);
          for (const row of rest) item.append(el('div', 'group-item', origin(row)));
          identityCard.append(item);
        }
      }
      if (identity.hasAnonymous) identityCard.append(el('div', 'caption', '存在匿名内部名，整体筛选仍保留待确认；单项匹配不代表全部身份已确认。'));
      if (identity.limited || identity.stopped) identityCard.append(el('div', 'caption', '详情读取受限或未完整结束；以上只展示已取得的字段。'));
      const coverage = identity.coverage || globalThis.ArenaTraceView?.callCoverage?.(view.calls, view.detail);
      if (coverage) {
        const c = coverage.counts,
          body = fold('call-coverage', '调用与轮次覆盖', coverageSummary(c), 'call-coverage');
        body.append(
          el('p', 'evidence-intro', 'stream 详情只按同一 span ID 关联；usage/cost 只说明同一轮的证据，不冒充单次调用绑定，也不据此确认路由切换。' + (view.historical ? '历史快照，未重新补读。' : ''))
        );
        body.append(
          el('div', 'caption', '未关联 stream 详情 ' + c.missingStream + ' · 关联冲突 ' + c.ambiguousStream + ' · 部分／异常调用 ' + c.partialStream + ' · 有同轮 usage/cost ' + c.withTurnAccounting)
        );
        const diagnosis = coverage.diagnosis;
        if (diagnosis) {
          const labels = {
            'span-link-conflict': '存在 span 关联冲突，不选择详情，也不认定已完整关联',
            'no-calls': '没有已记录调用',
            'no-saved-detail': '这个快照没有保存详情；无法仅凭导出确定未读取、失败或导出时机',
            'unlinked-stream-details': '有调用未关联已保存详情；原因尚未确定',
            'linked-within-saved-snapshot': '已记录调用在当前保存范围内关联到 stream 详情'
          };
          body.append(el('p', 'caption', labels[diagnosis.status] || '覆盖原因未确定'));
          if (diagnosis.markers.includes('detail-older-than-call-snapshot')) body.append(el('div', 'caption', '详情时间早于调用快照，可能不同步；不是缺失根因的确认'));
          if (diagnosis.markers.includes('saved-limit-marker')) body.append(el('div', 'caption', '已保存受限标记；不能据此认定全部未关联调用都由上限造成'));
          if (diagnosis.markers.includes('saved-stop-marker')) body.append(el('div', 'caption', '已保存读取停止标记；未重试或重新补读'));
        }
        const streamText = {present: '已有对应 stream 详情', partial: '已有 stream，调用或详情未完整／异常', missing: '未保存对应 stream 详情', ambiguous: 'span 关联冲突，未选择详情'},
          accountText = {
            present: '同轮 usage/cost 已保存（非逐调用绑定）',
            'missing-both': '本轮 usage/cost 均缺失',
            'missing-usage': '本轮 usage 缺失',
            'missing-cost': '本轮 cost 缺失',
            partial: '本轮记账字段部分缺失或未完成',
            unlinked: '轮次无法关联，不借用其他轮的内部名'
          };
        for (const row of coverage.calls) {
          const item = el('div', 'evidence-item');
          item.append(
            el('div', 'evidence-label', '调用 ' + row.index + ' · ' + row.model),
            el('div', 'evidence-value', streamText[row.streamState]),
            el('div', 'caption', (row.turn ? '第 ' + row.turn + ' 轮' : '轮次未记录') + ' · ' + accountText[row.accountingState]),
            el('div', 'path', row.spanId ? 'span ' + row.spanId : 'span 未记录')
          );
          if (row.internalNames.length) item.append(el('div', 'caption', '同轮候选：' + row.internalNames.join(' / ') + '；不替代调用身份确认'));
          body.append(item);
        }
        for (const row of coverage.turns) {
          const item = el('div', 'evidence-item');
          item.append(
            el('div', 'evidence-label', '第 ' + row.turn + ' 轮'),
            el('div', 'caption', '已关联调用 ' + row.linkedCalls + ' · stream ' + row.streamDetails + ' · usage ' + row.usageSpans + ' · cost ' + row.costSpans),
            el('div', 'evidence-value', accountText[row.accountingState])
          );
          if (row.internalNames.length) item.append(el('div', 'caption', '内部字段：' + row.internalNames.join(' / ')));
          if (row.multipleServerLabels) item.append(el('div', 'caption', '同轮存在多个服务端标签，不能仅按轮次绑定某一次调用。'));
          body.append(item);
        }
        if (!coverage.calls.length) body.append(el('div', 'empty', '尚无已记录调用，不能从模型标签反推调用覆盖。'));
        if (coverage.detailLimited || coverage.detailStopped || coverage.truncated)
          body.append(el('div', 'caption', '保存／读取范围受限或列表截断；以上不是全部调用详情。最多展示 40 条调用，最多扫描 500 条。'));
      }
      const evidenceBody = fold('evidence', '证据来源', view.evidenceCount ? view.evidenceCount + '/' + view.calls.length + ' 次保留原始标签' : '未保存原始标签');
      evidenceBody.append(el('p', 'evidence-intro', '只读来源：Trigger.dev run events → ai.streamText.doStream。按当前选中的 runId 与 spanId 对齐，不混入其他运行。'));
      if (view.calls.length && !view.evidenceCount)
        evidenceBody.append(el('div', 'legacy', '这是旧版保存的解析结果，未保存原始标签。上方数值可查看，但不能冒充本次重新读取的原始证据。升级后新捕获的运行会保存标签及其来源。'));
      if (!view.calls.length) evidenceBody.append(el('div', 'empty', '尚无可展示的证据。'));
      for (const [i, c] of view.calls.entries()) {
        if (!c.evidence) continue;
        const group = el('article', 'call');
        group.append(el('div', 'call-title', '调用 ' + String(i + 1).padStart(2, '0') + ' · ' + (c.model || '模型未提供')), el('div', 'path', 'spanId: ' + c.spanId));
        for (const [name, label] of [
          ['model', '模型原始标签'],
          ['provider', '供应商原始标识'],
          ['tokens', 'Token 原始标签'],
          ['cost', '费用原始标签']
        ]) {
          const v = c.evidence[name],
            entry = el('div', 'evidence-item');
          entry.append(el('div', 'evidence-label', label), el('div', 'evidence-value', v?.value || '未提供'));
          if (v) entry.append(el('div', 'path', v.path), el('div', 'caption', '观测于 ' + date(v.observedAt)));
          group.append(entry);
        }
        if (c.evidence.flags) {
          const f = c.evidence.flags;
          group.append(el('div', 'path', '状态原始字段：isPartial=' + String(f.isPartial) + ' · isError=' + String(f.isError) + ' · isCancelled=' + String(f.isCancelled)));
        }
        evidenceBody.append(group);
      }
      if (view.evidenceCount && view.evidenceCount < view.calls.length) evidenceBody.append(el('div', 'legacy', '部分调用来自旧记录，未保存原始标签；不会补造证据。'));
      const actions = el('div', 'evidence-actions'),
        copyButton = el('button', 'secondary', '复制证据 JSON'),
        download = el('button', 'secondary', '下载证据 JSON');
      copyButton.type = download.type = 'button';
      copyButton.disabled = download.disabled = !view.calls.length;
      const payload = () => JSON.stringify(ArenaTraceView.exportEvidence(view), null, 2);
      copyButton.addEventListener('click', () => copy(payload(), copyButton, notice));
      download.addEventListener('click', () => {
        const url = URL.createObjectURL(new Blob([payload()], {type: 'application/json'})),
          a = el('a');
        a.href = url;
        a.download = 'arena-evidence-' + (view.runId || 'unknown').replace(/[^\w-]/g, '') + '.json';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        notice.textContent = '已生成脱敏证据文件；旧记录会明确标注来源。';
      });
      actions.append(copyButton, download);
      evidenceBody.append(actions, el('p', 'footnote', '不包含令牌、Cookie、对话正文或原始 trace 全文。标签各自保留观测时间。'));
      if (view.compatibility && ['incompatible', 'partial', 'limited'].includes(view.compatibility.level)) {
        const c = view.compatibility,
          titles = {incompatible: '解析格式变化 · 需要更新扩展', partial: '解析信息不完整', limited: '解析范围受限'};
        const card = fold('compatibility', (view.historical ? '历史快照 · ' : '') + titles[c.level], '查看详情', 'compatibility-status');
        card.append(el('div', 'recovery-info', c.note));
        for (const issue of c.issues || []) {
          const row = el('div', 'evidence-item');
          row.append(el('div', 'evidence-label', issue.location), el('div', 'evidence-value', issue.status));
          card.append(row);
        }
      }
      if (!diagSum.warning) root.append(diagLabel, diag.el);
      root.append(notice);
    }
    // Unified card: pulse is the daily real-time percentage; USD is copied from the latest spend span snapshot.
    // The two values are displayed together but are never converted into one another.
    const SVG = 'http://www.w3.org/2000/svg',
      R = 46,
      C = 2 * Math.PI * R,
      SOURCE = '来源 arena.ai/api/me/pulse · pulse=每日剩余百分比；美元快照来自最新一轮 spend.recorded';
    const usd = n => (typeof n === 'number' && Number.isFinite(n) ? '$' + n.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2}) : '—');
    const shortUsd = n => (typeof n === 'number' && Number.isFinite(n) && Math.abs(n) >= 1000 ? '$' + (Math.round(n / 100) / 10).toString().replace(/\.0$/, '') + 'K' : usd(n));
    const shortStamp = iso =>
      iso && Number.isFinite(Date.parse(iso))
        ? (() => {
            const d = new Date(iso);
            return d.getMonth() + 1 + '-' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
          })()
        : '—';
    function quotaCard(compact = false) {
      const b = pulse || {};
      const q = spanQuotaFromView();
      const rl = formatRateLimitsView();
      const tone = b.tone || 'none';
      const pulseRows = b.rows || [];
      const readAt = spanReadAt();
      const rows = [];
      const remainRow = pulseRows.find(r => r[0] === '今日剩余');
      const readRow = pulseRows.find(r => r[0] === '读取');
      const cleanRead = readRow ? String(readRow[1] || '').replace(/\s*\(\d+ms\)$/, '') : '';
      const extraPulseRows = pulseRows.filter(r => r[0] !== '今日剩余' && r[0] !== '口径' && r[0] !== '读取');
      const usedTags = q ? [q.overLimit === true ? '已超限' : '', !compact && q.allowanceTier ? 'tier ' + q.allowanceTier : ''].filter(Boolean).join(' · ') : '';
      const usedText = q ? usd(q.chargedUserTotalUsd) + (usedTags ? ' (' + usedTags + ')' : '') : '';
      const twoCol = Boolean((remainRow || cleanRead) && q);
      if (twoCol) {
        rows.push(['剩余', remainRow ? remainRow[1] : '—'], ['已用', usedText]);
        rows.push(['读取', cleanRead || '—'], ['快照', readAt ? shortStamp(readAt) : '未读取']);
        rows.push(...extraPulseRows);
      } else {
        if (remainRow) rows.push(['剩余', remainRow[1]]);
        if (usedText) rows.push(['已用', usedText]);
        rows.push(...extraPulseRows);
        if (cleanRead) rows.push(['读取', cleanRead]);
        if (q) rows.push(['快照', readAt ? shortStamp(readAt) : '未读取']);
      }
      const card = el('section', 'quota' + (compact ? ' compact' : ''));
      card.setAttribute('aria-label', '每日额度与账户配额快照');
      let refresh = null;
      if (b.onRefresh) {
        refresh = el('button', 'quota-refresh' + (b.loading ? ' spin' : ''), '↻');
        refresh.type = 'button';
        refresh.title = '重新读取 arena.ai/api/me/pulse';
        refresh.setAttribute('aria-label', '刷新每日额度');
        refresh.disabled = !!b.loading;
        refresh.addEventListener('click', () => b.onRefresh());
      }
      const ring = el('div', 'quota-ring');
      ring.dataset.tone = tone;
      const svg = document.createElementNS(SVG, 'svg');
      svg.setAttribute('viewBox', '0 0 104 104');
      for (const cls of ['track', 'bar']) {
        const c = document.createElementNS(SVG, 'circle');
        c.setAttribute('class', cls);
        c.setAttribute('cx', '52');
        c.setAttribute('cy', '52');
        c.setAttribute('r', String(R));
        if (cls === 'bar') {
          c.setAttribute('stroke-dasharray', C.toFixed(2));
          c.setAttribute('stroke-dashoffset', (C * (1 - Math.min(100, Math.max(0, b.pct ?? 0)) / 100)).toFixed(2));
        }
        svg.append(c);
      }
      const pct = el('div', 'quota-pct');
      if (typeof b.pct === 'number') {
        pct.append(document.createTextNode(String(b.pct >= 99.95 ? 100 : Math.floor(b.pct))));
        pct.append(el('small', '', '%'));
      } else pct.textContent = b.loading ? '…' : '—';
      ring.append(svg, pct);
      const main = el('div', 'quota-main');
      const big = el('div', 'quota-big', q ? usd(q.balanceRemainingUsd) : b.loading ? '读取中…' : '—');
      big.append(el('span', '', '/ ' + (q ? shortUsd(q.allowanceUsd) : '—')));
      const buildRateLimitGrid = () => {
        const rlGrid = el('div', 'ratelimit-grid');
        for (const item of [rl.createChat, rl.apiGeneral]) {
          const row = el('div', 'rl-item');
          row.dataset.tone = item.tone || 'none';
          row.dataset.bucket = item.key;
          if (item.tip) row.title = item.tip;
          const top = el('div', 'rl-top');
          const nameWrap = el('span', 'rl-name');
          nameWrap.append(el('span', '', item.label), el('span', 'rl-tag', item.routeTag));
          const meta = el('span', 'rl-meta');
          const val = el('strong', 'rl-val', item.valueText);
          val.dataset.tone = item.tone || 'none';
          meta.append(val);
          if (item.waitText) meta.append(el('span', 'rl-timer', item.waitText));
          else if (item.expired) meta.append(el('span', 'rl-timer', '可使用'));
          top.append(nameWrap, meta);
          const track = el('div', 'rl-track');
          const fill = el('div', 'rl-fill');
          fill.dataset.tone = item.tone || 'none';
          fill.style.width = (typeof item.pct === 'number' ? item.pct : 0) + '%';
          track.append(fill);
          row.append(top, track);
          rlGrid.append(row);
        }
        return rlGrid;
      };
      if (compact) {
        const headRow = el('div', 'quota-head-row');
        headRow.append(big);
        if (q?.allowanceTier) headRow.append(el('i', 'tier-pill', 'tier ' + q.allowanceTier));
        main.append(headRow);
        if (rows.length) {
          const dl = el('dl', 'quota-rows' + (twoCol ? ' two-col' : ''));
          for (const [k, v] of rows) {
            dl.append(el('dt', '', k), el('dd', '', v));
          }
          main.append(dl);
        }
        const sub = el('div', 'quota-sub');
        if (q) {
          sub.append(el('span', 'quota-tier', q.allowanceTier ? '档位 ' + q.allowanceTier : '美元快照'));
          if (readAt) sub.append(el('span', 'quota-read', '快照 ' + shortStamp(readAt)));
          if (rows.length) sub.hidden = true;
        } else sub.textContent = b.error ? b.error : b.loading ? '读取中…' : '美元快照未读取';
        if (b.error) sub.dataset.error = 'true';
        main.append(sub);
        const body = el('div', 'quota-body');
        if (refresh) body.append(refresh);
        body.append(ring, main);
        const rlSec = el('div', 'ratelimit-section');
        rlSec.append(buildRateLimitGrid());
        card.append(body, rlSec);
        // 悬浮回显只讲两件事：实时的每日剩余，以及独立于它的美元快照。详细来源留在展开卡的脚注。
        card.title = [
          '每日剩余 ' + (typeof b.pct === 'number' ? b.pct + '%' : '未读取') + (b.receivedAt ? '（读取 ' + shortStamp(b.receivedAt) + '）' : ''),
          q ? '账户快照 ' + usd(q.balanceRemainingUsd) + ' / ' + shortUsd(q.allowanceUsd) + (q.allowanceTier ? ' · tier ' + q.allowanceTier : '') + (readAt ? ' · ' + shortStamp(readAt) : '') : '',
          b.error || ''
        ]
          .filter(Boolean)
          .join('\n');
        scheduleRateLimitTick();
        return card;
      }
      const head = el('div', 'quota-head');
      const dot = el('span', 'quota-dot');
      dot.dataset.tone = tone;
      head.append(dot, el('div', 'quota-title', '每日额度与账户快照'));
      if (refresh) head.append(refresh);
      const dl = el('dl', 'quota-rows' + (twoCol ? ' two-col' : ''));
      for (const [k, v] of rows) {
        dl.append(el('dt', '', k), el('dd', '', v));
      }
      if (!rows.length) dl.append(el('dt', '', ''), el('dd', '', b.loading ? '读取中…' : '未读取'));
      main.append(big, dl);
      const body = el('div', 'quota-body');
      body.append(ring, main);
      const rlSec = el('div', 'ratelimit-section');
      const rlHead = el('div', 'ratelimit-head');
      rlHead.append(el('strong', 'ratelimit-title', '接口限流监视（账号 × IP 窗口）'), el('span', 'ratelimit-badge', '1h 滚动窗口'));
      rlSec.append(rlHead, buildRateLimitGrid());
      card.append(head, body, rlSec);
      const foot = el('div', 'quota-foot', b.error ? b.error : SOURCE);
      if (b.error) foot.dataset.error = 'true';
      card.append(foot);
      scheduleRateLimitTick();
      return card;
    }
    function setPulse(next) {
      pulse = next || null;
      if (quotaHost) {
        quotaHost.replaceChildren(quotaCard(true));
        return;
      }
      const old = root.querySelector('.quota');
      if (!old) {
        if (currentView) render(currentView);
        return;
      }
      old.replaceWith(quotaCard());
    }
    if (quotaHost) quotaHost.replaceChildren(quotaCard(true)); // placeholder until the first pulse/span snapshot arrives, so the top row never jumps
    return {render, root, renameModel, setPulse, tickRateLimits};
  }
  globalThis.ArenaTracePanel = {create, coverageSummary, diagnosticsSummary, identitySummary, groupIdentityRows};
})();
