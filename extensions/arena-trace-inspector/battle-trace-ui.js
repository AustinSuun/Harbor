/* Shared safe rendering for the independent Code trace panel and popup history. */
(() => {
 const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
 function render(container,record,historical=true){container.replaceChildren();if(!record)return;const T=globalThis.ArenaBattleTrace,r=T.sanitizeRecord(record);container.append(el('p',historical?'本地 Code trace 历史 · 非本次重新验证':'本次读取 · 已授权 Code 执行 trace（非评分揭示）','source'));
  const runs=[...r.runs].sort((x,y)=>(y.round||0)-(x.round||0)||x.position.localeCompare(y.position));for(const run of runs){const v=T.view(run,r.runs),card=el('article',undefined,'model-card');card.style.overflowWrap='anywhere';card.append(el('h3',v.title));for(const [k,value]of v.rows)card.append(el('p',k+'：'+value,'field'));card.append(el('p',v.warning,'muted'));
   const details=el('details');details.append(el('summary','查看 span 字段证据'));for(const span of v.details){details.append(el('p',span.title,'source'));for(const [k,value]of span.rows)details.append(el('p',k+'：'+value,'field'));}card.append(details);container.append(card);
  }
  container.append(el('p','trace 保存时间：'+new Date(r.observedAt).toLocaleString(),'muted'),el('p','API 标签来自平台执行日志，不等于供应商原始响应或底层权重证明。trace costUsd 与 Battle metadata 的 totalCostUsd 是同一数据，会话累计只计一次；纯文字 Battle 无 trace 入口（2026-09-16 验证）。','muted'));
 }
 globalThis.ArenaBattleTraceUI={render};
})();
