import {formatUsage, summarizeUsage} from './usage.js';
const $ = id => document.getElementById(id);
const status = $('status'), button = $('toggle');
const panel = ArenaTracePanel.create($('result-panel'));
let tabId, currentUrl='', records=[], visibleCount=20, selectedUrl='', selectedRunId='';
let state={enabled:false,status:'检查当前标签页…',models:[]};
const deletingSessions = new Set();
const list=$('history-list'),search=$('search'),historyStatus=$('history-status'),more=$('more'),exportButton=$('export');
function renderPanel() {
  if(selectedUrl&&!records.some(r=>r.url===selectedUrl)){selectedUrl='';selectedRunId='';}
  const record=records.find(r=>r.url===(selectedUrl||currentUrl))||null;
  const effectiveState=selectedUrl ? {} : state;
  const runs=ArenaTraceView.runsFor(record);
  if(selectedRunId&&!runs.some(r=>r.runId===selectedRunId))selectedRunId='';
  const select=$('run-select');select.replaceChildren();
  const base=document.createElement('option');base.value='';base.textContent=effectiveState.runId&&!effectiveState.historical?'本次捕获':'最近保存的运行';select.append(base);
  for(const r of runs){const o=document.createElement('option');o.value=r.runId;o.textContent=r.runId+(r.checkedAt?' · '+new Date(r.checkedAt).toLocaleString():'');select.append(o);}
  select.value=selectedRunId;$('run-select-label').hidden=!runs.length;
  $('view-context').hidden=!selectedUrl;$('view-title').textContent=record?.title||'已保存会话';
  panel.render(ArenaTraceView.build(effectiveState,record,selectedRunId));
}
let balanceLoading=false,balanceInfo=null,balanceError='';
async function loadBalance(force=false){
  if(balanceLoading)return;balanceLoading=true;pushBalance();
  try{const r=await chrome.runtime.sendMessage({type:'ATI_BALANCE',force});if(r?.balance)balanceInfo=r.balance;balanceError=r?.error||'';}catch{balanceError='余额读取失败';}
  finally{balanceLoading=false;pushBalance();}
}
function pushBalance(){const f=globalThis.ArenaBilling?.formatBalance(balanceInfo)||{value:'未提供',note:''};panel.setBalance({...f,loading:balanceLoading,error:balanceError,onRefresh:()=>void loadBalance(true)});}
function render(s) {
  if(!s || s.restoring)return;
  if(s.runId!==state.runId)selectedRunId='';
  state=s;status.textContent=s.status||'未开启';
  button.textContent=s.enabled?'停止监听':'开启当前页监听';
  $('listen-label').textContent=s.enabled?'当前标签页监听中':'当前标签页未监听';
  $('listen-dot').classList.toggle('on',!!s.enabled);renderPanel();
}
button.addEventListener('click',async()=>{button.disabled=true;try{render(await chrome.runtime.sendMessage({type:'ATI_TOGGLE',tabId}));}catch{status.textContent='操作失败，请重新打开扩展';}finally{button.disabled=false;}});
chrome.runtime.onMessage.addListener(msg=>{if(msg.type==='ATI_STATE'&&msg.tabId===tabId)render(msg.state);});
$('run-select').addEventListener('change',e=>{selectedRunId=e.target.value;renderPanel();});
$('back-current').addEventListener('click',()=>{selectedUrl='';selectedRunId='';renderPanel();});
async function deleteRecord(record) {
  if (deletingSessions.has(record.sessionId)) return;
  if (!window.confirm(`删除“${record.title}”的本地记录？\n该会话保存的运行、模型标签和累计用量将被移除，无法撤销。\n不会删除 Arena 网站上的对话。继续监听后，新捕获的结果可能重新生成记录。`)) return;
  deletingSessions.add(record.sessionId);
  renderHistory();
  try {
    const result = await chrome.runtime.sendMessage({type:'ATI_HISTORY_DELETE',sessionId:record.sessionId});
    if (!result?.ok) throw Error(result?.error || '删除本地记录失败，请重试');
    if (selectedUrl === record.url) { selectedUrl=''; selectedRunId=''; }
    await loadHistory();
void loadBalance();
  } catch {
    historyStatus.textContent='删除本地记录失败，请重试；未确认删除成功。';
  } finally {
    deletingSessions.delete(record.sessionId);
    const deleteButton = [...list.querySelectorAll('[data-delete-session]')].find(b=>b.dataset.deleteSession===record.sessionId);
    if (deleteButton) { deleteButton.disabled=false; deleteButton.textContent='删除记录'; }
  }
}
function renderHistory() {
  const query=search.value.trim().toLowerCase();
  const filtered=records.filter(r=>[r.title,r.url,...r.observations.map(o=>o.model+' '+o.provider)].join(' ').toLowerCase().includes(query));
  list.replaceChildren();$('count').textContent=records.length;
  $('all-usage').textContent='全部已捕获累计：'+formatUsage(summarizeUsage(records.flatMap(r=>r.runs||[])));
  historyStatus.textContent=records.length?`匹配 ${filtered.length} 个会话 · 不包含未捕获的历史消耗`:'暂无记录。开启监听并成功识别后会自动保存。';
  exportButton.disabled=!records.length;
  for(const record of filtered.slice(0,visibleCount)){
    const card=document.createElement('article');card.className='record';
    if(record.url===currentUrl){card.classList.add('current');const label=document.createElement('div');label.className='current-label';label.textContent='当前会话 · 本地记录';card.append(label);}
    const row=document.createElement('div');row.className='row';
    const link=document.createElement('a');link.href=record.url;link.target='_blank';link.rel='noopener noreferrer';link.textContent=record.title;
    const inspect=document.createElement('button');inspect.className='small';inspect.type='button';inspect.textContent='查看运行';inspect.addEventListener('click',()=>{selectedUrl=record.url;selectedRunId='';renderPanel();window.scrollTo({top:0,behavior:'smooth'});});const actions=document.createElement('div');actions.className='record-actions';
    const remove=document.createElement('button');remove.className='small danger';remove.type='button';remove.dataset.deleteSession=record.sessionId;
    remove.disabled=deletingSessions.has(record.sessionId);remove.textContent=remove.disabled?'删除中…':'删除记录';
    remove.setAttribute('aria-label','删除本地记录：'+record.title);remove.addEventListener('click',()=>void deleteRecord(record));
    actions.append(inspect,remove);row.append(link,actions);
    const model=document.createElement('div');model.className='model';model.textContent=[...new Set(record.observations.map(o=>o.model+(o.provider?' · '+o.provider:'')))].join(' / ');
    const time=document.createElement('small');time.textContent='最近记录：'+new Date(record.lastSeen).toLocaleString();
    const usage=document.createElement('small');usage.textContent='已捕获累计：'+formatUsage(summarizeUsage(record.runs||[]));
    const url=document.createElement('small');url.className='url';url.textContent=record.url;
    card.append(row,model,usage,time,url);list.append(card);
  }
  more.hidden=filtered.length<=visibleCount;
}
async function loadHistory(){try{const result=await chrome.runtime.sendMessage({type:'ATI_HISTORY_LIST'});if(result.error)throw Error(result.error);records=result.records||[];renderHistory();renderPanel();}catch{historyStatus.textContent='读取记录失败，请重新加载扩展后重试';}}
search.addEventListener('input',()=>{visibleCount=20;renderHistory();});more.addEventListener('click',()=>{visibleCount+=20;renderHistory();});
chrome.storage.onChanged.addListener((_changes,area)=>{if(area==='local')void loadHistory();});
exportButton.addEventListener('click',()=>{const blob=new Blob([JSON.stringify({schemaVersion:1,exportedAt:new Date().toISOString(),conversations:records},null,2)],{type:'application/json'});const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='arena-model-sessions-'+new Date().toISOString().slice(0,10)+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);});
try{
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});tabId=tab?.id;currentUrl=tab?.url?.split(/[?#]/)[0]||'';
  if(!tab?.url||new URL(tab.url).origin!=='https://arena.ai'){render({...state,status:'切换到 Arena 标签页即可开启监听；也可查看下方历史记录。'});}
  else{render(await chrome.runtime.sendMessage({type:'ATI_STATUS',tabId}));button.disabled=false;}
}catch{status.textContent='无法读取标签页，请重新打开扩展';renderPanel();}
await loadHistory();
