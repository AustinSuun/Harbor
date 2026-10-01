import {sanitizeCollection, withPersistence, persistCollectionFailure} from './collection.js';
import './model-label-global.js';
import './draw-prefs-global.js';
import {createDrawTaskService, TASK_MESSAGES} from './draw-task-service.js';
import {createListenerIntent} from './listener-intent.js';
import './view-model.js';
import {recoverSessionRun} from './session-bootstrap.js';
import {isArena, streamSession, decode64, validateToken, validateSessionToken, SSEParser, publicTokens, extractModels, streamEventTypes, parseTrace} from './core.js';
import {createHistoryStore, conversationUrl, createAutoRenameStore} from './history.js';
import {extractUsage, mergeUsage, summarizeUsage, formatUsage} from './usage.js';
import {sessionFromUrl, emptyView, historicalView} from './restore.js';
import {createHudPreferences} from './hud-preferences.js';
import {readAgentDetail, detailComplete, detailSnapshotKey, selectDetailSpans, quotaFromDetail, planDetailCollection} from './agent-detail.js';
import {createPulseReader, parseRateLimitHeaders, mergeRateLimits} from './billing.js';
import {createAccountReader} from './account.js';
import {sanitizeTranscript, stripTranscript} from './transcript.js';
import {createChatStore, shapeChatForExport, normalizeChatTitle} from './chat-store.js';
import {createRawStore} from './raw-store.js';
import {summarizeRawRecords} from './sensitive-summary.js';
import {inspectTraceCompatibility, traceCompatibilityFailure} from './compatibility.js';
import {createDrawPrefsStore} from './draw-prefs.js';
import {detectSwitch, mergeSwitch, watchStatus} from './model-switch.js';

// Battle data never reuses Agent run IDs or trace authorization.
import './battle-core.js';
import {createBattleTraceService} from './battle-trace-service.js';
const battleHistory = globalThis.ArenaBattleCore.createStore(chrome.storage.local);
const history = createHistoryStore(chrome.storage.local);
// 2.4.0: three separate stores. Metadata, chat text and raw traces never share a record.
const chats = createChatStore(chrome.storage.local);
const rawTraces = createRawStore(chrome.storage.local);
const autoRename = createAutoRenameStore(chrome.storage.local);
const storageReady = chrome.storage.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'}).then(
  () => true,
  () => false
);

const battleTrace = createBattleTraceService({fetch: (...args) => fetch(...args), storage: chrome.storage.local, tabs: chrome.tabs, ready: storageReady});

const hudPreferences = createHudPreferences(chrome.storage.local, storageReady);
const drawPrefs = createDrawPrefsStore(chrome.storage.local, storageReady);
const pulse = createPulseReader({fetch: (...args) => fetch(...args)});
const drawTasks = createDrawTaskService({
  chrome,
  ready: storageReady,
  isArena,
  sessionFromUrl,
  stateFor: tabId => safeState(sessions.get(tabId)),
  recover: recoverCurrentSession,
  cleanup: async (sessionId, fingerprint) => {
    if ([...sessions.values()].some(s => !s.halted && s.pageSession === sessionId)) throw Error('目标会话仍在监听，请先关闭该页监听再清理本地记录');
    return history.removeIfUnchanged(sessionId, fingerprint);
  },
  viewFor: state => globalThis.ArenaTraceView.build(state)
});
const account = createAccountReader({fetch: (...args) => fetch(...args)});
// 2.3.0 preference: capture the transcript automatically after each completed run.
// 2.9.2+: Default ON (`!== false`), respecting explicit user unchecking (`false`).
const TRANSCRIPT_AUTO_KEY = 'ati.transcript.auto.v1';
const transcriptAutoEnabled = async () => (await chrome.storage.local.get(TRANSCRIPT_AUTO_KEY))[TRANSCRIPT_AUTO_KEY] !== false;
// 2.4.0: verbatim trace archiving, default OFF because it stores a bearer token.
const RAW_ARCHIVE_KEY = 'ati.raw.enabled.v1';
// 默认关闭：留存的 payload 可能含令牌与正文。这条默认值由 4 条测试守着（它们的写法是
// 「显式设 true → 用完 delete」，一旦改成默认开启，所有未显式设置的场景都会开始落盘）。
const rawArchiveEnabled = async () => (await chrome.storage.local.get(RAW_ARCHIVE_KEY))[RAW_ARCHIVE_KEY] === true;

/* Latest conversation titles. GET /api/history/unified returns
   {entries:[{type,id,title,createdAt,updatedAt,...}], pagination:{hasMore,cursor,limit}}.

   2.4.0: the endpoint is CURSOR-paginated and hard-caps `limit` at 20 (limit=200 -> HTTP
   400; pageSize/page/offset are ignored). 2.3.0 read only the first page, so any session
   older than the newest 20 silently kept its placeholder title — reproduced live with a
   session whose real title was "claude-fable-5.1-max" sitting on page 2.
   Follow the cursor, with a page cap so a large history cannot stall an export. */
const HISTORY_UNIFIED_URL = 'https://arena.ai/api/history/unified?includeArchived=true';
const TITLE_PAGE_LIMIT = 25; // 25 * 20 = 500 sessions
async function readLatestTitles({maxPages = TITLE_PAGE_LIMIT, stopAtId = null, onPage = null} = {}) {
  const map = new Map();
  let cursor = null,
    pages = 0,
    truncated = false;
  while (pages < maxPages) {
    const url = HISTORY_UNIFIED_URL + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
    const res = await fetch(url, {method: 'GET', credentials: 'include', cache: 'no-store', redirect: 'error', headers: {Accept: 'application/json'}});
    if (!res.ok) {
      if (pages) break;
      throw new Error('会话列表返回 HTTP ' + res.status);
    }
    const body = await res.json();
    const entries = Array.isArray(body?.entries) ? body.entries : [];
    for (const e of entries) {
      if (!e || typeof e.id !== 'string' || typeof e.title !== 'string') continue;
      if (!map.has(e.id)) map.set(e.id, e.title.slice(0, 300));
    }
    pages++;
    if (onPage) {
      try {
        onPage(pages, map.size);
      } catch {}
    }
    if (stopAtId && map.has(stopAtId)) break;
    const next = body?.pagination;
    if (!next?.hasMore || typeof next.cursor !== 'string' || !next.cursor || next.cursor === cursor) break;
    cursor = next.cursor;
    if (pages >= maxPages) truncated = true;
  }
  map.pagesRead = pages;
  map.truncated = truncated;
  return map;
}
const sessions = new Map();
const listenIntent = createListenerIntent(chrome.storage.session);
const listenCommands = new Map();
const archiveTickets = new Map();
const ACCOUNT_QUOTA_KEY = 'ati.accountQuota.v1';
function cleanAccountQuota(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  if (typeof raw.allowanceTier === 'string' && raw.allowanceTier.length <= 100) out.allowanceTier = raw.allowanceTier;
  if (typeof raw.allowanceUsd === 'number' && Number.isFinite(raw.allowanceUsd) && raw.allowanceUsd >= 0) out.allowanceUsd = raw.allowanceUsd;
  if (typeof raw.chargedUserTotalUsd === 'number' && Number.isFinite(raw.chargedUserTotalUsd) && raw.chargedUserTotalUsd >= 0) out.chargedUserTotalUsd = raw.chargedUserTotalUsd;
  if (typeof raw.balanceRemainingUsd === 'number' && Number.isFinite(raw.balanceRemainingUsd)) out.balanceRemainingUsd = raw.balanceRemainingUsd;
  if (typeof raw.overLimit === 'boolean') out.overLimit = raw.overLimit;
  if (typeof raw.surface === 'string' && raw.surface.length <= 100) out.surface = raw.surface;
  if (typeof raw.checkedAt === 'string' && raw.checkedAt.length <= 40 && Number.isFinite(Date.parse(raw.checkedAt))) out.checkedAt = raw.checkedAt;
  return Object.keys(out).length ? out : null;
}
function latestRecordQuota(record) {
  const all = (record?.runs || []).map(run => cleanAccountQuota(quotaFromDetail(run?.detail))).filter(Boolean);
  return all.sort((a, b) => String(a.checkedAt || '').localeCompare(String(b.checkedAt || ''))).at(-1) || null;
}
// 快照可能由任意标签页写入：始终取最新的一份，而不是本会话最先缓存到的那份，
// 否则第二个标签页会一直显示过期的美元数字。
const newerQuota = (a, b) => (!a ? b || null : !b ? a : String(b.checkedAt || '') > String(a.checkedAt || '') ? b : a);
async function loadAccountQuota() {
  try {
    if (!(await storageReady)) return null;
    const data = await chrome.storage.local.get(ACCOUNT_QUOTA_KEY);
    return cleanAccountQuota(data?.[ACCOUNT_QUOTA_KEY]);
  } catch {
    return null;
  }
}
async function rememberAccountQuota(quota) {
  const clean = cleanAccountQuota(quota);
  if (!clean || !(await storageReady)) return;
  try {
    await chrome.storage.local.set({[ACCOUNT_QUOTA_KEY]: clean});
  } catch {}
}
const RATE_LIMITS_KEY = 'ati.rateLimits.v1';
let latestRateLimits = null;
async function loadRateLimits() {
  try {
    if (!(await storageReady)) return latestRateLimits;
    const data = await chrome.storage.local.get(RATE_LIMITS_KEY);
    latestRateLimits = mergeRateLimits(latestRateLimits, data?.[RATE_LIMITS_KEY]);
    return latestRateLimits;
  } catch {
    return latestRateLimits;
  }
}
async function rememberRateLimits(patch) {
  if (!patch) return latestRateLimits;
  const base = await loadRateLimits();
  const next = mergeRateLimits(base, patch);
  if (!next) return latestRateLimits;
  latestRateLimits = next;
  try {
    if (await storageReady) await chrome.storage.local.set({[RATE_LIMITS_KEY]: next});
  } catch {}
  return next;
}
const command = (tabId, method, params = {}) => chrome.debugger.sendCommand({tabId}, method, params);
// Read-only UI context; never stored and never consulted by collection/action gates.
function detailObservation(s) {
  const r = s.detailReceipt;
  const current = r && r.generation === s.generation && r.turnVersion === (s.turnVersion || 0) && r.runId === s.claims?.runId;
  return {
    schemaVersion: 1,
    sessionId: s.pollSession || null,
    runId: s.claims?.runId || null,
    selectionKey: s.detailSnapshot || null,
    savedKey: current ? r.key : null,
    waitingForTurn: s.waitForNewTurn === true
  };
}
// 手动重拉的可用性：把「为什么不能点」一并给出来，避免界面上又出现一个无声的灰按钮。
function rerunState(s) {
  if (!s || s.halted) return {available: false, reason: '需先开启当前页监听'};
  if (!s.token || !s.claims?.runId) return {available: false, reason: '尚未取得当前运行授权'};
  // 不把 pollInFlight 算作忙：监听期间轮询几乎连续，算上它按钮在唯一可用的场景下点不动。
  // 并发安全由 kickPoll 自己的排队（pollAgain）与 5 秒节流共同保证。
  if (s.generating || s.bootstrap) return {available: false, reason: '正在生成中'};
  if (Date.now() - (s.lastRerun || 0) < RERUN_MIN_INTERVAL_MS) return {available: false, reason: '距上次重拉不足 5 秒'};
  return {available: true, reason: '', runId: s.claims.runId};
}
const safeState = s =>
  s
    ? {
        ...s.view,
        detailObservation: detailObservation(s),
        enabled: !s.halted,
        listeningRequested: !s.halted,
        listenState: s.halted ? 'blocked' : 'listening',
        generating: !!s.generating,
        rerun: rerunState(s),
        ...(s.halted ? {captureHalted: true} : {}),
        ...(s.accountQuota ? {accountQuota: s.accountQuota} : {}),
        ...(latestRateLimits ? {rateLimits: latestRateLimits} : {})
      }
    : {enabled: false, ...emptyView(), ...(latestRateLimits ? {rateLimits: latestRateLimits} : {})};
