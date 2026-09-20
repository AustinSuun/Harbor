/* Shared renderer. Every external value is rendered with textContent, never HTML. */
(() => {
  const css = `
.ati{--bg:#111a20;--surface:#172229;--line:#2b3b42;--text:#e8f1f0;--muted:#94a8ae;--green:#9ae9ca;box-sizing:border-box;color:var(--text);font:13px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;overflow-wrap:anywhere}
.ati *{box-sizing:border-box}.ati button,.ati summary{font:inherit}.ati button{cursor:pointer}.ati button:disabled{opacity:.4;cursor:default}.ati button:focus-visible,.ati summary:focus-visible{outline:2px solid var(--green);outline-offset:3px}.ati .result{border:1px solid #426957;border-radius:14px;padding:18px;background:linear-gradient(135deg,#172d25,#142322)}
.ati .eyebrow{font-size:13px;font-weight:600;letter-spacing:1.2px;text-transform:uppercase;color:var(--green)}.ati .row{display:flex;align-items:center;justify-content:space-between;gap:10px}.ati .source{font-size:10px;padding:3px 8px;border:1px solid #456052;border-radius:20px;color:#bee4d3;white-space:nowrap}.ati .model{font:650 24px/1.28 ui-monospace,Consolas,monospace;letter-spacing:-.6px;margin:13px 0 4px;color:#acf0ce;word-break:break-word}.ati .provider{font-size:12px;color:#b0c8bd;margin-bottom:10px}.ati .provider-kind{margin-bottom:3px;color:#9fb8ad}.ati .model-layers{margin:2px 0 10px;padding:8px 10px;border:1px solid #2f4a42;border-radius:8px;background:#0f1c21}.ati .model-layer{display:flex;flex-wrap:wrap;gap:1px 8px;font-size:11px;line-height:1.7;padding:2px 0}.ati .model-layer+.model-layer{border-top:1px solid #233832;padding-top:5px;margin-top:3px}.ati .model-layer dt{color:#8fa8a2;flex:0 0 auto;margin:0}.ati .model-layer dd{margin:0;color:#d6ece2;font-family:ui-monospace,Consolas,monospace;word-break:break-all;flex:1;min-width:0}.ati .model-layer-note{flex:0 0 100%;color:#8d9c98;font-size:10px}.ati .notice-model-change{margin:6px 0 2px;padding:7px 10px;border:1px solid #5a4c2f;border-radius:8px;background:#241f14;color:#e0c489;font-size:11px;line-height:1.65;overflow-wrap:anywhere}.ati .model-catalog{margin:2px 0 10px;padding:8px 10px;border:1px solid #35544a;border-radius:8px;background:#101f1c}.ati .model-catalog-head{font-size:10px;letter-spacing:.9px;color:#7fc6b0;margin-bottom:5px;overflow-wrap:anywhere}.ati .extra-model{border-top:1px solid #355044;margin-top:12px;padding-top:4px}.ati .idrow{display:flex;align-items:center;gap:7px;color:#abc2b8;font:11px/1.6 ui-monospace,Consolas,monospace}.ati .idrow code{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}.ati .iconbutton,.ati .secondary{border:1px solid #40564f;color:#cce7dc;background:#ffffff06;border-radius:7px;padding:5px 9px;font-size:11px;white-space:nowrap;width:auto}.ati .iconbutton:hover,.ati .secondary:hover{background:#ffffff10}.ati .toplabel{font-size:10px;color:var(--muted);letter-spacing:1.1px;margin:17px 0 9px}.ati .metrics{display:grid;grid-template-columns:1fr 1fr;gap:8px}.ati .metric{min-width:0;padding:13px 14px;background:var(--surface);border:1px solid var(--line);border-radius:10px}.ati .metric-label{color:#a6b7bb;font-size:11px}.ati .metric-value{font:600 20px/1.3 ui-monospace,Consolas,monospace;margin-top:5px;color:#edf5f2}.ati .metric-value.state{font:600 14px/1.9 system-ui,sans-serif}.ati .metric-note{color:var(--muted);font-size:10px;margin-top:4px;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}.ati .footnote{font-size:10px;color:var(--muted);margin:10px 1px 15px}.ati .fold{border:1px solid var(--line);border-radius:10px;background:#141f25;margin-top:9px;overflow:hidden}.ati summary{list-style:none;cursor:pointer;padding:13px 14px;display:flex;align-items:center;justify-content:space-between;gap:8px;font-weight:600}.ati summary::-webkit-details-marker{display:none}.ati summary:after{content:'+';font-size:17px;color:#a1b7b7;font-weight:400}.ati details[open]>summary:after{content:'−'}.ati .count{margin-left:auto;font-size:10px;font-weight:400;color:var(--muted);padding-right:5px}.ati .fold-body{border-top:1px solid var(--line);padding:13px}.ati .call+.call{border-top:1px solid var(--line);padding-top:13px;margin-top:13px}.ati .call-title{font-size:12px;font-weight:650;color:#d8ece4}.ati .call-index{font:11px ui-monospace,Consolas,monospace;color:var(--green);margin-right:7px}.ati .call-state{font-size:10px;color:var(--muted)}.ati .call-sub{color:var(--muted);font-size:11px;margin:5px 0 8px}.ati .call-metrics{display:flex;gap:15px;font-size:12px;margin:8px 0;color:#c4dcd1}.ati .evidence-intro{color:#9ab3b8;font-size:11px;margin:0 0 14px}.ati .evidence-item{border-left:2px solid #466a5a;padding:2px 0 2px 10px;margin:12px 0}.ati .evidence-label{font-size:11px;color:#9eb7ac}.ati .evidence-value{font:12px/1.6 ui-monospace,Consolas,monospace;color:#d9eddf;white-space:pre-wrap}.ati .path{font:10px/1.55 ui-monospace,Consolas,monospace;color:#8da1a8;overflow-wrap:anywhere;margin-top:3px}.ati .legacy{background:#29281f;border:1px solid #514b33;border-radius:8px;padding:10px 12px;font-size:11px;color:#d3c9a8;line-height:1.7}.ati .evidence-actions{display:flex;gap:7px;flex-wrap:wrap;border-top:1px solid var(--line);padding-top:12px;margin-top:12px}.ati .empty{padding:8px 0;font-size:12px;color:var(--muted)}.ati .notice{font-size:11px;min-height:18px;color:#9ae9ca;margin-top:8px}.ati .checked{color:#8fa49e;font-size:10px;margin:9px 0 0}.ati .model-actions{display:flex;flex-direction:column;gap:6px;flex-shrink:0}.ati .rename-status{font-size:11px;color:#9ae9ca;margin:7px 0;white-space:normal}.ati .rename-status:empty{display:none}.ati .rename-status[data-error="true"]{color:#e6c598}.ati .caption{font-size:10px;color:var(--muted)}
`;
  const balanceCss = `.ati .quota{border:1px solid #2e4a40;border-radius:14px;background:linear-gradient(160deg,#152522,#111b1f);margin:0 0 12px;overflow:hidden}
.ati .quota-head{display:flex;align-items:center;gap:8px;padding:11px 14px;border-bottom:1px solid #24383a}.ati .quota-dot{width:7px;height:7px;border-radius:50%;background:#4ade80;box-shadow:0 0 8px #4ade80aa;flex-shrink:0}.ati .quota-dot[data-tone=warn]{background:#fbbf24;box-shadow:0 0 8px #fbbf24aa}.ati .quota-dot[data-tone=low]{background:#f87171;box-shadow:0 0 8px #f87171aa}.ati .quota-dot[data-tone=none]{background:#6b7f7c;box-shadow:none}
.ati .quota-title{flex:1;font:650 13px/1.4 system-ui,sans-serif;color:#e6f2ee;letter-spacing:.3px}.ati .quota-refresh{width:26px;height:26px;padding:0;border:1px solid #33514a;border-radius:7px;background:#ffffff05;color:#bfe0d3;font-size:14px;line-height:1}.ati .quota-refresh:disabled{opacity:.45;cursor:wait}.ati .quota-refresh.spin{animation:ati-spin 1s linear infinite}@keyframes ati-spin{to{transform:rotate(360deg)}}
.ati .quota-body{display:flex;align-items:center;gap:18px;padding:16px 16px 16px 14px}.ati .quota-ring{position:relative;width:104px;height:104px;flex-shrink:0}.ati .quota-ring svg{width:104px;height:104px;transform:rotate(-90deg)}.ati .quota-ring circle{fill:none;stroke-width:10;stroke-linecap:round}.ati .quota-ring .track{stroke:#22332f}.ati .quota-ring .bar{stroke:#4ade80;transition:stroke-dashoffset .6s ease}.ati .quota-ring[data-tone=warn] .bar{stroke:#fbbf24}.ati .quota-ring[data-tone=low] .bar{stroke:#f87171}.ati .quota-ring[data-tone=none] .bar{stroke:#3c4f4b}
.ati .quota-pct{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font:800 22px/1 system-ui,sans-serif;color:#f4fbf8;letter-spacing:-.5px}.ati .quota-pct small{font-size:14px;font-weight:700;margin-left:1px}
.ati .quota-main{min-width:0;flex:1}.ati .quota-big{font:800 26px/1.1 system-ui,sans-serif;color:#f4fbf8;letter-spacing:-.6px;margin-bottom:10px;white-space:nowrap}.ati .quota-big span{font:600 15px/1 system-ui,sans-serif;color:#8ea6a0;margin-left:5px}
.ati .quota-rows{display:grid;grid-template-columns:auto 1fr;gap:6px 12px;font:13px/1.5 system-ui,sans-serif}.ati .quota-rows dt{color:#93aaa5;margin:0}.ati .quota-rows dd{color:#e3eeea;margin:0;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.ati .quota-foot{padding:0 14px 11px;font-size:10px;color:#7f958f}.ati .quota-foot[data-error]{color:#e6c598}
.ati .quota.compact{display:flex;align-items:center;gap:8px;margin:0;padding:7px 8px 7px 9px;cursor:default}.ati .quota.compact .quota-ring,.ati .quota.compact .quota-ring svg{width:48px;height:48px}.ati .quota.compact .quota-ring circle{stroke-width:11}
.ati .quota.compact .quota-pct{font-size:12px;letter-spacing:-.3px}.ati .quota.compact .quota-pct small{font-size:8px}.ati .quota.compact .quota-big{font-size:15px;margin-bottom:3px;overflow:hidden;text-overflow:ellipsis}.ati .quota.compact .quota-big span{font-size:10px;margin-left:3px}
.ati .quota-sub{font-size:10px;line-height:1.4;color:#8ea6a0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ati .quota-sub[data-error]{color:#e6c598}.ati .quota.compact .quota-refresh{width:18px;height:18px;font-size:11px;border-radius:5px;align-self:flex-start;flex-shrink:0}`;
  const actionCss = `.ati .run-meta{margin-top:14px}.ati .rename-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-start;width:100%}.ati .auto-rename{display:flex;align-items:center;gap:4px;font-size:10px;color:#bad9ce;cursor:pointer;white-space:nowrap}.ati .auto-rename input{accent-color:#9ae9ca;width:14px;height:14px;margin:0}.ati .delete-button{color:#f0b3ad;border-color:#78504d}.ati .model-actions{align-items:flex-start;margin-top:16px;padding-top:12px;border-top:1px solid #355044}.ati .model-actions .iconbutton{padding:5px 6px;font-size:9px}.ati .model-actions .rename-row{max-width:100%}`;
  const el = (tag, className, text) => { const e=document.createElement(tag); if(className)e.className=className;if(text!==undefined)e.textContent=text;return e; };
  const date = x => x && Number.isFinite(Date.parse(x)) ? new Date(x).toLocaleString() : '未记录时间';
  async function copy(text, button, notice) {
    const before=button.textContent;
    try { await navigator.clipboard.writeText(text); button.textContent='已复制'; notice.textContent='已复制，不含令牌、Cookie 或正文。'; }
    catch { notice.textContent='复制失败，请使用“下载证据 JSON”，或手动选中文本复制。'; }
    setTimeout(()=>{if(button.isConnected)button.textContent=before;},1500);
  }
  function create(parent, options = {}) {
    const style=el('style');style.textContent=css+actionCss+balanceCss;const root=el('section','ati');parent.append(style,root);let lastRun='',currentView=null,renameBusy=false,renameMessage='',renameFailed=false,renameView=null;
    // Optional host outside the panel root (HUD top row, beside the listen button): the balance card renders there in its compact form.
    const balanceHost=options.balanceHost||null;if(balanceHost)balanceHost.classList.add('ati');
    function updateRename(){
      for(const b of root.querySelectorAll('.rename-button')){b.disabled=renameBusy||!!currentView?.archivePending||!currentView?.models.length;b.textContent=renameBusy?'重命名中…':'重命名对话';}
      const message=root.querySelector('.rename-status');if(message){message.textContent=renameMessage;message.dataset.error=String(renameFailed);}
    }
    let balance=null;
    // The trace's own accounting outranks the endpoint read: arena.ai retired /api/billing/balance,
    // and spend.recorded is written server-side every run. The API value stays as the fallback.
    let traceCard=null;
    // Directory facts are fetched per model name and kept for the life of this panel; a name the
    // directory does not know is cached as null so it is never asked for twice.
    const catalogCache=new Map();let catalogInflight=false,catalogError='';
    const sameName=(a,b)=>String(a||'').toLowerCase().replace(/[^a-z0-9]/g,'')===String(b||'').toLowerCase().replace(/[^a-z0-9]/g,'');
    function ensureCatalog(view){
      if(!options.getCatalog||catalogInflight)return;
      const names=[...new Set(view.models.map(m=>m.model))].filter(n=>n&&!catalogCache.has(n));
      if(!names.length)return;
      catalogInflight=true;
      Promise.resolve(options.getCatalog(names.slice(0,20))).then(result=>{
        const rows=result?.rows;
        if(rows&&typeof rows==='object')for(const name of names)catalogCache.set(name,Array.isArray(rows[name])&&rows[name].length?rows[name]:null);
        else for(const name of names)catalogCache.set(name,null);
        if(result?.error)catalogError=result.error;else catalogError='';
      }).catch(()=>{for(const name of names)catalogCache.set(name,null);})
        .finally(()=>{catalogInflight=false;if(currentView)render(currentView);});
    }
    function catalogBlock(rows){
      const block=el('div','model-catalog');
      block.append(el('div','model-catalog-head','模型目录（公开）'+(catalogError?' · '+catalogError:'')));
      const list=el('dl','model-layers');
      for(const row of rows){const item=el('div','model-layer');item.append(el('dt','',row.label),el('dd','',row.value));list.append(item);}
      block.append(list);
      return block;
    }
    async function renameModel(model,view){
      if(renameBusy)return;renameBusy=true;renameMessage='';renameFailed=false;renameView=view;updateRename();
      try{const result=await options.onRename(model,view);if(currentView?.runId===view.runId&&currentView?.sessionId===view.sessionId)renameMessage=(result?.unchanged?'当前对话已命名为：':'已重命名为：')+(result?.title||model);}
      catch(error){if(currentView?.runId===view.runId&&currentView?.sessionId===view.sessionId){renameFailed=true;renameMessage=error?.message||'重命名失败，请重试';}}
      finally{renameBusy=false;updateRename();}
    }
    function render(view) {
      currentView=view;ensureCatalog(view);if(renameView&&(renameView.runId!==view.runId||renameView.sessionId!==view.sessionId)){renameMessage='';renameFailed=false;}

      const sameRun=lastRun===view.runId;const opens=sameRun?[...root.querySelectorAll('details[open]')].map(x=>x.dataset.section):[];lastRun=view.runId;
      root.replaceChildren();
      const notice=el('div','notice');notice.setAttribute('role','status');notice.setAttribute('aria-live','polite');
      const result=el('article','result');const top=el('div','row');top.append(el('div','eyebrow',view.models.some(m=>m.internal)?'模型（Arena 内部名）':view.models.some(m=>m.matched)?'模型（Trigger.dev 计价匹配）':'服务端模型标签'),el('span','source',view.source));result.append(top);
      if(!view.models.length){result.append(el('h2','model','模型待确认'),el('div','provider',view.runId?'等待本次 trace 返回模型标签':'开启监听后发送消息，或查看本地会话记录'));}
      // A run whose turns landed on different models is stated outright rather than left for the
      // reader to notice from two titles.
      if(view.models.length>1)result.append(el('p','notice-model-change','本次调用出现 '+view.models.length+' 个不同模型（按出现顺序）：'+view.models.map(m=>m.model).join(' → ')));
      for(const [i,m] of view.models.entries()){
        const group=el('div',i?'extra-model':'');const row=el('div','row');row.append(el('h2','model',m.model));group.append(row);
        // Which source the title came from -- only stated when it is not the server label itself.
        // Records saved before 2.1.0 carry internal:true with no nameSource; read those as the
        // confirmed match they were, so old history keeps rendering exactly as it did.
        const kind=m.internal&&m.nameSource!=='internal-only'?'Arena 内部 modelName'
          :m.nameSource==='internal-only'?'Arena 内部 modelName · 与标签主干不一致，按内部名为准'
          :m.nameSource==='trigger-matched'?'Trigger.dev 计价匹配 · 非 Arena 声明，也非权重证明':null;
        if(kind)group.append(el('div','provider provider-kind',kind));
        // One block listing every remaining layer. A row whose value is already the title is
        // dropped -- but its note (the tier reading, say) moves up beside the title instead of
        // being lost, so nothing the run exposed disappears silently.
        const list=el('dl','model-layers');
        const put=(label,value,note)=>{const item=el('div','model-layer');item.append(el('dt','',label),el('dd','',value));if(note)item.append(el('div','model-layer-note',note));list.append(item);};
        put('服务端标签',(m.serverLabel||m.model)+' · '+(m.provider||'供应商未提供'));
        if(view.models.length===1)for(const layer of view.layers||[]){
          if(sameName(layer.value,m.model)){if(layer.note)group.append(el('div','provider provider-kind',layer.note));continue;}
          put(layer.label,layer.value+(layer.conflict?' · 各轮不一致':''),layer.note);
        }
        group.append(list);
        // Directory facts about this model: what it is, where it ranks, what it can do. Fetched
        // once per name from the page's own text-route payload; absent for the draw-only pool.
        const catalog=view.models.length===1?catalogCache.get(m.model):undefined;
        if(catalog&&catalog.length)group.append(catalogBlock(catalog));
        result.append(group);
      }
      if(options.onRename){
        const actions=el('div','model-actions'),row=el('div','rename-row');
        if(options.onAutoRenameChange){
          const label=el('label','auto-rename'),check=el('input');check.type='checkbox';check.checked=!!view.autoRename;check.disabled=!!view.autoRenamePending;
          check.addEventListener('change',()=>void options.onAutoRenameChange(check.checked));
          label.append(check,el('span','','自动重命名'));label.title='开启后每个会话首次完成新检测时自动命名一次；历史恢复不触发';row.append(label);
        }
        const rename=el('button','iconbutton rename-button','重命名对话');rename.type='button';rename.disabled=!view.models.length;
        rename.addEventListener('click',()=>{if(view.models.length)void renameModel(view.models[0].model,view);});row.append(rename);actions.append(row);
        if(options.onDelete){const remove=el('button','iconbutton delete-button',view.deletePending?'删除中…':'删除记录');remove.type='button';remove.disabled=!view.runId||!!view.deletePending;remove.addEventListener('click',()=>void options.onDelete(view));row.append(remove);}
        if(options.onArchive){const archive=el('button','iconbutton delete-button archive-button',view.archivePending?'归档中…':'归档聊天及删除记录');archive.type='button';archive.disabled=!view.sessionId||!!view.deletePending||renameBusy;archive.title='归档 Arena 聊天，并删除扩展本地记录；不等于永久删除聊天';archive.addEventListener('click',()=>void options.onArchive(view));row.append(archive);}
        result.append(actions);
      }
      if(view.runId){const row=el('div','idrow run-meta');row.append(el('span','','run'));const code=el('code','',view.runId);code.title=view.runId;row.append(code);result.append(row,el('div','checked','记录时间 · '+date(view.checkedAt)));}
      if(options.onRename&&view.models.length){const renameStatus=el('div','rename-status');renameStatus.setAttribute('role','status');renameStatus.setAttribute('aria-live','polite');result.append(renameStatus);}
      const nextTrace=view.quotaCard||null;
      const changed=!!nextTrace!==!!traceCard||(nextTrace&&traceCard&&nextTrace.value!==traceCard.value);
      traceCard=nextTrace;
      if(balanceHost){if(changed)balanceHost.replaceChildren(quotaCard(true));}
      else if(traceCard||balance)root.append(quotaCard());root.append(result,el('div','toplabel',view.historical&&view.runId?'所选历史运行 · 已捕获指标':'本次运行 · 已捕获指标'));
      // 2x2 grid, reading order: 状态 (completion + the live background status as its note) → 调用次数 → Token → trace 费用.
      // The note is clamped to two lines by CSS; the full text is always in the title.
      const metrics=el('div','metrics');const statusNote=typeof view.statusText==='string'?view.statusText.trim():'';
      for(const [label,value,note,state]of [
        ['状态',view.completion,statusNote||'仅指已捕获的模型调用',true],
        ['调用次数',view.count,view.calls.length?'按 runId + spanId 去重':'尚无调用明细'],
        ['Token',view.tokens,view.tokenMissing?'部分缺失 · 覆盖 '+view.tokenCoverage+' 次调用':'缩写标为约数；不推算输入／输出'],
        ['trace 费用',view.cost,view.costMissing?'部分缺失 · 覆盖 '+view.costCoverage+' 次调用':'trace 展示值，非实际账单']
      ]){const card=el('div','metric'+(state?' metric-state':''));const noteEl=el('div','metric-note',note);noteEl.title=note;if(state){noteEl.setAttribute('role','status');noteEl.setAttribute('aria-live','polite');}card.append(el('div','metric-label',label),el('div','metric-value'+(state?' state':''),value),noteEl);metrics.append(card);}
      root.append(metrics,el('p','footnote','不将历史记录视为重新验证；未监听的调用不计入累计。'));
      function fold(key,title,count){const d=el('details','fold');d.dataset.section=key;d.open=opens.includes(key);const sum=el('summary');sum.append(el('span','',title),el('span','count',count));const body=el('div','fold-body');d.append(sum,body);root.append(d);return body;}
      const callBody=fold('calls','调用明细',view.calls.length?view.calls.length+' 次':'暂无明细');
      if(!view.calls.length)callBody.append(el('div','empty','此运行尚未记录调用明细。旧版本未保存的数据不会自动补录。'));
      for(const [i,c]of view.calls.entries()){
        const item=el('article','call'),head=el('div','row'),title=el('div','call-title');title.append(el('span','call-index',String(i+1).padStart(2,'0')),el('span','',c.model||'模型未提供'));head.append(title,el('span','call-state',ArenaTraceView.completion([c])));
        item.append(head,el('div','call-sub',c.provider||'供应商未提供'));
        const stats=el('div','call-metrics');stats.append(el('span','','Token '+ArenaTraceView.tokens(c.tokens,c.tokensApproximate)),el('span','','trace '+ArenaTraceView.money(c.costUsd)));item.append(stats);
        const row=el('div','idrow');row.append(el('span','','span'));const id=el('code','',c.spanId);id.title=c.spanId;const b=el('button','iconbutton','复制');b.type='button';b.setAttribute('aria-label','复制调用 '+(i+1)+' 的 span ID');b.addEventListener('click',()=>copy(c.spanId,b,notice));row.append(id,b);item.append(row);callBody.append(item);
      }
      const detailView=globalThis.ArenaAgentDetailView?.detailView(view.detail)||{turns:[],note:''};
      const detailBody=fold('detail','模型分层与参数（span 详情）',detailView.turns.length?detailView.turns.length+' 轮':'未读取');
      if(!detailView.turns.length)detailBody.append(el('div','empty',detailView.note||'此运行未保存 span 详情。1.5.0 起完成的运行会自动读取 ai.streamText.doStream / token.usage.recorded / spend.recorded 三类 span；旧记录不会补录。'));
      else detailBody.append(el('p','evidence-intro','三层分开显示：Arena 内部 modelName（公开模型含档位后缀，匿名模型为代号）、供应商请求 model、供应商响应 model。不会用任何一层去推断另一层。'+(detailView.note?' '+detailView.note+'。':'')));
      if(detailView.quota){const q=el('div','evidence-item');q.append(el('div','evidence-label','账户配额快照（最新一轮 spend.recorded；账户级信息，仅本地保存）'),el('div','evidence-value',globalThis.ArenaAgentDetailView.quotaText(detailView.quota)));detailBody.append(q);}
      for(const t of detailView.turns){
        const item=el('article','call');item.append(el('div','call-title',t.title+(t.partial?'（进行中）':'')));
        for(const [k,v]of t.rows){const e=el('div','evidence-item');e.append(el('div','evidence-label',k),el('div','evidence-value',v));item.append(e);}
        item.append(el('div','path','span: '+t.spanIds.join(', ')+(t.messageId?' · message: '+t.messageId:'')));detailBody.append(item);
      }
      if(detailView.turns.length)detailBody.append(el('p','footnote','显式推理档位（effort / thinking budget）在 2026-09-16 的样本中未出现在 span 属性里；此处只报告是否存在相关键，不推测档位。'));
      const evidenceBody=fold('evidence','证据来源',view.evidenceCount?view.evidenceCount+'/'+view.calls.length+' 次保留原始标签':'未保存原始标签');
      evidenceBody.append(el('p','evidence-intro','只读来源：Trigger.dev run events → ai.streamText.doStream。按当前选中的 runId 与 spanId 对齐，不混入其他运行。'));
      if(view.calls.length&&!view.evidenceCount)evidenceBody.append(el('div','legacy','这是旧版保存的解析结果，未保存原始标签。上方数值可查看，但不能冒充本次重新读取的原始证据。升级后新捕获的运行会保存标签及其来源。'));
      if(!view.calls.length)evidenceBody.append(el('div','empty','尚无可展示的证据。'));
      for(const [i,c]of view.calls.entries()){
        if(!c.evidence)continue;const group=el('article','call');group.append(el('div','call-title','调用 '+String(i+1).padStart(2,'0')+' · '+(c.model||'模型未提供')),el('div','path','spanId: '+c.spanId));
        for(const [name,label]of [['model','模型原始标签'],['provider','供应商原始标识'],['tokens','Token 原始标签'],['cost','费用原始标签']]){
          const v=c.evidence[name],entry=el('div','evidence-item');entry.append(el('div','evidence-label',label),el('div','evidence-value',v?.value||'未提供'));
          if(v)entry.append(el('div','path',v.path),el('div','caption','观测于 '+date(v.observedAt)));
          group.append(entry);
        }
        if(c.evidence.flags){const f=c.evidence.flags;group.append(el('div','path','状态原始字段：isPartial='+String(f.isPartial)+' · isError='+String(f.isError)+' · isCancelled='+String(f.isCancelled)));}
        evidenceBody.append(group);
      }
      if(view.evidenceCount&&view.evidenceCount<view.calls.length)evidenceBody.append(el('div','legacy','部分调用来自旧记录，未保存原始标签；不会补造证据。'));
      const actions=el('div','evidence-actions'),copyButton=el('button','secondary','复制证据 JSON'),download=el('button','secondary','下载证据 JSON');
      copyButton.type=download.type='button';copyButton.disabled=download.disabled=!view.calls.length;
      const payload=()=>JSON.stringify(ArenaTraceView.exportEvidence(view),null,2);
      copyButton.addEventListener('click',()=>copy(payload(),copyButton,notice));
      download.addEventListener('click',()=>{const url=URL.createObjectURL(new Blob([payload()],{type:'application/json'})),a=el('a');a.href=url;a.download='arena-evidence-'+(view.runId||'unknown').replace(/[^\w-]/g,'')+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);notice.textContent='已生成脱敏证据文件；旧记录会明确标注来源。';});
      actions.append(copyButton,download);evidenceBody.append(actions,el('p','footnote','不包含令牌、Cookie、对话正文或原始 trace 全文。标签各自保留观测时间。'));
      root.append(notice);updateRename();
    }
    // Ring card: percentage of today's free credits left. Values are copied from the API; nothing is converted to USD.
    // compact=true (HUD top row): ring + remaining/total + refresh time only; the other rows, the source note and any error text go into the tooltip.
    const SVG='http://www.w3.org/2000/svg',R=46,C=2*Math.PI*R,SOURCE='来源 arena.ai/api/billing/balance · credits 口径，不换算美元';
    function quotaCard(compact=false){
      const b=traceCard||balance||{};const tone=b.tone||'none';const rows=b.rows||[];const card=el('section','quota'+(compact?' compact':''));card.setAttribute('aria-label','账号额度');
      let refresh=null;if(b.onRefresh){refresh=el('button','quota-refresh'+(b.loading?' spin':''),'↻');refresh.type='button';refresh.title='重新读取 arena.ai/api/billing/balance';refresh.setAttribute('aria-label','刷新额度');refresh.disabled=!!b.loading;refresh.addEventListener('click',()=>b.onRefresh());}
      const ring=el('div','quota-ring');ring.dataset.tone=tone;
      const svg=document.createElementNS(SVG,'svg');svg.setAttribute('viewBox','0 0 104 104');
      for(const cls of ['track','bar']){const c=document.createElementNS(SVG,'circle');c.setAttribute('class',cls);c.setAttribute('cx','52');c.setAttribute('cy','52');c.setAttribute('r',String(R));if(cls==='bar'){c.setAttribute('stroke-dasharray',C.toFixed(2));c.setAttribute('stroke-dashoffset',(C*(1-Math.min(100,Math.max(0,b.pct??0))/100)).toFixed(2));}svg.append(c);}
      const pct=el('div','quota-pct');if(typeof b.pct==='number'){pct.append(document.createTextNode(String(b.pct>=99.95?100:Math.floor(b.pct))));pct.append(el('small','','%'));}else pct.textContent=b.loading?'…':'—';
      ring.append(svg,pct);
      const main=el('div','quota-main');const big=el('div','quota-big',b.short||'—');big.append(el('span','','/ '+(b.total||'—')));
      if(compact){
        // 下次额度重置 is a *future* instant -- measured ~22 h ahead of the read time and pinned
        // across reads -- so it legitimately never moves. 读取 is when this extension last read the
        // endpoint. Labelling the first "刷新" made a value that cannot change look like a stale read.
        const reset=rows.find(r=>r[0]==='下次额度重置')?.[1];
        const tier=rows.find(r=>r[0]==='额度档位')?.[1];
        const read=String(rows.find(r=>r[0]==='读取')?.[1]||'').split(' (')[0];
        const line=[tier?'档位 '+tier:'',reset?'下次重置 '+reset:'',read?'读取 '+read:''].filter(Boolean).join(' · ');
        const sub=el('div','quota-sub',b.error?b.error:line||(b.loading?'读取中…':'未读取'));if(b.error)sub.dataset.error='true';
        main.append(big,sub);card.append(ring,main);if(refresh)card.append(refresh);
        card.title=['账号额度',...rows.map(([k,v])=>k+' '+v),b.error||'',b.source||SOURCE].filter(Boolean).join(' · ');
        return card;
      }
      const head=el('div','quota-head');const dot=el('span','quota-dot');dot.dataset.tone=tone;head.append(dot,el('div','quota-title','账号额度'));if(refresh)head.append(refresh);
      const dl=el('dl','quota-rows');
      for(const [k,v] of rows){dl.append(el('dt','',k),el('dd','',v));}
      if(!rows.length)dl.append(el('dt','',''),el('dd','',b.loading?'读取中…':'未读取'));
      main.append(big,dl);const body=el('div','quota-body');body.append(ring,main);card.append(head,body);
      const foot=el('div','quota-foot',b.error?b.error:SOURCE);if(b.error)foot.dataset.error='true';card.append(foot);
      return card;
    }
    function setBalance(next){balance=next||null;if(balanceHost){balanceHost.replaceChildren(quotaCard(true));return;}const old=root.querySelector('.quota');if(!old){if(currentView)render(currentView);return;}old.replaceWith(quotaCard());}
    if(balanceHost)balanceHost.replaceChildren(quotaCard(true)); // placeholder ring until the first balance arrives, so the top row never jumps
    return {render,root,renameModel,setBalance};
  }
  globalThis.ArenaTracePanel={create};
})();