const RERUN_MIN_INTERVAL_MS = 5000;
const restoreTickets = new Map();
const invalidateRestore = tabId => restoreTickets.set(tabId, (restoreTickets.get(tabId) || 0) + 1);
function publish(tabId, state) {
  drawTasks.observe(tabId, state);
  chrome.tabs.sendMessage(tabId, {type: 'ATI_STATE', state}).catch(() => {});
  chrome.runtime.sendMessage({type: 'ATI_STATE', tabId, state}).catch(() => {});
  // 2.3.0 auto-capture (default on since 2.9.2 unless the user explicitly disabled it): ask the page to send its transcript once the run
  // is saved and no longer partial. The content script does the DOM read; the page may
  // ignore this. Never fires while a run is still streaming.
  if (state?.saved && state.sessionId && !state.usage?.partial) {
    transcriptAutoEnabled()
      .then(on => {
        if (on) chrome.tabs.sendMessage(tabId, {type: 'ATI_TRANSCRIPT_REQUEST', sessionId: state.sessionId}).catch(() => {});
      })
      .catch(() => {});
  }
  const switched = state.switch?.state === 'switched';
  chrome.action.setBadgeText({tabId, text: switched ? '!' : state.historical ? 'H' : state.enabled ? (state.models.length ? 'OK' : 'ON') : ''}).catch(() => {});
  chrome.action.setBadgeBackgroundColor({tabId, color: switched ? '#8b2e2e' : state.historical ? '#65583c' : '#165f54'}).catch(() => {});
}
function alignPage(tabId, url) {
  const s = sessions.get(tabId),
    id = sessionFromUrl(url);
  if (s && s.pageSession !== id) {
    // Moving from the new-chat route to its first stream's session is not a new job.
    const adoptingNewChat = s.pageSession === null && id !== null && s.activeSession === id;
    s.pageSession = id;
    invalidateRestore(tabId);
    if (!adoptingNewChat) {
      cancelLookup(s);
      s.bootstrapAttempted = null;
      s.sessionToken = null;
      s.scanTicket = (s.scanTicket || 0) + 1;
      s.streams.clear();
      s.activeSession = id;
      s.resolvedRun = null;
      s.hasCapture = false;
      s.view = emptyView(id, !s.halted);
      if (s.halted) s.view.status = s.haltReason || '监听已安全停止；切换页面不会重新开启';
      publish(tabId, safeState(s));
    }
    if (id && !s.halted) void scanPageToken(tabId, s);
  }
}
function hasLiveView(s, id) {
  return !!s && (s.hasCapture || (!s.view.historical && !!s.view.runId)) && (s.view.sessionId === id || (!id && s.pageSession === null));
}
async function restoreForTab(tabId, expectedUrl = null) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const pageUrl = tab?.pendingUrl || tab?.url;
  if (expectedUrl && sessionFromUrl(expectedUrl) !== sessionFromUrl(pageUrl))
    return {enabled: !!sessions.get(tabId) && !sessions.get(tabId).halted, ...emptyView(sessionFromUrl(expectedUrl)), restoring: true};
  if (!tab || !isArena(pageUrl)) return {enabled: false, ...emptyView()};
  alignPage(tabId, pageUrl);
  const id = sessionFromUrl(pageUrl),
    s = sessions.get(tabId);
  if (hasLiveView(s, id)) {
    publish(tabId, safeState(s));
    return safeState(s);
  }
  invalidateRestore(tabId);
  const ticket = restoreTickets.get(tabId);
  let record = null,
    failed = false,
    accountQuota = s?.accountQuota || null;
  if (id) {
    try {
      if (!(await storageReady)) throw Error('storage unavailable');
      record = await history.get(id);
    } catch {
      failed = true;
    }
  }
  accountQuota = newerQuota(newerQuota(accountQuota, await loadAccountQuota()), latestRecordQuota(record));
  if (accountQuota && accountQuota !== s?.accountQuota) void rememberAccountQuota(accountQuota);
  const rateLimits = await loadRateLimits();
  const currentTab = await chrome.tabs.get(tabId).catch(() => null);
  // A slow disk read must never overwrite a newer navigation or live trace.
  if (
    !currentTab ||
    !isArena(currentTab.pendingUrl || currentTab.url) ||
    sessionFromUrl(currentTab.pendingUrl || currentTab.url) !== id ||
    restoreTickets.get(tabId) !== ticket ||
    sessions.get(tabId) !== s
  ) {
    return {
      enabled: !!sessions.get(tabId) && !sessions.get(tabId).halted,
      ...emptyView(sessionFromUrl(currentTab?.pendingUrl || currentTab?.url), !!sessions.get(tabId) && !sessions.get(tabId).halted),
      restoring: true
    };
  }
  if (hasLiveView(s, id)) return safeState(s);
  const view = historicalView(record, id, !!s && !s.halted) || emptyView(id, !!s && !s.halted);
  if (s?.view.sessionId === id) for (const key of ['recovery', 'sessionInfo']) if (s.view[key]) view[key] = s.view[key];
  if (failed) view.status = '本地记录恢复失败；未删除已有记录，请重新打开插件重试。';
  if (s) {
    s.view = view;
    s.accountQuota = accountQuota;
  }
  if (s?.halted) view.status = s.haltReason || '监听已安全停止';
  const state = s
    ? safeState(s)
    : {
        enabled: false,
        ...view,
        listeningRequested: listenIntent.has(tabId),
        listenState: listenIntent.has(tabId) ? 'reconnecting' : 'stopped',
        ...(accountQuota ? {accountQuota} : {}),
        ...(rateLimits ? {rateLimits} : {})
      };
  publish(tabId, state);
  return state;
}

function recovery(tabId, s, phase, message, extra = {}) {
  update(tabId, s, {recovery: {...(s.view.recovery || {}), ...extra, phase, message, checkedAt: new Date().toISOString()}});
}
async function scanPageToken(tabId, s) {
  const sessionId = s.pageSession,
    ticket = (s.scanTicket || 0) + 1;
  s.scanTicket = ticket;
  if (!sessionId || s.halted) return;
  recovery(tabId, s, 'scan', '正在扫描当前页面授权', {source: 'page'});
  try {
    const result = await chrome.tabs.sendMessage(tabId, {type: 'ATI_SCAN_PAGE_TOKEN'});
    if (sessions.get(tabId) === s && !s.halted && s.pageSession === sessionId && s.scanTicket === ticket && s.view.recovery?.phase === 'scan')
      recovery(tabId, s, 'waiting', result?.found ? '页面授权已提交，等待运行信息' : '当前页面未找到可用授权；可刷新页面后重新补读');
  } catch {
    if (sessions.get(tabId) === s && !s.halted && s.pageSession === sessionId && s.scanTicket === ticket) recovery(tabId, s, 'error', '页面扫描脚本不可用，请刷新 Arena 页面');
  }
}

function update(tabId, s, patch) {
  if (sessions.get(tabId) !== s) return;
  Object.assign(s.view, patch);
  publish(tabId, safeState(s));
}

function cancelLookup(s) {
  if (s.view) s.view.renameReady = false;
  s.bootstrap?.controller.abort();
  s.bootstrap = null;
  s.generation++;
  clearTimeout(s.timer);
  s.abort?.abort();
  s.detailAbort?.abort();
  s.token = null;
  s.lastToken = null;
  s.claims = null;
  s.generating = false;
  s.finishPolls = 0;
  s.pollInFlight = false;
  s.pollAgain = false;
}
function notifySwitch(sessionId, sw) {
  if (!sw || sw.state !== 'switched' || typeof chrome.notifications?.create !== 'function') return;
  const message = (sw.from || '原模型') + ' → ' + (sw.to || '未知');
  try {
    Promise.resolve(
      chrome.notifications.create('ati-switch-' + String(sessionId || '').slice(0, 80), {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icon-128.png'),
        title: 'Arena 模型已被路由',
        message,
        priority: 2
      })
    ).catch(() => {});
  } catch {}
}
function kickPoll(tabId, s) {
  if (!s?.token || !s.claims || s.halted) return;
  if (s.pollInFlight) {
    s.pollAgain = true;
    return;
  }
  clearTimeout(s.timer);
  void runPoll(tabId, s, s.generation);
}

async function haltForBlock(tabId, s, status) {
  if (!s || s.halted) return;
  s.halted = true;
  await listenIntent.set(tabId, false).catch(() => {});
  cancelLookup(s);
  s.streams.clear();
  // Keep this session view solely to explain why capture is off. It no longer receives or parses traffic.
  s.hasCapture = true;
  const reason = status === 429 ? 'HTTP 429 限流' : status === 403 ? 'HTTP 403 拒绝' : 'HTTP 401 拒绝';
  recovery(tabId, s, 'blocked', '监听因授权拒绝或限流安全停止；请检查后手动开启监听');
  s.haltReason = '检测到 ' + reason + '，已安全停止当前页监听；不会自动重试。';
  update(tabId, s, {status: s.haltReason, detailPending: false});
  await chrome.debugger.detach({tabId}).catch(() => {});
}

async function stop(tabId, detach = true, restore = true, preserveIntent = false) {
  if (!preserveIntent) await listenIntent.set(tabId, false).catch(() => {});
  const s = sessions.get(tabId);
  invalidateRestore(tabId);
  if (!s) return restore ? restoreForTab(tabId) : safeState(null);
  sessions.delete(tabId);
  cancelLookup(s);
  s.streams.clear();
  if (detach) await chrome.debugger.detach({tabId}).catch(() => {});
  if (restore) return restoreForTab(tabId);
  const state = safeState(null);
  publish(tabId, state);
  return state;
}

async function start(tabId, resume = false) {
  await listenIntent.ready;
  const tab = await chrome.tabs.get(tabId);
  if (!isArena(tab.pendingUrl || tab.url)) throw new Error('请在 https://arena.ai 页面开启');
  const prior = sessions.get(tabId);
  if (prior && !prior.halted) return safeState(prior);
  if (prior?.halted) sessions.delete(tabId);
  const pageSession = sessionFromUrl(tab.pendingUrl || tab.url);
  const s = {streams: new Map(), generation: 0, pageSession, activeSession: pageSession, view: emptyView(pageSession, true)};
  // Do not detach an existing debugger owned by DevTools or another extension.
  let owned = false;
  // On worker restart Chrome can retain OUR debugger attachment. A successful
  // command proves ownership; an external debugger won't accept our command.
  if (resume) {
    try {
      await command(tabId, 'Network.enable');
      owned = true;
    } catch {}
  }
  try {
    if (!owned) await chrome.debugger.attach({tabId}, '1.3');
  } catch {
    await listenIntent.set(tabId, false).catch(() => {});
    throw new Error('无法附加调试器。该标签页可能正被外部 CDP 监听器、DevTools 或其它扩展占用；请先停止其中一个后重试。扩展不会强制断开现有调试连接。');
  }
  const actual = await chrome.tabs.get(tabId).catch(() => null);
  if (!actual || !isArena(actual.pendingUrl || actual.url)) {
    await chrome.debugger.detach({tabId}).catch(() => {});
    await listenIntent.set(tabId, false).catch(() => {});
    throw Error('页面已离开 Arena，未开启监听');
  }
  s.pageSession = s.activeSession = sessionFromUrl(actual.pendingUrl || actual.url);
  s.view = emptyView(s.pageSession, true);
  sessions.set(tabId, s);
  try {
    if (!owned) await command(tabId, 'Network.enable');
  } catch {
    await stop(tabId);
    throw new Error('无法开启 Network 事件捕获');
  }
  await listenIntent.set(tabId, true).catch(() => {});
  // The initial HTML can contain the session token before the first SSE frame.
  // Ask the already-loaded top-frame content script to rescan; the token remains
  // in memory only and is still checked by lookup() against this session.
  await scanPageToken(tabId, s);
  update(tabId, s, {});
  return restoreForTab(tabId);
}

function ensureListener(tabId) {
  const task = (listenCommands.get(tabId) || Promise.resolve())
    .catch(() => {})
    .then(async () => {
      await listenIntent.ready;
      if (sessions.has(tabId) || !listenIntent.has(tabId)) return;
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab || !isArena(tab.pendingUrl || tab.url)) {
        await listenIntent.set(tabId, false).catch(() => {});
        return;
      }
      try {
        await start(tabId, true);
      } catch (error) {
        publish(tabId, {enabled: false, ...emptyView(sessionFromUrl(tab.pendingUrl || tab.url)), status: error.message});
      }
    });
  listenCommands.set(tabId, task);
  const done = () => {
    if (listenCommands.get(tabId) === task) listenCommands.delete(tabId);
  };
  task.then(done, done);
  return task;
}

async function bootstrapPageSession(tabId, s, token, sessionId) {
  if (s.halted || s.claims || s.bootstrapAttempted === token) return;
  s.bootstrap?.controller.abort();
  const job = {controller: new AbortController(), generation: s.generation};
  s.bootstrap = job;
  s.bootstrapAttempted = token; // One bounded attempt per candidate; no automatic retries.
  s.hasCapture = true;
  invalidateRestore(tabId);
  const live = () => sessions.get(tabId) === s && !s.halted && s.bootstrap === job && s.generation === job.generation && s.pageSession === sessionId;
  update(tabId, s, {sessionId, status: '已取得会话级令牌，正在只读核对会话并补读运行授权…'});
  recovery(tabId, s, 'session', '已取得页面会话授权，正在核对远端会话', {source: 'page'});
  try {
    const result = await recoverSessionRun({
      fetch: (...args) => fetch(...args),
      token,
      sessionId,
      signal: job.controller.signal,
      onProgress: progress => {
        if (!live()) return;
        if (progress.session) update(tabId, s, {sessionInfo: progress.session});
        recovery(tabId, s, progress.phase, progress.message);
      }
    });
    // Navigation may have happened before tabs.onUpdated reaches the worker.
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!live() || sessionFromUrl(tab?.pendingUrl || tab?.url) !== sessionId) return;
    update(tabId, s, {sessionInfo: result.session});
    if (result.token) {
      recovery(tabId, s, 'run', '已取得当前 run 授权');
      await lookup(tabId, s, result.token, sessionId);
    } else {
      const message = result.reason === 'no-run' ? '会话尚无当前运行；等待页面新的 Agent 消息' : '已核对会话，但未取得有效当前 run 授权；可手动重新补读';
      update(tabId, s, {status: message});
      recovery(tabId, s, 'waiting', message);
    }
  } catch (e) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!live() || sessionFromUrl(tab?.pendingUrl || tab?.url) !== sessionId) return;
    recovery(tabId, s, [401, 403, 429].includes(e?.status) ? 'blocked' : 'error', e?.message || '会话补读失败；未自动重试');
    if ([401, 403, 429].includes(e?.status)) await haltForBlock(tabId, s, e.status);
    else update(tabId, s, {status: e?.message || '会话补读失败；未自动重试'});
  } finally {
    if (s.bootstrap === job) s.bootstrap = null;
  }
}

async function lookup(tabId, s, token, sessionId) {
  if (s.halted) return;
  if (s.deletedToken === token) return;
  if (s.lastToken === token) {
    if (s.token === token) kickPoll(tabId, s);
    return;
  }
  let claims;
  try {
    claims = validateToken(token, sessionId);
  } catch (e) {
    update(tabId, s, {status: e.message});
    return;
  }
  // Same run, new JWT (Arena refreshes the public token between turns): keep models/switch.
  if (s.claims?.runId && s.claims.runId === claims.runId && s.pollSession === sessionId) {
    s.token = token;
    s.lastToken = token;
    s.claims = claims;
    update(tabId, s, {authorization: claims.authorization});
    kickPoll(tabId, s);
    return;
  }
  if (!s.view.recovery || s.view.recovery.source !== 'page') recovery(tabId, s, 'run', '已从当前页面实时流取得运行授权', {source: 'live'});
  const generating = s.activeSession === sessionId && s.generating;
  cancelLookup(s);
  s.generating = !!generating; // A start frame can arrive before the first run token.
  invalidateRestore(tabId);
  s.token = token;
  s.lastToken = token;
  s.claims = claims;
  s.pollSession = sessionId;
  s.attempt = 0;
  const generation = s.generation;
  s.detailRead = false;
  s.nameReadAttempts = 0;
  s.nameRetryPending = false;
  s.nameRetryAt = 0;
  s.detailSnapshot = null;
  s.completedDetailKey = null;
  s.waitForNewTurn = false;
  s.priorTurnDetailKey = null;
  update(tabId, s, {
    status: '已取得本次运行标识，读取 trace…',
    sessionId,
    historical: false,
    runId: claims.runId,
    models: [],
    run: null,
    usage: null,
    checkedAt: null,
    saved: false,
    usageText: '',
    totalUsageText: '',
    detailPending: true,
    renameReady: false,
    namingUnavailable: false,
    switch: null,
    compatibility: null,
    authorization: claims.authorization
  });
  await runPoll(tabId, s, generation);
}

async function runPoll(tabId, s, generation) {
  const live = () => sessions.get(tabId) === s && !s.halted && s.generation === generation && s.token;
  const sessionId = s.pollSession;
  const claims = s.claims;
  if (!live() || !claims) return;
  const poll = async () => {
    const turnVersion = s.turnVersion || 0;
    const taskRecovery = s.taskRecovery?.sessionId === sessionId ? s.taskRecovery : null;
    const currentTurn = () => live() && (s.turnVersion || 0) === turnVersion;
    if (!currentTurn()) return;
    if (Date.now() / 1000 >= claims.exp - 5) {
      s.token = null;
      recovery(tabId, s, 'expired', '当前运行授权已过期；可重新补读页面授权或等待新消息');
      update(tabId, s, {status: '令牌已过期，可重新补读或等待新消息', detailPending: false, renameReady: false});
      return;
    }
    s.attempt = (s.attempt || 0) + 1;
    const attempt = s.attempt;
    s.pollInFlight = true;
    s.abort = new AbortController();
    recovery(tabId, s, 'trace', '正在读取当前运行的 events / span 证据');
    const timeout = setTimeout(() => s.abort?.abort(), 10000);
    try {
      // Fixed origin, exact run scope, no redirects, cookies or write endpoints.
      const response = await fetch('https://api.trigger.dev/api/v1/runs/' + encodeURIComponent(claims.runId) + '/events', {
        method: 'GET',
        headers: {Authorization: 'Bearer ' + s.token, Accept: 'application/json'},
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        signal: s.abort.signal
      });
      if (!currentTurn()) return;
      const text = await response.text();
      if (!currentTurn()) return;
      let rawContext = null;
      if (await rawArchiveEnabled().catch(() => false)) {
        const {account: who} = await account.read().catch(() => ({account: null}));
        if (!currentTurn()) return;
        if (await rawArchiveEnabled().catch(() => false)) {
          rawContext = {sessionId, runId: claims.runId, account: who || null, token: s.token || null};
          try {
            const archive = await rawTraces.saveEvents({...rawContext, text, status: response.status});
            if (currentTurn()) update(tabId, s, {rawArchive: archive});
          } catch {
            if (currentTurn()) update(tabId, s, {rawArchive: {error: '原始 events 保存失败；请检查本地空间'}});
          }
        }
      }
      if (!currentTurn()) return;
      if (!response.ok) {
        if ([401, 403, 429].includes(response.status)) {
          await haltForBlock(tabId, s, response.status);
          return;
        }
        const labels = {401: '令牌被拒绝或已过期', 403: '该令牌无权读取 trace', 404: '运行 trace 不存在', 429: '接口限流，已停止查询'};
        throw new Error(labels[response.status] || 'trace 返回 HTTP ' + response.status);
      }
      let trace;
      try {
        trace = parseTrace(text);
      } catch (e) {
        update(tabId, s, {compatibility: traceCompatibilityFailure(String(e?.message || '').includes('超过') ? 'limited' : 'invalid')});
        throw e;
      }
      const detailKey = detailSnapshotKey(trace, claims.runId);
      if (s.detailSnapshot !== detailKey) {
        s.detailSnapshot = detailKey;
        s.detailRead = false;
        s.nameReadAttempts = 0;
        s.nameRetryPending = false;
        s.nameRetryAt = 0;
        update(tabId, s, {detailPending: true, renameReady: false, namingUnavailable: false});
      }
      const models = extractModels(trace, claims.runId);
      const checkedAt = new Date().toISOString();
      // Diagnostic state is independent of detail/name readiness and every action gate.
      if (s.collectionRun !== claims.runId || s.collectionKey !== detailKey || !s.collection || !detailKey) {
        s.collectionRun = claims.runId;
        s.collectionKey = detailKey;
        s.collection = planDetailCollection(trace, claims.runId, checkedAt);
        if (s.collection && !models.length) s.collection = sanitizeCollection({...s.collection, gate: 'no-model-label'});
      }
      update(tabId, s, {collection: {runId: claims.runId, diagnostic: s.collection}});
      const compatibility = inspectTraceCompatibility(trace, claims.runId);
      const extracted = {...extractUsage(trace, claims.runId, checkedAt), compatibility};
      const priorRuns = s.view.run?.runId === claims.runId ? [s.view.run] : [];
      const usage = mergeUsage(priorRuns, extracted).find(r => r.runId === claims.runId);
      if (s.collection) usage.collection = s.collection;
      if (s.view.run?.runId === claims.runId && s.view.run.detail) usage.detail = s.view.run.detail;
      const usageTotals = summarizeUsage([usage]);
      const detected = detectSwitch(usage.spans);
      const sw = mergeSwitch(s.view.switch, mergeSwitch(s.view.run?.switch, detected));
      if (sw?.state === 'switched') {
        usage.switch = sw;
        if (s.notifiedSwitch !== sw.from + '>' + sw.to) {
          s.notifiedSwitch = sw.from + '>' + sw.to;
          notifySwitch(sessionId, sw);
        }
      }
      const switchPatch = {switch: sw || null};
      if (models.length) {
        s.resolvedRun = claims.runId;
        const switchStatus = watchStatus(sw, s.generating) || '已读取模型标签，正在保存会话记录…';
        update(tabId, s, {status: switchStatus, models, checkedAt, run: usage, usage: usageTotals, usageText: formatUsage(usageTotals), compatibility, ...switchPatch});
        try {
          if (!(await storageReady)) throw new Error('storage unavailable');
          const tab = await chrome.tabs.get(tabId).catch(() => null);
          if (!currentTurn()) return;
          // Capture title only when it belongs to this run's actual conversation.
          const expectedUrl = conversationUrl(sessionId);
          const matchingTab = tab?.url?.split(/[?#]/)[0] === expectedUrl;
          const record = await history.save({sessionId, title: matchingTab ? tab.title : undefined, models, runId: claims.runId, checkedAt, usage, collection: s.collection});
          if (currentTurn()) {
            s.collection = record.runs?.find(r => r.runId === claims.runId)?.collection || s.collection;
            update(tabId, s, {collection: {runId: claims.runId, diagnostic: s.collection}});
          }
          if (currentTurn())
            update(tabId, s, {status: watchStatus(sw, s.generating) || '已识别并保存会话—模型记录', saved: true, totalUsageText: formatUsage(record.totals), switch: record.switch || sw || null});
          // Read bounded details with the same exact-scope token. Successful responses
          // with late modelName fields may be reread (4 attempts per snapshot, 3 s apart); HTTP failures are not retried.
          // Wait until every span in the trace has token+cost (or polling ends) so cost/usage spans carrying the internal modelName are included; otherwise a fast first poll captures only the stream span (observed 2026-09-16, session 01a0ab3c).
          // Also require that the trace already contains a *new* completed turn (stream+usage+cost) beyond what was saved for this run; a fresh token arrives before the new turn's spans exist (observed 2026-09-16, session 01a0a7a8 turns 3-4 missed).
          s.detailTurns = s.detailTurns || {};
          // Same-run turns and additional tool steps can change the selected spans without
          // changing runId/turn count. Never let cached detail authorize naming a new snapshot.
          const detailReady =
            !!detailKey &&
            Date.now() >= (s.nameRetryAt || 0) &&
            !usageTotals.partial &&
            (!s.waitForNewTurn || detailKey !== s.priorTurnDetailKey) &&
            ((detailKey !== s.completedDetailKey && detailComplete(trace, claims.runId, 0)) || (attempt >= 8 && !s.waitForNewTurn));
          if (currentTurn() && s.token && !s.detailRead && detailReady) {
            s.detailRead = true;
            s.nameRetryPending = false;
            s.nameReadAttempts = (s.nameReadAttempts || 0) + 1;
            update(tabId, s, {detailPending: true, renameReady: false, namingUnavailable: false});
            try {
              s.detailAbort = new AbortController();
              let detailTimedOut = false;
              const detailTimer = setTimeout(() => {
                detailTimedOut = true;
                s.detailAbort?.abort();
              }, 45000);
              let detail;
              const selection = selectDetailSpans(trace, claims.runId);
              const markRaw = async status => {
                if (!rawContext || !currentTurn() || !(await rawArchiveEnabled().catch(() => false))) return;
                try {
                  const archive = await rawTraces.markDetail({...rawContext, status, spanIds: selection.selected.map(x => x.spanId), limited: selection.limited});
                  if (currentTurn()) update(tabId, s, {rawArchive: archive});
                } catch {
                  if (currentTurn()) update(tabId, s, {rawArchive: {error: '原始 span 保存失败；归档可能不完整'}});
                }
              };
              await markRaw('reading');
              try {
                detail = await readAgentDetail({
                  fetch,
                  runId: claims.runId,
                  token: s.token,
                  trace,
                  signal: s.detailAbort.signal,
                  checkedAt,
                  attempt: s.nameReadAttempts,
                  abortKind: () => (detailTimedOut ? 'timeout' : 'aborted'),
                  onProgress: diagnostic => {
                    if (currentTurn()) {
                      s.collection = diagnostic;
                      update(tabId, s, {collection: {runId: claims.runId, diagnostic}});
                    }
                  },
                  onRawSpan: rawContext
                    ? async item => {
                        if (!currentTurn() || !(await rawArchiveEnabled().catch(() => false))) return;
                        try {
                          await rawTraces.saveSpan({...rawContext, ...item});
                        } catch {
                          if (currentTurn()) update(tabId, s, {rawArchive: {error: '原始 span 保存失败；归档可能不完整'}});
                        }
                      }
                    : null
                });
                await markRaw(detail.stopped || detail.spans.some(x => x.partial) ? 'partial' : 'complete');
              } catch (error) {
                await markRaw('failed');
                throw error;
              } finally {
                clearTimeout(detailTimer);
              }
              if (!currentTurn()) return;
              s.collection = withPersistence(s.collection, 'pending');
              update(tabId, s, {collection: {runId: claims.runId, diagnostic: s.collection}});
              let saved;
              try {
                saved = await history.saveDetail(sessionId, claims.runId, detail, s.collection);
              } catch (error) {
                s.collection = withPersistence(s.collection, 'failed');
                throw error;
              }
              s.collection = withPersistence(s.collection, 'saved-detail', saved.spans.length);
              if (currentTurn()) update(tabId, s, {collection: {runId: claims.runId, diagnostic: s.collection}});
              if (!currentTurn()) return;
              const blocked = Number(/\b(401|403|429)\b/.exec(detail?.stopped || '')?.[1] || 0);
              if (blocked) {
                await haltForBlock(tabId, s, blocked);
                return;
              }
              const accountQuota = quotaFromDetail(saved);
              if (accountQuota) {
                s.accountQuota = accountQuota;
                void rememberAccountQuota(accountQuota);
              }
              if (!currentTurn()) return;
              s.detailTurns[claims.runId] = saved.turnCount || 0;
              const renameReady = detailComplete(trace, claims.runId, 0) && globalThis.ArenaTraceView.detailNamingReady(saved, models);
              const retryNames = !saved.stopped && !renameReady && s.nameReadAttempts < 4;
              s.nameRetryPending = retryNames;
              s.nameRetryAt = retryNames ? Date.now() + 3000 : 0;
              s.detailRead = !retryNames;
              s.completedDetailKey = retryNames ? null : detailKey;
              s.waitForNewTurn = false;
              const nameStatus = renameReady
                ? '已保存模型记录与 span 详情（内部名 / 供应商名 / 参数）'
                : saved.stopped
                  ? '已保存模型记录；span 详情部分读取：' + saved.stopped
                  : retryNames
                    ? '已取得模型标签，等待 Arena 内部名补齐（详情读取 ' + s.nameReadAttempts + '/4）'
                    : '内部模型名仍未就绪；补读已结束，暂不自动命名，可手动重新补读';
              recovery(tabId, s, renameReady ? 'ready' : retryNames ? 'waiting' : 'partial', renameReady ? '当前运行详情与内部模型名已读取并保存' : nameStatus);
              if (currentTurn()) s.detailReceipt = {generation, turnVersion, runId: claims.runId, key: detailKey};
              if (currentTurn())
                update(tabId, s, {
                  ...(taskRecovery && s.taskRecovery === taskRecovery ? {taskRecovery: {requestId: taskRecovery.requestId, complete: renameReady}} : {}),
                  run: {...(s.view.run || usage), detail: saved, collection: s.collection, ...(sw?.state === 'switched' ? {switch: sw} : {})},
                  ...(s.accountQuota ? {accountQuota: s.accountQuota} : {}),
                  detailPending: retryNames,
                  renameReady,
                  namingUnavailable: !renameReady && !retryNames,
                  status: watchStatus(sw, s.generating) || nameStatus
                });
            } catch (e) {
              if (currentTurn()) {
                // A failed detail write cannot be 'repaired' by another diagnostic write.
                if (s.collection?.phase === 'failed' && s.collection.persistence !== 'failed') {
                  const diagnostic = await persistCollectionFailure({history, sessionId, runId: claims.runId, diagnostic: s.collection, isCurrent: currentTurn});
                  if (diagnostic) s.collection = diagnostic;
                }
                if (currentTurn()) update(tabId, s, {collection: {runId: claims.runId, diagnostic: s.collection}});
              }
              if (currentTurn()) {
                recovery(tabId, s, 'partial', 'span 详情读取失败；可手动重新补读');
                update(tabId, s, {
                  status: (watchStatus(sw, s.generating) ? watchStatus(sw, s.generating) + '；' : '') + '已保存模型记录；span 详情读取失败：' + (e?.message || '未知错误'),
                  detailPending: false,
                  renameReady: false,
                  namingUnavailable: true
                });
              }
            }
          }
        } catch {
          if (currentTurn()) {
            s.collection = withPersistence(s.collection, 'failed');
            update(tabId, s, {collection: {runId: claims.runId, diagnostic: s.collection}});
          }
          if (currentTurn()) update(tabId, s, {status: '已识别模型，但本地保存失败；请检查存储权限或空间', saved: false});
        }
        const needUsage = usageTotals.partial || usageTotals.tokenCoverage < usageTotals.spanCount || usageTotals.costCoverage < usageTotals.spanCount || !s.detailRead;
        const needWatch = s.generating || s.finishPolls > 0;
        if (currentTurn() && s.token && (needWatch || s.nameRetryPending || (s.view.saved && attempt < 8 && needUsage))) {
          if (needWatch && !s.generating && s.finishPolls > 0) s.finishPolls--;
          if (currentTurn() && !sw && !s.nameRetryPending && !s.view.namingUnavailable)
            update(tabId, s, {status: needWatch ? (s.generating ? '生成中，正在核对模型…' : '调用结束，正在核对模型…') : '已识别模型，等待用量补齐 ' + attempt + '/8'});
          else if (currentTurn() && sw?.state === 'suspected') update(tabId, s, {status: watchStatus(sw, s.generating)});
          s.timer = setTimeout(poll, 3000);
        } else if (currentTurn() && s.view.detailPending && !s.nameRetryPending) update(tabId, s, {detailPending: false});
        return;
      }
      if (attempt >= 8 && !s.generating && !(s.finishPolls > 0)) {
        update(tabId, s, {status: 'trace 未包含模型标签；不猜测模型', checkedAt, run: usage, usage: usageTotals, compatibility, detailPending: false, ...switchPatch});
        return;
      }
      update(tabId, s, {status: s.generating ? '生成中，等待模型标签…' : 'trace 暂无模型标签，等待重试 ' + attempt + '/8', checkedAt, run: usage, usage: usageTotals, compatibility, ...switchPatch});
      s.timer = setTimeout(poll, 3000);
    } catch (e) {
      if (currentTurn()) {
        s.token = null;
        recovery(tabId, s, 'error', 'trace 请求失败或超时；可手动重新补读');
        const known = /令牌|trace|接口|运行|无权/.test(e.message || '');
        update(tabId, s, {status: known ? e.message : 'trace 请求失败或超时，请检查网络和扩展站点权限', detailPending: false});
      }
    } finally {
      clearTimeout(timeout);
      if (s.generation === generation) s.pollInFlight = false;
      if (currentTurn() && !s.generating && s.view.recovery?.phase === 'trace')
        recovery(
          tabId,
          s,
          s.view.renameReady ? 'ready' : 'waiting',
          s.view.renameReady ? '本次运行详情与内部名已就绪' : s.nameRetryPending ? '正在补读 Arena 内部名' : '等待完整运行详情；可稍后重新补读'
        );
      if (s.pollAgain && live() && s.token) {
        s.pollAgain = false;
        s.timer = setTimeout(poll, 0);
      }
    }
  };
  await poll();
}

async function onNetwork(tabId, method, p) {
  const s = sessions.get(tabId);
  if (!s || s.halted) return;
  if (method === 'Network.responseReceived') {
    const respUrl = String(p.response?.url || '');
    if (/^https:\/\/arena\.ai\/nextjs-api\/stream\/create-chat(?:\?|$)/.test(respUrl)) {
      const parsed = parseRateLimitHeaders(p.response?.headers);
      const bucket =
        parsed && p.response?.status === 429
          ? {...parsed, remaining: 0}
          : parsed ||
            (p.response?.status === 429
              ? {
                  limit: latestRateLimits?.createChat?.limit || 30,
                  remaining: 0,
                  resetSeconds: 3600,
                  resetAt: new Date(Date.now() + 3600 * 1000).toISOString(),
                  receivedAt: new Date().toISOString()
                }
              : null);
      if (bucket) {
        await rememberRateLimits({createChat: bucket});
        update(tabId, s, {});
      }
    } else if (/^https:\/\/arena\.ai\/api\/me\/pulse(?:\?|$)/.test(respUrl)) {
      const bucket = parseRateLimitHeaders(p.response?.headers);
      if (bucket) {
        await rememberRateLimits({apiGeneral: bucket});
        update(tabId, s, {});
      }
    }
    const sessionId = streamSession(p.response.url);
    const capturedStatus = p.response?.status;
    // Only this Agent stream can stop Agent capture. Navigation prefetches,
    // images, analytics and other sessions' 401/403/429 are unrelated.
    if (!sessionId || (s.pageSession && s.pageSession !== sessionId) || (!s.pageSession && s.activeSession && s.activeSession !== sessionId)) return;
    if ([401, 403, 429].includes(capturedStatus)) {
      await haltForBlock(tabId, s, capturedStatus);
      return;
    }
    if (p.response.status !== 200) return;
    s.hasCapture = true;
    invalidateRestore(tabId);
    if (s.streams.size >= 8) s.streams.delete(s.streams.keys().next().value);
    if (s.activeSession !== sessionId) {
      cancelLookup(s);
      s.activeSession = sessionId;
      s.resolvedRun = null;
      update(tabId, s, {
        status: '已捕获会话流，等待运行令牌…',
        sessionId,
        historical: false,
        runId: null,
        models: [],
        run: null,
        usage: null,
        checkedAt: null,
        saved: false,
        usageText: '',
        totalUsageText: '',
        detailPending: false,
        switch: null,
        authorization: null
      });
    }
    const stream = {sessionId, ready: false, pending: [], pendingBytes: 0, tapped: false};
    stream.parser = new SSEParser(frame => {
      if (s.halted || s.activeSession !== sessionId) return;
      for (const token of publicTokens(frame)) {
        void lookup(tabId, s, token, sessionId);
      }
      for (const type of streamEventTypes(frame)) {
        if (type === 'start') {
          if (s.taskRecovery) {
            const requestId = s.taskRecovery.requestId;
            s.taskRecovery = null;
            update(tabId, s, {taskRecovery: {requestId, complete: false, invalidated: true}});
          }
          s.turnVersion = (s.turnVersion || 0) + 1;
          s.generating = true;
          s.finishPolls = 0;
          s.attempt = 0;
          s.detailRead = false;
          s.nameReadAttempts = 0;
          s.nameRetryPending = false;
          s.nameRetryAt = 0;
          s.priorTurnDetailKey = s.detailSnapshot || s.completedDetailKey || null;
          s.waitForNewTurn = !!s.priorTurnDetailKey;
          update(tabId, s, {detailPending: true, renameReady: false, namingUnavailable: false});
          kickPoll(tabId, s);
        } else if (type === 'finish') {
          s.generating = false;
          s.finishPolls = 2;
          kickPoll(tabId, s);
        }
      }
    });
    s.streams.set(p.requestId, stream);
    try {
      const result = await command(tabId, 'Network.streamResourceContent', {requestId: p.requestId});
      if (sessions.get(tabId) !== s || s.streams.get(p.requestId) !== stream) return;
      stream.tapped = true;
      if (result.bufferedData) stream.parser.push(decode64(result.bufferedData));
      for (const bytes of stream.pending) stream.parser.push(bytes);
    } catch {
      update(tabId, s, {status: '流式读取不可用，等待完整响应后尝试解析'});
    } finally {
      stream.ready = true;
      stream.pending = [];
    }
  }
  const stream = s.streams.get(p.requestId);
  if (!stream) return;
  if (method === 'Network.dataReceived' && p.data) {
    try {
      const bytes = decode64(p.data);
      if (!stream.ready) {
        stream.pendingBytes += bytes.length;
        if (stream.pendingBytes > 2 * 1024 * 1024) throw new Error('流缓冲区超限');
        stream.pending.push(bytes);
      } else stream.parser.push(bytes);
    } catch {
      s.streams.delete(p.requestId);
      update(tabId, s, {status: '流解析失败，已停止读取该响应'});
    }
  }
  if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
    if (!stream.tapped) {
      try {
        const r = await command(tabId, 'Network.getResponseBody', {requestId: p.requestId});
        stream.parser.push(r.base64Encoded ? decode64(r.body) : new TextEncoder().encode(r.body));
      } catch {
        update(tabId, s, {status: '响应正文不可用，请重新发送测试消息'});
      }
    }
    s.streams.delete(p.requestId);
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId !== undefined && !source.sessionId)
    void onNetwork(source.tabId, method, params).catch(() => {
      const s = sessions.get(source.tabId);
      if (s) update(source.tabId, s, {status: '捕获异常，请停止后重新开启'});
    });
});
chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === undefined || sessions.get(source.tabId)?.halted) return;
  // Target replacement during navigation can detach CDP. Remember intent only for
  // that reason; a user cancelling the debugger must never be auto-overridden.
  const preserve = reason === 'target_closed' && listenIntent.has(source.tabId);
  void stop(source.tabId, false, true, preserve);
});
chrome.tabs.onRemoved.addListener(tabId => {
  battleTrace.cancel(tabId);
  void stop(tabId, true, false).finally(() => restoreTickets.delete(tabId));
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url) {
    battleTrace.cancel(tabId);
    if (!isArena(change.url)) {
      void stop(tabId, true, false);
      return;
    }
    alignPage(tabId, change.url);
    // Clear a previous historical overlay immediately, then load only this URL's record.
    if (!sessions.has(tabId)) publish(tabId, {enabled: false, ...emptyView(sessionFromUrl(change.url))});
    void ensureListener(tabId).then(() => restoreForTab(tabId));
  } else if (change.status === 'complete') {
    void ensureListener(tabId).then(() => restoreForTab(tabId));
  }
});

async function recoverCurrentSession(tabId, sessionId, requestId = null) {
  const tab = await chrome.tabs.get(tabId),
    url = tab.pendingUrl || tab.url,
    id = sessionFromUrl(url),
    s = sessions.get(tabId);
  if (!isArena(url) || !id || id !== sessionId) throw Error('会话已变化，未重新补读');
  if (!s || s.halted) throw Error('请先手动开启当前页监听');
  if (s.generating || s.bootstrap || s.pollInFlight || s.view.recovery?.phase === 'scan') throw Error('正在生成或补读，请稍后重试');
  if (Date.now() - (s.lastRecoveryRetry || 0) < 5000) throw Error('重新补读间隔至少 5 秒');
  s.lastRecoveryRetry = Date.now();
  alignPage(tabId, url);
  cancelLookup(s);
  s.bootstrapAttempted = null;
  s.taskRecovery = requestId ? {requestId, sessionId} : null;
  update(tabId, s, {
    taskRecovery: requestId ? {requestId, complete: false} : null,
    recovery: {phase: 'requested', message: '已请求重新补读', checkedAt: new Date().toISOString()},
    renameReady: false,
    namingUnavailable: false
  });
  let cached = null;
  try {
    if (s.sessionToken && !validateSessionToken(s.sessionToken, id).runId) cached = s.sessionToken;
  } catch {}
  if (cached) void bootstrapPageSession(tabId, s, cached, id);
  else void scanPageToken(tabId, s);
  return {ok: true};
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  const popup = sender.url === chrome.runtime.getURL('popup.html');
  if (TASK_MESSAGES.has(msg.type)) {
    drawTasks.handle(msg, sender).then(reply, e => reply({ok: false, error: e?.message || '任务操作失败', code: e?.code || null}));
    return true;
  }
  if (['ATI_BATTLE_TRACE_READ', 'ATI_BATTLE_TRACE_GET', 'ATI_BATTLE_TRACE_LIST'].includes(msg.type)) {
    (async () => {
      if (!(await storageReady)) throw Error('本地存储不可用');
      if (popup) {
        if (msg.type !== 'ATI_BATTLE_TRACE_LIST') throw Error('请从当前 Battle 页面读取 trace');
        return {records: await battleTrace.list()};
      }
      if (sender.frameId !== 0 || !Number.isInteger(sender.tab?.id) || !isArena(sender.url)) throw Error('消息来源无效');
      const tab = await chrome.tabs.get(sender.tab.id);
      if (!isArena(tab.pendingUrl || tab.url)) throw Error('页面已变化');
      if (msg.type === 'ATI_BATTLE_TRACE_LIST') return {records: await battleTrace.list()};
      const actual = ArenaBattleCore.sessionFromUrl(tab.pendingUrl || tab.url);
      if (!actual || actual !== msg.sessionId || ArenaBattleCore.sessionFromUrl(msg.pageUrl) !== actual) throw Error('Battle 会话已变化');
      if (msg.type === 'ATI_BATTLE_TRACE_LIST') return {records: await battleTrace.list()};
      if (msg.type === 'ATI_BATTLE_TRACE_GET') return {record: await battleTrace.get(actual)};
      return battleTrace.read(sender.tab.id, actual, msg.force === true);
    })().then(reply, error => reply({error: error.message || 'Code trace 读取失败；请在当前会话重试'}));
    return true;
  }
  if (['ATI_BATTLE_GET', 'ATI_BATTLE_SAVE', 'ATI_BATTLE_LIST'].includes(msg.type)) {
    (async () => {
      if (!(await storageReady)) throw Error('本地存储不可用');
      if (!popup) {
        if (sender.frameId !== 0 || !Number.isInteger(sender.tab?.id) || !isArena(sender.url)) throw Error('消息来源无效');
        const tab = await chrome.tabs.get(sender.tab.id);
        if (!isArena(tab.pendingUrl || tab.url)) throw Error('页面已变化');
        if (msg.type !== 'ATI_BATTLE_LIST') {
          const actual = ArenaBattleCore.sessionFromUrl(tab.pendingUrl || tab.url);
          const claimed = msg.type === 'ATI_BATTLE_SAVE' ? msg.record?.sessionId : msg.sessionId;
          if (!actual || actual !== claimed || ArenaBattleCore.sessionFromUrl(msg.pageUrl) !== actual) throw Error('Battle 会话已变化');
        }
      }
      if (msg.type === 'ATI_BATTLE_LIST') return {records: await battleHistory.list()};
      if (msg.type === 'ATI_BATTLE_GET') return {record: await battleHistory.get(msg.sessionId)};
      if (popup) throw Error('请从当前 Battle 页面读取官方揭示');
      const record = await battleHistory.save(msg.record);
      return {ok: true, record};
    })().then(reply, () => reply({error: 'Battle 数据校验或存储失败，请在当前会话重试'}));
    return true;
  }
  if (msg.type === 'ATI_HISTORY_LIST' && popup) {
    history.list().then(
      records => reply({records}),
      () => reply({error: '读取本地记录失败', records: []})
    );
    return true;
  }
  // 2.3.0: store a transcript captured by the content script. Only the page's own top
  // frame may submit one, and only for the session currently in that tab.
  if (msg.type === 'ATI_TRANSCRIPT_SAVE') {
    (async () => {
      if (!(await storageReady)) throw Error('storage unavailable');
      if (msg.auto === true && !(await transcriptAutoEnabled())) return {ok: false, skipped: 'auto-disabled'};
      if (!popup) {
        // 2.4.0 fix: this handler runs BEFORE the shared `const tabId` / `const pageUrl`
        // below, so referencing those hit the temporal dead zone and every real save
        // failed with "Cannot access 'tabId' before initialization". Derive locally.
        if (sender.frameId !== 0 || !Number.isInteger(sender.tab?.id)) throw Error('Invalid sender');
        const claimedUrl = typeof msg.pageUrl === 'string' ? msg.pageUrl : sender.url;
        const tab = await chrome.tabs.get(sender.tab.id);
        const url = tab.pendingUrl || tab.url;
        if (!isArena(url)) throw Error('Not an Arena page');
        if (sessionFromUrl(url) !== msg.sessionId || sessionFromUrl(claimedUrl) !== msg.sessionId) throw Error('页面已变化，请重试');
      }
      const clean = sanitizeTranscript(msg.transcript);
      if (!clean) throw Error('没有可保存的对话正文');
      const {account: who} = await account.read();
      const renameKey = 'ati.autoRename.attempted.v1.' + msg.sessionId;
      const localRenamed = normalizeChatTitle((await chrome.storage.local.get(renameKey).catch(() => ({})))?.[renameKey]?.title);
      const existingChat = await chats.get(msg.sessionId).catch(() => null);
      let resolvedTitle = normalizeChatTitle(msg.title) || localRenamed || normalizeChatTitle(existingChat?.title);
      if (!resolvedTitle && msg.lazy !== true) {
        const remoteTitles = await readLatestTitles({maxPages: 5, stopAtId: msg.sessionId}).catch(() => null);
        resolvedTitle = normalizeChatTitle(remoteTitles?.get(msg.sessionId)) || null;
      }
      // 2.4.0: chats live in their own store, not inside the metadata record.
      const saved = await chats.save(msg.sessionId, clean, {account: who || null, title: resolvedTitle});
      return {ok: true, messages: saved.messageCount, chars: saved.chars, truncated: saved.truncated === true};
    })().then(reply, e => reply({error: e?.message || '保存对话正文失败'}));
    return true;
  }
  if (msg.type === 'ATI_TRANSCRIPT_AUTO_GET') {
    transcriptAutoEnabled().then(
      enabled => reply({enabled}),
      () => reply({enabled: false})
    );
    return true;
  }
  if (msg.type === 'ATI_RAW_AUTO_GET') {
    rawArchiveEnabled().then(
      enabled => reply({enabled}),
      () => reply({enabled: false})
    );
    return true;
  }
  if (msg.type === 'ATI_RAW_AUTO_SET') {
    (async () => {
      if (typeof msg.enabled !== 'boolean') throw Error('Invalid preference');
      await chrome.storage.local.set({[RAW_ARCHIVE_KEY]: msg.enabled});
      return {enabled: msg.enabled};
    })().then(reply, e => reply({error: e?.message || '设置失败'}));
    return true;
  }
  if (msg.type === 'ATI_TRANSCRIPT_AUTO_SET') {
    (async () => {
      if (typeof msg.enabled !== 'boolean') throw Error('Invalid preference');
      await chrome.storage.local.set({[TRANSCRIPT_AUTO_KEY]: msg.enabled});
      return {enabled: msg.enabled};
    })().then(reply, e => reply({error: e?.message || '设置失败'}));
    return true;
  }
  /* 2.4.0: two independent exports. `kind` selects which one; they are never merged.
       metadata -> arena-metadata-<date>.json   (models, usage, routing)
       chat     -> arena-chats-<date>.json      (message text, reasoning optional)
       raw      -> arena-raw-<date>.json        (verbatim trace payloads, may hold a token)
     All group by account and refresh titles from /api/history/unified. */
  if (msg.type === 'ATI_EXPORT' && popup) {
    (async () => {
      const kind = msg.kind === 'chat' ? 'chat' : msg.kind === 'raw' ? 'raw' : 'metadata';
      const {account: who} = await account.read();
      // 只导一个会话时用 sessionId 过滤；标题刷新要串行翻最多 25 页（实测占导出耗时的 99%），
      // 因此改为显式请求才做，并在翻页时回报进度。
      const only = typeof msg.sessionId === 'string' && msg.sessionId ? msg.sessionId : null;
      const onPage = (pages, found) => {
        chrome.runtime.sendMessage({type: 'ATI_EXPORT_PROGRESS', pages, found}).catch(() => {});
      };
      const allLocal = await chrome.storage.local.get(null).catch(() => ({}));
      const titles = msg.refreshTitles === true ? await readLatestTitles({onPage}).catch(() => null) : null;
      const retitle = r => {
        const localRenamed = normalizeChatTitle(allLocal['ati.autoRename.attempted.v1.' + r.sessionId]?.title);
        const latest = titles?.get(r.sessionId) || (!normalizeChatTitle(r.title) ? localRenamed : null);
        return latest && latest !== r.title ? {...r, title: latest, titleWas: r.title} : r;
      };
      const group = items => {
        const groups = new Map();
        for (const r of items) {
          const id = r.account?.accountId || 'unknown';
          if (!groups.has(id)) groups.set(id, {account: r.account || {accountId: 'unknown'}, items: []});
          groups.get(id).items.push(r);
        }
        return [...groups.values()];
      };
      const head = {
        schemaVersion: 1,
        kind,
        exportedAt: new Date().toISOString(),
        exportedBy: who || null,
        titlesRefreshed: !!titles,
        ...(titles ? {titlePagesRead: titles.pagesRead, ...(titles.truncated ? {titleLookupTruncated: true} : {})} : {})
      };

      if (kind === 'metadata') {
        const records = (await history.list()).filter(r => !only || r.sessionId === only).map(retitle);
        return {
          ok: true,
          filename: only ? 'arena-metadata-' + only.slice(0, 8) : 'arena-metadata',
          bundle: {...head, notice: '模型元数据导出。含账号邮箱，请勿外发。对话正文不在本文件中。', accounts: group(records)}
        };
      }
      if (kind === 'chat') {
        const includeReasoning = msg.includeReasoning !== false;
        // 2.8.1：思考过程在现代模型下已不再渲染，该开关改为控制工具调用标记（> used Bash）。
        const includeToolMarks = msg.includeToolMarks !== false;
        const records = (await chats.list())
          .filter(r => !only || r.sessionId === only)
          .map(retitle)
          .map(r => shapeChatForExport(r, {includeReasoning, includeToolMarks}));
        return {
          ok: true,
          filename: only ? 'arena-chat-' + only.slice(0, 8) : 'arena-chats',
          bundle: {...head, includeReasoning, includeToolMarks, notice: '对话正文导出。含完整对话内容与账号邮箱，请勿外发。', accounts: group(records)}
        };
      }
      const records = await rawTraces.list();
      return {
        ok: true,
        filename: 'arena-raw',
        bundle: {...head, notice: '原始 trace 导出。未做任何字段过滤，可能包含 public-access-token 与完整报文，请勿外发。', accounts: group(records)},
        rawRisk: summarizeRawRecords(records)
      };
    })().then(reply, e => reply({error: e?.message || '导出失败'}));
    return true;
  }
  // Storage footprint, so the personal build can see what it is accumulating.
  if (msg.type === 'ATI_STORAGE_STATS' && popup) {
    (async () => {
      const all = await chrome.storage.local.get(null);
      const sum = pred =>
        Object.entries(all)
          .filter(([k]) => pred(k))
          .reduce((n, [, v]) => n + JSON.stringify(v).length, 0);
      return {
        ok: true,
        stats: {
          metadataBytes: sum(k => k.startsWith('ati.conversation.')),
          chatBytes: sum(k => k.startsWith('ati.chat.')),
          rawBytes: sum(k => k.startsWith('ati.raw.')),
          totalBytes: sum(() => true)
        }
      };
    })().then(reply, e => reply({error: e?.message || '读取容量失败'}));
    return true;
  }
  if (msg.type === 'ATI_HISTORY_DELETE') {
    (async () => {
      if (!(await storageReady)) throw Error('storage unavailable');
      if (!popup) {
        if (!isArena(sender.url) || sender.frameId !== 0 || !Number.isInteger(sender.tab?.id)) throw Error('Invalid sender');
        const tab = await chrome.tabs.get(sender.tab.id);
        if (sessionFromUrl(tab.pendingUrl || tab.url) !== msg.sessionId || sessionFromUrl(msg.pageUrl) !== msg.sessionId) throw Error('Stale page');
      }
      // 2.4.0: the three stores are independent, so "delete this conversation" must
      // clear all of them. `scope` lets a caller drop just one.
      const scope = msg.scope || 'all';
      if (scope === 'all' || scope === 'metadata') await history.remove(msg.sessionId);
      if (scope === 'all' || scope === 'chat') await chats.remove(msg.sessionId).catch(() => {});
      if (scope === 'all' || scope === 'raw') await rawTraces.remove(msg.sessionId).catch(() => {});
      // Deleting must also drop the in-memory capture for that conversation and stop any trace/detail polling still
      // running for it; otherwise the next poll re-saves the record seconds later and the HUD keeps showing it (1.8.0 fix).
      for (const [id, s] of sessions)
        if (s.view.sessionId === msg.sessionId && !s.view.historical) {
          s.deletedToken = s.lastToken || s.deletedToken || null; // Same message token must not re-create the record; a new message brings a new token.
          cancelLookup(s);
          s.resolvedRun = null;
          s.view = emptyView(msg.sessionId, true);
          s.view.status = '本地记录已删除；发送新消息后会生成新记录';
          publish(id, safeState(s));
        }
      // Refresh historical overlays without stopping an active capture.
      const tabs = await chrome.tabs.query({url: 'https://arena.ai/*'}).catch(() => []);
      await Promise.all(tabs.filter(tab => sessionFromUrl(tab.pendingUrl || tab.url) === msg.sessionId).map(tab => restoreForTab(tab.id).catch(() => {})));
      reply({ok: true});
    })().catch(() => reply({error: '删除本地记录失败，请重试'}));
    return true;
  }
  if (msg.type === 'ATI_ARCHIVE_FINISH') {
    (async () => {
      const entry = archiveTickets.get(msg.ticket);
      if (popup || sender.frameId !== 0 || !isArena(sender.url) || !entry || entry.tabId !== sender.tab?.id || entry.expires < Date.now()) throw Error('Invalid archive ticket');
      const tab = await chrome.tabs.get(entry.tabId);
      if (!isArena(tab.pendingUrl || tab.url)) throw Error('Invalid page');
      if (msg.archived !== true) throw Error('Archive unconfirmed');
      if (!(await storageReady)) throw Error('Storage unavailable');
      await history.removeIfUnchanged(entry.sessionId, entry.cleanupFingerprint);
      archiveTickets.delete(msg.ticket);
      await restoreForTab(entry.tabId).catch(() => {});
      reply({ok: true});
    })().catch(() => reply({error: '聊天可能已归档，但本地记录未能删除；请在扩展会话列表重试删除记录'}));
    return true;
  }
  // ATI_PULSE 只读同源的 /api/me/pulse，本身不需要 tabId。它此前排在「tabId 必须是整数」的
  // 守卫之后，而 popup 发这条消息时不带 tabId，于是被直接 return、连回复都没有——HUD 正常、
  // popup 的百分比环永远是「—」。这里前移到守卫之前，来源校验原样保留在块内。
  if (msg.type === 'ATI_PULSE') {
    (async () => {
      const extPage = popup || sender.url === chrome.runtime.getURL('history.html') || sender.url === chrome.runtime.getURL('settings.html') || sender.url === chrome.runtime.getURL('tasks.html');
      const pulseTab = extPage ? msg.tabId : sender.tab?.id;
      if (!extPage) {
        if (sender.frameId !== 0 || !Number.isInteger(pulseTab)) throw Error('Invalid sender');
        const tab = await chrome.tabs.get(pulseTab);
        if (!isArena(tab.pendingUrl || tab.url)) throw Error('Not an Arena page');
      }
      const read = await pulse.read({force: msg.force === true});
      if (read?.rateLimits) await rememberRateLimits(read.rateLimits);
      const rateLimits = await loadRateLimits();
      // 美元快照不属于 pulse 接口：顺带回传当前最新的一份，让手动刷新也能取到别处抓到的快照。不增加任何网络请求。
      // 三个来源必须和 restoreForTab 保持一致（会话内存 / 本地存储 / 本会话历史记录）：少了最后一个，
      // 手动刷新反而会把界面退回存储里那份更旧的快照。history.get 是本地读取，不产生网络请求。
      const session = Number.isInteger(pulseTab) ? sessions.get(pulseTab) : null;
      const fromPage = !extPage && typeof msg.pageUrl === 'string' ? msg.pageUrl : '';
      const quotaSession = session?.view?.sessionId || sessionFromUrl(fromPage);
      const record = quotaSession ? await history.get(quotaSession).catch(() => null) : null;
      const quota = newerQuota(newerQuota(session?.accountQuota || null, await loadAccountQuota()), latestRecordQuota(record));
      return {
        ...read,
        ...(quota ? {accountQuota: quota} : {}),
        ...(rateLimits ? {rateLimits} : {})
      };
    })().then(reply, e => reply({pulse: null, cached: false, error: e?.message || '每日额度读取失败'}));
    return true;
  }
  const tabId = popup ? msg.tabId : sender.tab?.id;
  if (!Number.isInteger(tabId) || (!popup && !isArena(sender.url))) return;
  if (msg.type === 'ATI_SESSION_RECOVER') {
    (async () => {
      if (!popup && sender.frameId !== 0) throw Error('Invalid sender');
      const tab = await chrome.tabs.get(tabId),
        url = tab.pendingUrl || tab.url,
        id = sessionFromUrl(url),
        s = sessions.get(tabId);
      if (!id || id !== msg.sessionId || (!popup && id !== sessionFromUrl(msg.pageUrl))) throw Error('会话已变化，未重新补读');
      return recoverCurrentSession(tabId, id);
    })().then(reply, e => reply({ok: false, error: e.message || '无法重新补读'}));
    return true;
  }
  if (msg.type === 'ATI_RERUN_DETAIL') {
    // 手动重拉：不重走会话授权，直接用当前 token 与已捕获的 runId 再读一轮 span 详情。
    // 门禁逐条对齐 ATI_SESSION_RECOVER，不放宽任何一条；失败原样上报，不自动重试。
    (async () => {
      if (!popup && sender.frameId !== 0) throw Error('Invalid sender');
      const tab = await chrome.tabs.get(tabId),
        url = tab.pendingUrl || tab.url,
        id = sessionFromUrl(url),
        s = sessions.get(tabId);
      if (!id || id !== msg.sessionId || (!popup && id !== sessionFromUrl(msg.pageUrl))) throw Error('会话已变化，未重拉');
      if (!s || s.halted) throw Error('请先手动开启当前页监听');
      if (!s.token || !s.claims?.runId) throw Error('尚未取得当前运行授权；请改用「重新补读当前会话」');
      if (s.generating || s.bootstrap) throw Error('正在生成中，请稍后重试');
      if (Date.now() - (s.lastRerun || 0) < RERUN_MIN_INTERVAL_MS) throw Error('重拉间隔至少 5 秒');
      s.lastRerun = Date.now();
      // 复位详情读取门禁，让既有流程原样重跑一轮：raw 归档、进度回调、命名判定与额度快照提取
      // 全部复用，不另起读取路径。nameReadAttempts 刻意不清零——它是自动补读的预算，
      // 手动重拉照常计入，否则等于绕过「补读已结束」的收敛条件。
      s.detailRead = false;
      s.completedDetailKey = null;
      s.nameRetryAt = 0;
      s.nameRetryPending = false;
      kickPoll(tabId, s);
      return {ok: true, runId: s.claims.runId};
    })().then(reply, e => reply({ok: false, error: e.message || '无法重拉当前 run'}));
    return true;
  }
  if (msg.type === 'ATI_PAGE_TOKEN') {
    (async () => {
      if (popup || sender.frameId !== 0 || typeof msg.token !== 'string') throw Error('Invalid sender');
      const tab = await chrome.tabs.get(tabId);
      const url = tab.pendingUrl || tab.url;
      const sessionId = sessionFromUrl(url);
      const s = sessions.get(tabId);
      if (!isArena(url) || !sessionId || sessionId !== sessionFromUrl(msg.pageUrl) || !s || s.halted) throw Error('Stale page');
      const claims = validateSessionToken(msg.token, sessionId);
      alignPage(tabId, url);
      if (!claims.runId) s.sessionToken = msg.token;
      // Page HTML may carry an older run; never replace already-observed live evidence.
      if (!s.claims) {
        if (claims.runId) {
          recovery(tabId, s, 'run', '已从页面取得 run 授权', {source: 'page'});
          void lookup(tabId, s, msg.token, sessionId).catch(() => {});
        } else void bootstrapPageSession(tabId, s, msg.token, sessionId).catch(() => {});
      }
      return {ok: true};
    })().then(reply, e => reply({ok: false, error: e?.message || '页面 token 读取失败'}));
    return true;
  }
  if (msg.type === 'ATI_HUD_GET' || msg.type === 'ATI_HUD_SAVE') {
    const task = msg.type === 'ATI_HUD_GET' ? hudPreferences.get() : hudPreferences.save(msg.prefs);
    task.then(
      prefs => reply({prefs}),
      () => reply({error: '界面位置与收起状态保存／读取失败'})
    );
    return true;
  }
  // sender.url can remain the original document URL after an Arena SPA navigation.
  // The current URL claim is still checked against this sender's actual tab.
  const pageUrl = !popup && typeof msg.pageUrl === 'string' ? msg.pageUrl : sender.url;
  if (!popup && !isArena(pageUrl)) return;
  // Hidden Agent UI: enable applies the posthog flag overrides, disable clears them.
  // posthog persists overrides in localStorage, so both directions survive a reload;
  // the HUD reads that same blob to label its button.
  if (msg.type === 'ATI_ENABLE_HIDDEN_AGENT_UI' || msg.type === 'ATI_DISABLE_HIDDEN_AGENT_UI') {
    const mode = msg.type === 'ATI_ENABLE_HIDDEN_AGENT_UI' ? 'enable' : 'disable';
    const failure = mode === 'enable' ? '隐藏 UI 启用失败' : '隐藏 UI 关闭失败';
    (async () => {
      if (popup || sender.frameId !== 0) throw Error('Invalid sender');
      const tab = await chrome.tabs.get(tabId);
      if (!isArena(tab.pendingUrl || tab.url) || !/^https:\/\/arena\.ai\/agent(?:\/|$)/.test(tab.pendingUrl || tab.url || '')) throw Error('请先切到 Arena Agent 页面');
      if (!isArena(pageUrl) || !/^https:\/\/arena\.ai\/agent(?:\/|$)/.test(pageUrl)) throw Error('页面状态已变化，请刷新后重试');
      const results = await chrome.scripting.executeScript({
        target: {tabId, frameIds: [0]},
        world: 'MAIN',
        args: [mode],
        func: mode => {
          const FLAGS = {
            'agent-model-selector': true,
            'agent-harness-randomization': 'treatment-1',
            'agent-mode-connectors': 'treatment-1',
            'agentic-arena-feedback': 'treatment-1',
            'agentic-custom-feedback': 'treatment-1'
          };
          const MARKER = 'ati.hiddenAgentUi.lastEnabled';
          const api = globalThis.posthog?.featureFlags;
          if (!api) return {ok: false, error: 'posthog featureFlags 不可用'};
          if (mode === 'enable') {
            if (!api.overrideFeatureFlags && !api.override) return {ok: false, error: 'posthog featureFlags.override 不可用'};
            api.overrideFeatureFlags ? api.overrideFeatureFlags({flags: FLAGS}) : api.override(FLAGS);
            try {
              localStorage.setItem(MARKER, new Date().toISOString());
            } catch {}
            return {ok: true, enabled: true};
          }
          // disable: false clears every override posthog is holding.
          if (!api.overrideFeatureFlags && !api.override) return {ok: false, error: 'posthog featureFlags.override 不可用'};
          api.overrideFeatureFlags ? api.overrideFeatureFlags(false) : api.override(false);
          try {
            localStorage.removeItem(MARKER);
          } catch {}
          return {ok: true, enabled: false};
        }
      });
      const value = results?.[0]?.result;
      if (!value?.ok) throw Error(value?.error || failure);
      return {ok: true, enabled: !!value.enabled};
    })().then(reply, e => reply({ok: false, error: e?.message || failure}));
    return true;
  }
  if (msg.type === 'ATI_ARCHIVE_PREPARE') {
    (async () => {
      if (popup || sender.frameId !== 0 || !(await storageReady)) throw Error('Invalid sender');
      conversationUrl(msg.sessionId);
      const tab = await chrome.tabs.get(tabId);
      if (sessionFromUrl(tab.pendingUrl || tab.url) !== msg.sessionId || sessionFromUrl(pageUrl) !== msg.sessionId) throw Error('Stale page');
      await stop(tabId); // Invalidate in-flight captures before touching the chat.
      for (const [key, value] of archiveTickets) if (value.expires < Date.now() || value.tabId === tabId) archiveTickets.delete(key);
      const cleanupFingerprint = await history.removalFingerprint(msg.sessionId);
      const ticket = crypto.randomUUID();
      archiveTickets.set(ticket, {tabId, sessionId: msg.sessionId, cleanupFingerprint, expires: Date.now() + 120000});
      reply({ticket, cleanupFingerprint});
    })().catch(() => reply({error: '无法准备归档；未删除聊天或本地记录'}));
    return true;
  }
  // 2.0.0 auto-draw preferences (prompt text + keep-only filter). Page top frame only; whitelist-sanitized in draw-prefs.
  if (msg.type === 'ATI_DRAW_PREFS_GET' || msg.type === 'ATI_DRAW_PREFS_SET') {
    (async () => {
      if (popup || sender.frameId !== 0 || !(await storageReady)) throw Error('Invalid sender');
      const tab = await chrome.tabs.get(tabId);
      if (!isArena(tab.pendingUrl || tab.url)) throw Error('Stale page');
      return msg.type === 'ATI_DRAW_PREFS_GET' ? drawPrefs.get() : drawPrefs.save(msg.prefs);
    })().then(
      prefs => reply({prefs}),
      () => reply({error: '自动抽卡设置读取／保存失败'})
    );
    return true;
  }
  if (['ATI_AUTO_RENAME_GET', 'ATI_AUTO_RENAME_SET', 'ATI_AUTO_RENAME_CLAIM', 'ATI_AUTO_RENAME_FINISH'].includes(msg.type)) {
    (async () => {
      if (popup || sender.frameId !== 0 || !(await storageReady)) throw Error('Invalid sender');
      // A failed operation can release its own lease after SPA navigation. The opaque
      // lease and sender tab are checked by the store; no other tab can finish it.
      if (msg.type === 'ATI_AUTO_RENAME_FINISH') {
        const res = await autoRename.finish(msg.sessionId, {
          leaseId: msg.leaseId,
          owner: tabId,
          success: msg.success === true,
          title: msg.title,
          previousTitle: msg.previousTitle,
          retryable: msg.retryable === true,
          submitted: msg.submitted === true,
          aborted: msg.aborted === true
        });
        if (res?.completed && normalizeChatTitle(msg.title)) {
          await chats.setTitle(msg.sessionId, msg.title).catch(() => {});
        }
        return res;
      }
      const tab = await chrome.tabs.get(tabId);
      if (!isArena(tab.pendingUrl || tab.url) || sessionFromUrl(tab.pendingUrl || tab.url) !== sessionFromUrl(pageUrl)) throw Error('Stale page');
      if (msg.type === 'ATI_AUTO_RENAME_GET') return autoRename.get();
      if (msg.type === 'ATI_AUTO_RENAME_SET') return autoRename.set(msg.enabled);
      const s = sessions.get(tabId),
        v = s?.view,
        spans = v?.run?.spans || [];
      if (
        !s ||
        s.halted ||
        s.generating ||
        v.historical ||
        !v.saved ||
        v.sessionId !== msg.sessionId ||
        v.runId !== msg.runId ||
        sessionFromUrl(pageUrl) !== msg.sessionId ||
        !v.models?.length ||
        !spans.length ||
        !spans.every(c => c.partial === false && !c.error && !c.cancelled)
      )
        return {claimed: false};
      const candidate = globalThis.ArenaTraceView.build(safeState(s));
      const title = candidate.renameTitle,
        internal = candidate.models[0]?.internal === true;
      if (!candidate.renameReady || msg.title !== title || msg.internal !== internal) return {claimed: false};
      const generation = s.generation,
        turn = s.turnVersion;
      const lease = await autoRename.reserve(msg.sessionId, {
        title,
        internal,
        owner: tabId,
        runId: msg.runId,
        serverTitle: candidate.models[0]?.serverLabel || candidate.serverModels?.[0]?.model || null,
        previousTitle: msg.previousTitle
      });
      const current = globalThis.ArenaTraceView.build(safeState(s));
      if (lease.claimed && (sessions.get(tabId) !== s || s.generation !== generation || s.turnVersion !== turn || !current.renameReady || current.renameTitle !== title)) {
        await autoRename.finish(msg.sessionId, {leaseId: lease.leaseId, owner: tabId, aborted: true});
        return {claimed: false};
      }
      return lease;
    })().then(reply, () => reply({error: '自动重命名设置或状态校验失败，请重试'}));
    return true;
  }
  if (msg.type === 'ATI_STATUS') {
    ensureListener(tabId)
      .then(() => restoreForTab(tabId, popup ? null : pageUrl))
      .then(reply, () => reply({enabled: false, ...emptyView(), status: '读取本地记录失败，请重试。'}));
    return true;
  }
  const setListening = msg.type === 'ATI_SET_LISTENING';
  if (!setListening && (msg.type !== 'ATI_TOGGLE' || !popup)) return;
  if (setListening && (typeof msg.enabled !== 'boolean' || (!popup && sender.frameId != null && sender.frameId !== 0))) return;
  // A page can control only its own tab (sender.tab.id), never msg.tabId.
  // Serialize popup and HUD actions; repeated "enable" requests are idempotent.
  const task = (listenCommands.get(tabId) || Promise.resolve())
    .catch(() => {})
    .then(async () => {
      try {
        if (!popup) {
          const tab = await chrome.tabs.get(tabId);
          const url = tab.pendingUrl || tab.url;
          if (!isArena(url) || sessionFromUrl(url) !== sessionFromUrl(pageUrl)) throw new Error('页面已变化，请在当前 Arena 页面重试');
        }
        const enabled = setListening ? msg.enabled : !sessions.get(tabId) || sessions.get(tabId).halted;
        if (!enabled) await chrome.tabs.sendMessage(tabId, {type: 'ATI_LISTENING_USER_STOP'}).catch(() => {});
        reply(enabled ? await start(tabId) : await stop(tabId));
      } catch (e) {
        const state = await restoreForTab(tabId).catch(() => safeState(sessions.get(tabId)));
        reply({...state, error: e.message, status: e.message});
      }
    });
  listenCommands.set(tabId, task);
  const cleanup = () => {
    if (listenCommands.get(tabId) === task) listenCommands.delete(tabId);
  };
  task.then(cleanup, cleanup);
  return true;
});
