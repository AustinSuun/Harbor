(() => {
  let host, panel, status, dot, compactDot, shell, content, compact, compactName, compactToken, compactCost, compactCount, compactStatus, expandButton, listenButton, quotaHost;
  let accountQuota = null,
    pulseInfo = null,
    pulseError = '',
    pulseLoading = false,
    pulseRunKey = '';
  let transcriptButton = null,
    transcriptBusy = false;
  let requestVersion = 0,
    displayedSession = null,
    latestState = null,
    retryTimer;
  let prefs,
    loadedPrefs = false,
    interactionVersion = 0,
    drag = null,
    sizeObserver = null,
    layoutError = '',
    listenError = '',
    listenPending = false,
    pageKey = location.pathname;
  let autoRename = false,
    autoLoaded = false,
    autoPending = false,
    autoChecking = false,
    archivePending = false,
    rerunPending = false,
    recoveryPending = false,
    lastListening = false;
  let drawStart,
    drawStop,
    drawStatus,
    drawRounds,
    drawMenu,
    drawMenuButton,
    drawMenuOpen = false,
    hiddenUiButton,
    hiddenUiPending = false,
    hiddenUiOn = false;
  const HIDDEN_UI_FLAGS = [
    ['agent-model-selector', true],
    ['agent-harness-randomization', 'treatment-1'],
    ['agent-mode-connectors', 'treatment-1'],
    ['agentic-arena-feedback', 'treatment-1'],
    ['agentic-custom-feedback', 'treatment-1']
  ];
  let drawRoundValue = 5;
  // 2.0.0 auto-draw setting (prompt text): loaded from the extension once, saved on change, frozen per job by auto-draw.js.
  let drawPrompt,
    drawPrefs = null,
    drawPrefsLoaded = false,
    drawPrefsSaving = false,
    drawPrefsError = '',
    drawRules,
    drawPolicy = null,
    drawPolicyLoaded = false;
  const drawing = () => !!globalThis.ArenaAutoDraw?.status().running;
  function updateDraw() {
    if (!drawStart) return;
    const s = ArenaAutoDraw.status();
    const count = Number(drawRounds?.value);
    drawStart.disabled =
      s.running || archivePending || listenPending || !latestState?.enabled || latestState?.initializing || latestState?.connectionError || !Number.isInteger(count) || count < 1 || count > 100;
    if (drawRounds) drawRounds.disabled = s.running;
    if (drawPrompt) {
      drawPrompt.disabled = s.running || drawPrefsSaving;
      if (document.activeElement !== drawPrompt && drawPrefs && drawPrompt.value !== drawPrefs.prompt) drawPrompt.value = drawPrefs.prompt;
    }
    if (drawRules) {
      const r = drawPolicy?.rules,
        parts = [];
      if (r?.include?.length) parts.push('保留 ' + r.include.join('、'));
      if (r?.exclude?.length) parts.push('排除 ' + r.exclude.join('、'));
      if (r?.tiers?.length) parts.push('档位 ' + r.tiers.join('/'));
      drawRules.textContent = '保留规则：' + (!drawPolicy ? '在抽卡设置中配置' : !r?.enabled ? '未启用（全部保留）' : parts.join('；') || '已启用');
    }
    drawStop.disabled = !s.running;
    drawStatus.textContent =
      !s.running && !latestState?.enabled
        ? (s.phase !== 'idle' && s.progress && !/请先开启监听/.test(s.progress) ? s.progress + ' · ' : '') + '请先开启监听，再开始自动抽卡。'
        : s.phase === 'idle' && latestState?.enabled
          ? '监听中 · 设置轮数后点击「开始抽卡」；每轮新建聊天并发送 1 条消息「' + (drawPrefs?.prompt || '1+1=') + '」' + (drawPrefsError ? ' · ' + drawPrefsError : '')
          : s.progress;
    if (drawMenuButton) {
      const live = s.running && Number.isInteger(s.round) && Number.isInteger(s.total);
      drawMenuButton.textContent = live ? `抽卡 ${s.round}/${s.total}` : s.running ? '抽卡中…' : '自动抽卡';
      drawMenuButton.classList.toggle('active', !!s.running);
      drawMenuButton.title = s.running ? '自动抽卡进行中 · 点击查看进度或停止' : '打开自动抽卡菜单';
    }
    updateListenControl();
  }
  const drawPrefsApi = () => globalThis.ArenaDrawPrefs || null;
  // The button cycles: show hidden UI -> restore original UI -> show hidden UI ...
  // Truth comes from posthog's persisted override, read back on every page load.
  function updateHiddenUiButton() {
    if (!hiddenUiButton) return;
    hiddenUiButton.textContent = hiddenUiOn ? '还原UI' : '展示隐藏UI';
    hiddenUiButton.classList.toggle('active', hiddenUiOn);
    hiddenUiButton.setAttribute('aria-pressed', String(hiddenUiOn));
    hiddenUiButton.title = hiddenUiOn
      ? '清除本地 posthog flag 覆盖，还原 Arena 默认界面；仅改当前浏览器前端 flags，不发送消息'
      : '临时展示 Agent model/harness/connectors 等隐藏 UI；仅改当前浏览器前端 flags，不发送消息';
  }
  // posthog persists overrides in its own localStorage blob, which this content script
  // can read directly (same origin as the page). No message, no await, no wrong label.
  function readHiddenUiOn() {
    try {
      const key = Object.keys(localStorage).find(k => /^ph_.*_posthog$/.test(k));
      if (!key) return false;
      const ov = JSON.parse(localStorage.getItem(key) || '{}')['$override_feature_flags'];
      return !!ov && HIDDEN_UI_FLAGS.every(([f, v]) => ov[f] === v);
    } catch {
      return false;
    }
  }
  async function toggleHiddenAgentUi() {
    if (hiddenUiPending) return;
    // Re-read before acting: another tab may have flipped the override since paint.
    hiddenUiOn = readHiddenUiOn();
    const turningOn = !hiddenUiOn;
    hiddenUiPending = true;
    if (hiddenUiButton) hiddenUiButton.disabled = true;
    listenError = turningOn ? '正在展示 Agent 隐藏 UI…' : '正在还原 Arena 默认界面…';
    showSaveStatus();
    try {
      const r = await chrome.runtime.sendMessage({type: turningOn ? 'ATI_ENABLE_HIDDEN_AGENT_UI' : 'ATI_DISABLE_HIDDEN_AGENT_UI', pageUrl: location.href});
      if (!r?.ok) throw Error(r?.error || (turningOn ? '隐藏 UI 启用失败' : '隐藏 UI 关闭失败'));
      hiddenUiOn = !!r.enabled;
      updateHiddenUiButton();
      listenError = (hiddenUiOn ? '隐藏 UI 已展示' : '已还原默认界面') + '，页面即将刷新';
      showSaveStatus();
      setTimeout(() => location.reload(), 250);
    } catch (e) {
      hiddenUiPending = false;
      if (hiddenUiButton) hiddenUiButton.disabled = false;
      listenError = e?.message || (turningOn ? '隐藏 UI 启用失败，请重试' : '隐藏 UI 还原失败，请重试');
      showSaveStatus();
    }
  }
  async function loadDrawPrefs() {
    if (drawPrefsLoaded || !drawPrefsApi()) return;
    drawPrefsLoaded = true;
    try {
      const r = await chrome.runtime.sendMessage({type: 'ATI_DRAW_PREFS_GET', pageUrl: location.href});
      if (r?.error || !r?.prefs) throw Error(r?.error || '读取失败');
      drawPrefs = drawPrefsApi().sanitize(r.prefs);
      drawPrefsError = '';
    } catch {
      drawPrefsLoaded = false;
      drawPrefs = drawPrefs || drawPrefsApi().defaults();
      drawPrefsError = '抽卡设置读取失败，使用默认值';
    }
    updateDraw();
  }
  // 只读：规则仍然只能在任务中心修改，这里只是让 HUD 能看出当前筛选状态。
  async function loadDrawPolicy() {
    if (drawPolicyLoaded || !chrome.runtime?.id) return;
    drawPolicyLoaded = true;
    try {
      const r = await chrome.runtime.sendMessage({type: 'ATI_DRAW_POLICY_GET', pageUrl: location.href});
      if (r?.error || !r?.policy) throw Error(r?.error || '读取失败');
      drawPolicy = r.policy;
    } catch {
      drawPolicyLoaded = false;
      drawPolicy = null;
    }
    updateDraw();
  }
  async function saveDrawPrefs(patch) {
    if (!drawPrefsApi() || drawing()) return;
    const next = drawPrefsApi().sanitize({...(drawPrefs || drawPrefsApi().defaults()), ...patch});
    drawPrefsSaving = true;
    updateDraw();
    try {
      const r = await chrome.runtime.sendMessage({type: 'ATI_DRAW_PREFS_SET', prefs: next, pageUrl: location.href});
      if (r?.error || !r?.prefs) throw Error(r?.error || '保存失败');
      drawPrefs = drawPrefsApi().sanitize(r.prefs);
      drawPrefsError = '';
    } catch {
      drawPrefsError = '抽卡设置保存失败，本次启动仍按输入框内容执行前请重试';
    } finally {
      drawPrefsSaving = false;
      updateDraw();
    }
  }
  function setDrawMenu(open) {
    if (!drawMenu) return;
    drawMenuOpen = !!open;
    drawMenu.hidden = !drawMenuOpen;
    drawMenuButton.setAttribute('aria-expanded', String(drawMenuOpen));
    if (drawMenuOpen) {
      void loadDrawPrefs();
      void loadDrawPolicy();
      updateDraw();
      (drawRounds?.disabled ? drawStop : drawRounds)?.focus?.({preventScroll: true});
    }
  }
  globalThis.ArenaAutoDraw?.configure({
    readState: () => latestState,
    onProgress: () => {
      updateDraw();
    }
  });
  const renameBackoff = new Map(),
    renameFailedHere = new Set();
  let renameRetryTimer;
  const attemptedHere = new Map(); // sessionId -> true when the internal name was used (no further upgrade)
  function repaint() {
    if (latestState) render(latestState);
  }
  // 与 background.js 的 newerQuota 同一口径：快照可能由任意标签页或任意一轮运行写入，只接受 checkedAt 更晚的那份。
  // 无条件赋值会在服务工作线程重启后把显示退回更旧的快照（手动刷新时尤其明显）。
  const newerQuota = (a, b) => (!a ? b || null : !b ? a : String(b.checkedAt || '') > String(a.checkedAt || '') ? b : a);
  let rateLimits = null;
  const mergeRl = (a, b) => globalThis.ArenaBilling?.mergeRateLimits?.(a, b) || b || a || null;
  // Daily pulse: read via background (same-origin cookies); refreshed on HUD creation, on user click, and once after each completed run.
  async function loadPulse(force = false) {
    if (pulseLoading || !chrome.runtime?.id) return;
    let quotaRefreshed = false;
    pulseLoading = true;
    paintPulse();
    try {
      const r = await chrome.runtime.sendMessage({type: 'ATI_PULSE', force, pageUrl: location.href});
      if (r?.pulse) pulseInfo = r.pulse;
      const nextQuota = newerQuota(accountQuota, r?.accountQuota);
      if (nextQuota !== accountQuota) {
        accountQuota = nextQuota;
        quotaRefreshed = true;
      }
      if (r?.rateLimits) {
        rateLimits = mergeRl(rateLimits, r.rateLimits);
        if (latestState) latestState = {...latestState, rateLimits};
      }
      pulseError = r?.error || '';
    } catch {
      pulseError = '每日额度读取失败';
    } finally {
      pulseLoading = false;
      paintPulse();
      if (quotaRefreshed) repaint();
    }
  }
  function paintPulse() {
    const f = globalThis.ArenaBilling?.formatPulse(pulseInfo) || {pct: null, tone: 'none', rows: []};
    panel?.setPulse?.({...f, ...(rateLimits ? {rateLimits} : {}), loading: pulseLoading, error: pulseError, onRefresh: () => void loadPulse(true)});
  }
  let lazySaveTimer = null;
  const lazySessionState = new Map();
  function transcriptDomSnapshot(sessionId) {
    if (!sessionId || typeof document.querySelectorAll !== 'function') return null;
    const nodes = document.querySelectorAll('main div.prose');
    const count = nodes ? nodes.length : 0;
    if (!count) return null;
    const hasBoundary = Boolean(typeof document.querySelector === 'function' && document.querySelector('[data-earlier-messages-boundary="true"]'));
    const first = [...nodes]
      .slice(0, 3)
      .map(node => (node?.textContent || '').trim().slice(0, 64))
      .join('\u0000');
    return {count, hasBoundary, first};
  }
  function scheduleLazyTranscriptSave(sessionId) {
    clearTimeout(lazySaveTimer);
    lazySaveTimer = setTimeout(() => {
      lazySaveTimer = null;
      if (!agentPage() || currentSession() !== sessionId) return;
      if (transcriptBusy || drawing() || archivePending || latestState?.generating || latestState?.initializing || latestState?.usage?.partial) return;
      const prev = lazySessionState.get(sessionId);
      if (prev) prev.pendingSave = false;
      void captureTranscriptNow(true, true);
    }, 500);
  }
  function observeLazyTranscript() {
    if (!globalThis.ArenaTranscript || typeof document.querySelectorAll !== 'function') return;
    const sessionId = agentPage() ? currentSession() : null;
    if (!sessionId || drawing() || archivePending || latestState?.generating || latestState?.usage?.partial) return;
    const snap = transcriptDomSnapshot(sessionId);
    if (!snap) return;
    const prev = lazySessionState.get(sessionId);
    if (!prev) {
      lazySessionState.set(sessionId, {hadBoundary: snap.hasBoundary, count: snap.count, first: snap.first, lastSig: '', pendingSave: false});
      return;
    }
    if (snap.hasBoundary) prev.hadBoundary = true;
    const prependedMessages = prev.hadBoundary && snap.count > prev.count && snap.first !== prev.first;
    prev.count = snap.count;
    prev.first = snap.first;
    if (prependedMessages) prev.pendingSave = true;
    if (prev.pendingSave && !transcriptBusy && !latestState?.initializing) scheduleLazyTranscriptSave(sessionId);
  }
  /* 2.3.0: read the rendered transcript and hand it to the service worker.
     DOM-only; sends no message to Arena and never mutates the page. */
  async function captureTranscriptNow(auto = false, lazy = false) {
    if (transcriptBusy || !chrome.runtime?.id || !globalThis.ArenaTranscript) return;
    const sessionId = currentSession();
    if (!sessionId) {
      if (!auto) listenError = '请先打开一个 Arena 会话页面';
      repaint();
      return;
    }
    transcriptBusy = true;
    updateTranscriptButton();
    try {
      const transcript = globalThis.ArenaTranscript.captureTranscript(document);
      if (!transcript?.messages?.length) throw Error('没有读到对话正文，请先滚动加载会话内容');
      const sig =
        sessionId +
        ':' +
        transcript.messages.length +
        ':' +
        transcript.chars +
        ':' +
        (transcript.messages[0]?.text?.slice(0, 48) || '') +
        ':' +
        (transcript.messages[transcript.messages.length - 1]?.text?.slice(0, 48) || '');
      const lazyPrev = lazySessionState.get(sessionId);
      if (lazy && lazyPrev?.lastSig === sig) return;
      const title = globalThis.ArenaConversationRename?.currentTitle?.(sessionId) || null;
      const r = await chrome.runtime.sendMessage({
        type: 'ATI_TRANSCRIPT_SAVE',
        sessionId,
        transcript,
        ...(auto ? {auto: true} : {}),
        ...(lazy ? {lazy: true} : {}),
        ...(title ? {title} : {}),
        pageUrl: location.href
      });
      if (r?.skipped) return;
      if (r?.error) throw Error(r.error);
      const snap = transcriptDomSnapshot(sessionId);
      lazySessionState.set(sessionId, {
        hadBoundary: Boolean(lazyPrev?.hadBoundary || snap?.hasBoundary),
        count: snap?.count ?? lazyPrev?.count ?? transcript.messages.length,
        first: snap?.first ?? lazyPrev?.first ?? '',
        lastSig: sig,
        pendingSave: false
      });
      listenError = '已保存 ' + r.messages + ' 条消息' + (r.truncated ? '（已按上限截断）' : '');
    } catch (e) {
      if (!auto) listenError = e?.message || '保存对话正文失败';
    } finally {
      transcriptBusy = false;
      updateTranscriptButton();
      repaint();
      if (lazySessionState.get(sessionId)?.pendingSave && !latestState?.initializing) scheduleLazyTranscriptSave(sessionId);
    }
  }
  function updateTranscriptButton() {
    if (!transcriptButton) return;
    transcriptButton.disabled = transcriptBusy;
    transcriptButton.textContent = transcriptBusy ? '保存中…' : '保存本会话';
  }
  async function loadAutoRename() {
    if (autoLoaded || latestState?.initializing || latestState?.connectionError) return;
    autoLoaded = true;
    try {
      const r = await chrome.runtime.sendMessage({type: 'ATI_AUTO_RENAME_GET', pageUrl: location.href});
      if (r?.error) throw Error(r.error);
      if (!autoPending) autoRename = !!r.enabled;
      repaint();
    } catch {
      autoLoaded = false;
    }
  }
  async function setAutoRename(enabled) {
    if (autoPending) return;
    autoPending = true;
    repaint();
    try {
      const r = await chrome.runtime.sendMessage({type: 'ATI_AUTO_RENAME_SET', enabled, pageUrl: location.href});
      if (r?.error) throw Error(r.error);
      autoRename = !!r.enabled;
      listenError = '';
    } catch {
      listenError = '自动重命名设置保存失败，请重试';
    } finally {
      autoPending = false;
      repaint();
    }
  }
  function scheduleRenameRetry(key, delay) {
    const wait = Math.max(250, Math.min(60000, delay));
    renameBackoff.set(key, Date.now() + wait);
    clearTimeout(renameRetryTimer);
    renameRetryTimer = setTimeout(() => {
      renameBackoff.delete(key);
      repaint();
    }, wait);
  }
  async function maybeAutoRename(view) {
    if (
      drawing() ||
      archivePending ||
      !autoRename ||
      autoPending ||
      autoChecking ||
      !view.renameReady ||
      view.historical ||
      !latestState?.saved ||
      !view.sessionId ||
      !view.models.length ||
      view.completion !== '调用已完成' ||
      !view.detail ||
      view.detailPending
    )
      return;
    const internal = view.models[0].internal === true,
      session = view.sessionId,
      title = view.renameTitle || view.models[0].model,
      key = session + ':' + title;
    const done = attemptedHere.get(session);
    if (done === true || (done === false && !internal) || renameFailedHere.has(key) || (renameBackoff.get(key) || 0) > Date.now()) return;
    autoChecking = true;
    const snapshot = latestState;
    let lease = null;
    try {
      const r = await chrome.runtime.sendMessage({
        type: 'ATI_AUTO_RENAME_CLAIM',
        sessionId: session,
        runId: view.runId,
        pageUrl: location.href,
        title,
        internal,
        previousTitle: globalThis.ArenaConversationRename?.currentTitle?.(session) ?? null
      });
      if (r?.error) throw Error(r.error);
      if (r?.claimed) {
        lease = r;
        const current = ArenaTraceView.build(latestState);
        const valid = autoRename && currentSession() === session && latestState?.runId === view.runId && current.renameReady && current.renameTitle === title;
        const result = valid ? await panel.renameModel(title, {...view, automatic: true, expectedTitle: r.previousTitle}) : {ok: false, aborted: true};
        if (result?.ok) attemptedHere.set(session, internal); // Only after the UI observed success.
        const finish = await chrome.runtime.sendMessage({
          type: 'ATI_AUTO_RENAME_FINISH',
          sessionId: session,
          leaseId: r.leaseId,
          pageUrl: location.href,
          success: result?.ok === true,
          title: result?.title || title,
          previousTitle: result?.previousTitle,
          retryable: result?.retryable === true,
          submitted: result?.submitted === true,
          aborted: result?.aborted === true
        });
        lease = null;
        if (finish?.retryAfterMs && currentSession() === session) scheduleRenameRetry(key, finish.retryAfterMs);
        if (finish?.final) renameFailedHere.add(key);
        if (!finish?.ok) throw Error('命名完成状态保存失败');
      } else if (r?.retryAfterMs) scheduleRenameRetry(key, r.retryAfterMs);
      else if (r?.final) {
        if (r.failed) renameFailedHere.add(key);
        else attemptedHere.set(session, internal);
      }
    } catch {
      if (lease) void chrome.runtime.sendMessage({type: 'ATI_AUTO_RENAME_FINISH', sessionId: session, leaseId: lease.leaseId, pageUrl: location.href, submitted: true, success: false}).catch(() => {});
      renameFailedHere.add(key);
      listenError = '自动重命名未确认完成；请检查标题后手动重试';
      showSaveStatus();
    } finally {
      autoChecking = false;
      if (latestState !== snapshot) repaint();
    }
  }
  async function recoverCurrent(view) {
    if (recoveryPending || drawing() || archivePending || view.sessionId !== currentSession()) return;
    recoveryPending = true;
    repaint();
    try {
      const r = await chrome.runtime.sendMessage({type: 'ATI_SESSION_RECOVER', sessionId: view.sessionId, pageUrl: location.href});
      if (!r?.ok) throw Error(r?.error || '无法补读');
      listenError = '';
    } catch (e) {
      listenError = e.message || '补读失败';
    } finally {
      recoveryPending = false;
      repaint();
    }
  }
  // 手动重拉当前 run：只复位详情读取门禁并让既有流程重跑一轮，不重走会话授权。
  async function rerunCurrentDetail(view) {
    if (rerunPending || drawing() || archivePending || view.sessionId !== currentSession()) return;
    rerunPending = true;
    repaint();
    try {
      const r = await chrome.runtime.sendMessage({type: 'ATI_RERUN_DETAIL', sessionId: view.sessionId, pageUrl: location.href});
      if (!r?.ok) throw Error(r?.error || '无法重拉当前 run');
      listenError = '';
    } catch (e) {
      listenError = e.message || '重拉失败';
    } finally {
      rerunPending = false;
      repaint();
    }
  }
  async function archiveCurrentChat(view) {
    if (drawing() || archivePending || autoChecking || ArenaConversationRename.isBusy() || view.sessionId !== currentSession()) return;
    archivePending = true;
    repaint();
    let archived = false;
    try {
      const prep = await chrome.runtime.sendMessage({type: 'ATI_ARCHIVE_PREPARE', sessionId: view.sessionId, pageUrl: location.href});
      if (!prep?.ticket) throw Error(prep?.error || '归档准备失败');
      const result = await ArenaConversationRename.archive({sessionId: view.sessionId, isCurrent: () => archivePending && currentSession() === view.sessionId});
      if (!result?.archived) throw Error('未确认归档，本地记录保留');
      archived = true;
      const removed = await chrome.runtime.sendMessage({type: 'ATI_ARCHIVE_FINISH', ticket: prep.ticket, archived: true});
      if (!removed?.ok) throw Error(removed?.error || '本地记录清理失败');
      listenError = '聊天已归档，本地记录已删除';
    } catch (e) {
      listenError = archived ? '聊天已归档，但本地记录清理失败；请在扩展会话列表删除记录' : e?.message || '归档失败，本地记录保留';
    } finally {
      archivePending = false;
      repaint();
    }
  }
  const currentSession = () => location.pathname.match(/^\/agent\/([a-zA-Z0-9-]{1,128})\/?$/)?.[1] || null;
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const viewport = () => ({width: window.innerWidth, height: window.innerHeight});
  function moveTo(point) {
    if (!host) return;
    const p = ArenaHudLayout.clamp(point, host.getBoundingClientRect(), viewport());
    host.style.left = p.x + 'px';
    host.style.top = p.y + 'px';
  }
  function placeSaved() {
    if (host) moveTo(ArenaHudLayout.position(prefs.position, host.getBoundingClientRect(), viewport()));
  }
  function keepVisible() {
    if (host) {
      const r = host.getBoundingClientRect();
      moveTo({x: r.left, y: r.top});
    }
  }
  function rememberPosition() {
    if (!host) return;
    const r = host.getBoundingClientRect();
    prefs.position = ArenaHudLayout.normalize({x: r.left, y: r.top}, r, viewport());
  }
  function showSaveStatus() {
    // HUD-local messages (listen/rename/archive/delete errors, layout save errors) stay next to the listen button;
    // the background pipeline status (latestState.status) is rendered inside the 状态 metric card by panel.render.
    if (status) {
      const text = [listenError, layoutError].filter(Boolean).join(' · ');
      status.textContent = text;
      status.hidden = !text;
    }
    if (compactStatus) compactStatus.title = (latestState?.status || '') + (layoutError ? ' · ' + layoutError : '');
  }
  async function savePrefs() {
    try {
      const result = await chrome.runtime.sendMessage({type: 'ATI_HUD_SAVE', prefs});
      if (result?.error || !result?.prefs) throw Error('save failed');
      layoutError = '';
    } catch {
      layoutError = '位置／收起状态未能保存，本页操作仍然有效';
    }
    showSaveStatus();
  }
  function loadPrefs() {
    if (loadedPrefs) return;
    loadedPrefs = true;
    const version = interactionVersion;
    chrome.runtime
      .sendMessage({type: 'ATI_HUD_GET'})
      .then(result => {
        if (result?.error || !result?.prefs) return;
        if (version !== interactionVersion) return; // A late read must not undo a user's drag.
        prefs = ArenaHudLayout.sanitize({...result.prefs, collapsed: false}); // New page visits always open expanded; keep the saved position.
        if (host) {
          applyMode();
          placeSaved();
        }
      })
      .catch(() => {});
  }
  function applyMode() {
    if (!shell) return;
    shell.classList.toggle('collapsed', prefs.collapsed);
    content.hidden = prefs.collapsed;
    compact.hidden = !prefs.collapsed;
    host.setAttribute('data-collapsed', String(prefs.collapsed));
  }
  function setCollapsed(value) {
    interactionVersion++;
    if (value) setDrawMenu(false);
    const r = host.getBoundingClientRect();
    prefs.collapsed = value;
    applyMode();
    moveTo({x: r.left, y: r.top});
    rememberPosition();
    void savePrefs();
    if (value) expandButton.focus({preventScroll: true});
    else shell.querySelector('.collapse-button').focus({preventScroll: true});
  }
  function updateListenControl() {
    if (!listenButton) return;
    const enabled = !!latestState?.enabled,
      initializing = !!latestState?.initializing;
    listenButton.disabled = drawing() || archivePending || listenPending || initializing;
    listenButton.textContent = listenPending ? '处理中…' : initializing ? '读取状态…' : latestState?.connectionError ? '重试连接' : enabled ? '停止监听' : '开启监听';
    listenButton.setAttribute('aria-pressed', String(enabled));
    listenButton.title = initializing ? '正在连接扩展' : latestState?.connectionError ? '扩展连接暂时不可用' : enabled ? '当前页监听中 · 点击停止' : '当前页未监听 · 点击开启';
  }
  async function changeListening() {
    if (drawing() || archivePending || listenPending || latestState?.initializing) return;
    if (latestState?.connectionError) {
      listenError = '';
      render({...latestState, initializing: true, connectionError: false, status: '正在重新连接扩展…'});
      refresh();
      return;
    }
    const session = currentSession(),
      path = location.pathname;
    listenPending = true;
    listenError = '';
    updateListenControl();
    if (globalThis.ArenaAutoDraw) updateDraw();
    showSaveStatus();
    try {
      const result = await chrome.runtime.sendMessage({type: 'ATI_SET_LISTENING', enabled: !latestState?.enabled, pageUrl: location.href});
      if (path !== location.pathname || session !== currentSession()) return;
      if (!result || result.restoring || (result.sessionId && result.sessionId !== session)) throw Error('页面状态已变化，请稍后重试');
      if (result.error) listenError = result.error;
      render(result);
    } catch (error) {
      if (path === location.pathname) listenError = error?.message || '操作失败，请重新加载扩展后刷新页面';
    } finally {
      listenPending = false;
      updateListenControl();
      if (globalThis.ArenaAutoDraw) updateDraw();
      showSaveStatus();
    }
  }
  function addDrag(handle) {
    handle.tabIndex = 0;
    handle.setAttribute('role', 'group');
    handle.setAttribute('aria-label', '拖动浮层；也可用方向键移动，Home 键复位');
    handle.title = '按住拖动 · 方向键微调 · Home 回到右下角';
    handle.addEventListener('pointerdown', event => {
      if (!event.isPrimary || event.button !== 0 || event.target.closest('button,a,input,select,textarea,.draw-menu')) return;
      event.preventDefault();
      interactionVersion++;
      const r = host.getBoundingClientRect();
      drag = {id: event.pointerId, startX: event.clientX, startY: event.clientY, left: r.left, top: r.top, moved: false};
      handle.setPointerCapture(event.pointerId);
      host.classList.add('dragging');
    });
    handle.addEventListener('pointermove', event => {
      if (!drag || drag.id !== event.pointerId) return;
      event.preventDefault();
      const dx = event.clientX - drag.startX,
        dy = event.clientY - drag.startY;
      if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
      moveTo({x: drag.left + dx, y: drag.top + dy});
    });
    const finish = event => {
      if (!drag || drag.id !== event.pointerId) return;
      const moved = drag.moved;
      drag = null;
      host?.classList.remove('dragging');
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      if (moved) {
        rememberPosition();
        void savePrefs();
      }
    };
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
    handle.addEventListener('lostpointercapture', finish);
    handle.addEventListener('keydown', event => {
      if (event.target !== handle) return;
      const steps = {ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]};
      if (event.key === 'Home') {
        event.preventDefault();
        interactionVersion++;
        prefs.position = {x: 1, y: 1};
        placeSaved();
        void savePrefs();
        return;
      }
      if (!steps[event.key]) return;
      event.preventDefault();
      interactionVersion++;
      const r = host.getBoundingClientRect(),
        d = steps[event.key],
        step = event.shiftKey ? 40 : 10;
      moveTo({x: r.left + d[0] * step, y: r.top + d[1] * step});
      rememberPosition();
      void savePrefs();
    });
  }
  function createHost() {
    sizeObserver?.disconnect();
    drag = null;
    host = el('div');
    host.id = 'arena-trace-inspector-hud';
    host.style.cssText = 'position:fixed;left:12px;top:12px;z-index:2147483647';
    const root = host.attachShadow({mode: 'closed'}),
      style = el('style');
    style.textContent = `
:host{all:initial}.shell{box-sizing:border-box;width:370px;max-width:calc(100vw - 24px);max-height:calc(100dvh - 24px);display:flex;flex-direction:column;border:1px solid #3b554a;border-radius:15px;background:#111a20;color:#e8f1f0;font:12px/1.55 system-ui,sans-serif;box-shadow:0 12px 48px #0007;overflow:hidden}.shell *{box-sizing:border-box}[hidden]{display:none!important}.header{display:flex;align-items:center;gap:8px;padding:10px 13px;border-bottom:1px solid #2b3b42;flex-shrink:0;position:relative}.header strong{font-size:12.5px;flex:1;white-space:nowrap;letter-spacing:.2px}.drag-handle{cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none}.drag-handle:active{cursor:grabbing}.dot{width:6px;height:6px;border-radius:50%;background:#92e4b9;flex-shrink:0}button{font:11.5px/1.3 system-ui,sans-serif;border:1px solid #3b5147;border-radius:6px;background:transparent;color:#bce7d0;cursor:pointer;padding:4px 9px;white-space:nowrap}button:focus-visible,.drag-handle:focus-visible{outline:2px solid #9ae9ca;outline-offset:-3px}.content{min-height:0;max-height:70vh;overflow:auto;padding:12px 13px 13px}.draw-menu-button,.header-button{padding:4px 9px;white-space:nowrap;font-variant-numeric:tabular-nums}.draw-menu-button[aria-expanded="true"]{background:#ffffff12}.draw-menu-button.active,.header-button.active{border-color:#5f9a85;background:#235b4b;color:#e3fff1;font-weight:650}.draw-menu{position:absolute;top:calc(100% + 142px);left:12px;z-index:5;width:288px;max-width:calc(100% - 24px);padding:12px 13px 11px;border:1px solid #3d5a50;border-radius:11px;background:#17242b;box-shadow:0 14px 36px #000a;cursor:default;user-select:text;-webkit-user-select:text}.draw-menu:before{content:'';position:absolute;top:-6px;left:36px;width:10px;height:10px;transform:rotate(45deg);background:#17242b;border-left:1px solid #3d5a50;border-top:1px solid #3d5a50}
.draw-menu-head{display:flex;align-items:baseline;gap:8px;margin-bottom:10px}.draw-menu-head strong{font-size:12px;color:#d8ece4}.draw-menu-hint{font-size:10px;color:#8fa6a2}.draw-settings{display:flex;flex-direction:column;gap:7px;margin-bottom:9px;padding-bottom:9px;border-bottom:1px solid #2b3f3a}.draw-rules{display:block;width:100%;text-align:left;font-size:11px;color:#bad9ce;background:transparent;border:1px dashed #2b3f3a;border-radius:6px;padding:5px 7px;cursor:pointer}.draw-rules:hover{border-color:#3d5c54;color:#d8ece4}.draw-prompt-row{display:flex;align-items:center;gap:7px}.draw-prompt-label{font-size:11px;color:#aac1b8;white-space:nowrap}.draw-prompt{flex:1;min-width:0;border:1px solid #3b5147;border-radius:6px;background:#111a20;color:#d6eee2;padding:6px 8px;font:12px system-ui}.draw-prompt:disabled{opacity:.5}.draw-controls{display:flex;gap:7px;align-items:center}.draw-rounds-label{font-size:11px;color:#aac1b8;white-space:nowrap}.draw-rounds{width:56px;min-width:48px;border:1px solid #3b5147;border-radius:6px;background:#111a20;color:#d6eee2;padding:6px;font:12px system-ui}.draw-rounds:disabled{opacity:.5}.draw-controls button{padding:6px 10px}.draw-start{border-color:#5f9a85;background:#235b4b;color:#e3fff1;font-weight:650}.draw-stop{color:#f0b3ad;border-color:#78504d}.draw-controls button:disabled{opacity:.4;cursor:default}.draw-status{font-size:10px;line-height:1.6;color:#9bb6ae;margin:9px 0 0;overflow-wrap:anywhere;min-height:16px}.listen-controls{display:grid;grid-template-columns:88px minmax(0,1fr);gap:8px;align-items:stretch;margin-bottom:10px}.left-actions{display:flex;flex-direction:column;gap:6px;min-width:0}.listen-button{flex:1.25;min-height:46px;padding:6px 8px;border-color:#5f9a85;border-radius:10px;background:#235b4b;color:#e3fff1;font:650 13px/1.2 system-ui,sans-serif;letter-spacing:.3px;display:flex;align-items:center;justify-content:center}.listen-button[aria-pressed="true"]{background:#1c3f36;border-color:#3f6e5c;color:#cfeedd}.listen-button:disabled{opacity:.6;cursor:wait}.left-actions .transcript-button,.left-actions .draw-menu-button{flex:1;min-height:33px;padding:4px 6px;border:1px solid #355046;border-radius:8px;background:#152328;color:#c4e8d8;font:600 11.5px/1.2 system-ui,sans-serif;display:flex;align-items:center;justify-content:center}.left-actions .transcript-button:hover,.left-actions .draw-menu-button:hover{border-color:#4d7567;background:#192b30}.left-actions .draw-menu-button.active{border-color:#5f9a85;background:#235b4b;color:#e3fff1}.quota-slot{min-width:0;min-height:124px;display:flex;flex-direction:column;justify-content:stretch}.quota-slot .quota{flex:1}.status{color:#e6c598;font-size:11px;margin:0 0 10px;overflow-wrap:anywhere}.content::-webkit-scrollbar{width:5px}.content::-webkit-scrollbar-thumb{background:#3d5054;border-radius:4px}.shell.collapsed{width:312px;border-color:#2e4a40;border-radius:13px;background:linear-gradient(165deg,#142227,#111a20)}.collapsed .header{display:none}.compact{padding:10px 12px 11px;overflow:auto;display:flex;flex-direction:column;gap:7px}.compact-head{display:flex;align-items:center;gap:6px;min-height:22px;margin:0}.compact-title{flex:1;min-width:0;font:650 10.5px/1.2 system-ui,sans-serif;letter-spacing:.55px;color:#8ab5a8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.compact-name{min-width:0;margin:0;padding:6px 9px;border-radius:8px;background:linear-gradient(135deg,#172c25,#132122);border:1px solid #315043;font:650 14.5px/1.3 ui-monospace,Consolas,monospace;letter-spacing:-.3px;color:#acf0ce;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.compact-name.switched{background:linear-gradient(135deg,#341b1b,#241618);border-color:#8c4b4b;color:#ffc9c9}.expand-button{flex:0 0 auto;width:22px;height:22px;padding:0;font-size:13px;border-radius:6px;border:1px solid #314b43;color:#bfe5d3;background:#152328;display:inline-flex;align-items:center;justify-content:center}.expand-button:hover{background:#1b2e34;border-color:#4b7567;color:#e3fff1}.compact-grid{display:grid;grid-template-columns:1fr 1fr;gap:5px 6px;margin:0}.compact-field{min-width:0;display:flex;align-items:baseline;justify-content:space-between;gap:6px;padding:5px 8px;border-radius:7px;background:#152127;border:1px solid #24353c}.compact-field dt{font:500 10px/1.3 system-ui,sans-serif;color:#8ea5a9;margin:0;white-space:nowrap;flex-shrink:0}.compact-field dd{font:650 11.5px/1.3 ui-monospace,Consolas,monospace;color:#e6f2ef;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin:0;text-align:right}.compact-field dd.compact-state{font:600 11px/1.3 system-ui,sans-serif;color:#cbe3dc}
`;
    shell = el('section', 'shell');
    shell.setAttribute('aria-label', 'Arena 模型运行信息');
    const header = el('header', 'header drag-handle');
    dot = el('span', 'dot');
    const title = el('strong', '', 'Arena · Trace Inspector'),
      toggle = el('button', 'collapse-button', '收起');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'true');
    toggle.addEventListener('click', () => setCollapsed(true));
    header.append(dot, title);
    hiddenUiButton = el('button', 'header-button hidden-ui-button', '展示隐藏UI');
    hiddenUiButton.type = 'button';
    hiddenUiButton.setAttribute('aria-label', '展示或还原 Agent 隐藏 UI');
    hiddenUiButton.addEventListener('click', toggleHiddenAgentUi);
    hiddenUiOn = readHiddenUiOn();
    updateHiddenUiButton();
    header.append(hiddenUiButton);
    // 2.3.0: capture the rendered transcript for this session on demand.
    if (globalThis.ArenaTranscript) {
      transcriptButton = el('button', 'header-button transcript-button', '保存本会话');
      transcriptButton.type = 'button';
      transcriptButton.setAttribute('aria-label', '把当前会话的对话正文保存到本地记录');
      transcriptButton.title = '读取当前页面已渲染的对话正文并保存到本地记录（不发送消息）';
      transcriptButton.addEventListener('click', () => void captureTranscriptNow());
    }
    if (globalThis.ArenaAutoDraw) {
      drawMenuButton = el('button', 'draw-menu-button', '自动抽卡');
      drawMenuButton.type = 'button';
      drawMenuButton.setAttribute('aria-haspopup', 'true');
      drawMenuButton.setAttribute('aria-expanded', 'false');
      drawMenuButton.setAttribute('aria-controls', 'ati-draw-menu');
      drawMenuButton.addEventListener('click', () => setDrawMenu(!drawMenuOpen));
      drawMenu = el('div', 'draw-menu');
      drawMenu.id = 'ati-draw-menu';
      drawMenu.hidden = true;
      drawMenu.setAttribute('role', 'group');
      drawMenu.setAttribute('aria-label', '自动抽卡');
      const menuHead = el('div', 'draw-menu-head');
      menuHead.append(el('strong', '', '自动抽卡'), el('span', 'draw-menu-hint', '按轮数新建聊天并记录模型'));
      const drawControls = el('div', 'draw-controls');
      const roundsLabel = el('label', 'draw-rounds-label', '轮数');
      roundsLabel.htmlFor = 'ati-draw-rounds';
      drawRounds = el('input', 'draw-rounds');
      drawRounds.id = 'ati-draw-rounds';
      drawRounds.type = 'number';
      drawRounds.min = '1';
      drawRounds.max = '100';
      drawRounds.step = '1';
      drawRounds.value = String(drawRoundValue);
      drawRounds.setAttribute('aria-label', '自动抽卡轮数');
      drawRounds.title = '自动抽卡轮数（1–100）';
      drawRounds.addEventListener('input', () => {
        drawRoundValue = drawRounds.value;
        updateDraw();
      });
      drawStart = el('button', 'draw-start', '开始抽卡');
      drawStop = el('button', 'draw-stop', '停止');
      drawStart.type = drawStop.type = 'button';
      drawStart.addEventListener('click', () => {
        if (!drawStart.disabled && latestState?.enabled && !archivePending) void ArenaAutoDraw.start(Number(drawRounds.value));
      });
      drawStop.addEventListener('click', () => ArenaAutoDraw.stop());
      drawStatus = el('p', 'draw-status');
      drawStatus.setAttribute('role', 'status');
      drawControls.append(roundsLabel, drawRounds, drawStart, drawStop);
      // 2.0.0 settings: the message text sent each round. Filtering lives entirely in the task-centre rules.
      const settings = el('div', 'draw-settings');
      const promptLabel = el('label', 'draw-prompt-label', '发送内容');
      promptLabel.htmlFor = 'ati-draw-prompt';
      drawPrompt = el('input', 'draw-prompt');
      drawPrompt.id = 'ati-draw-prompt';
      drawPrompt.type = 'text';
      drawPrompt.maxLength = 200;
      drawPrompt.spellcheck = false;
      drawPrompt.autocomplete = 'off';
      drawPrompt.placeholder = '1+1=';
      drawPrompt.setAttribute('aria-label', '每轮自动发送的消息内容');
      drawPrompt.title = '每轮新建聊天后发送的这一条消息；单行，最多 200 字，留空则用 1+1=';
      drawPrompt.addEventListener('change', () => void saveDrawPrefs({prompt: drawPrompt.value}));
      drawPrompt.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
          event.preventDefault();
          drawPrompt.blur();
        }
        event.stopPropagation();
      });
      const promptRow = el('div', 'draw-prompt-row');
      promptRow.append(promptLabel, drawPrompt);
      drawRules = el('button', 'draw-rules');
      drawRules.type = 'button';
      drawRules.title = '保留规则在抽卡设置中配置；点击打开抽卡设置';
      drawRules.addEventListener('click', () => {
        void chrome.runtime.sendMessage({type: 'ATI_DRAW_MANAGER_OPEN', view: 'settings', pageUrl: location.href});
      });
      settings.append(promptRow, drawRules);
      const tasksButton = el('button', 'draw-tasks', '自动抽卡历史 · 诊断');
      tasksButton.type = 'button';
      tasksButton.addEventListener('click', () => {
        void chrome.runtime.sendMessage({type: 'ATI_DRAW_MANAGER_OPEN', view: 'history', pageUrl: location.href});
      });
      const selfCheck = el('button', 'draw-self-check', '启动自检');
      selfCheck.type = 'button';
      selfCheck.addEventListener('click', async () => {
        if (drawing()) return;
        selfCheck.disabled = true;
        try {
          const result = await globalThis.ArenaDrawTasks?.preflight();
          listenError = result?.ready
            ? '启动自检通过 · 页面脚本 ' + result.scriptVersion
            : result?.checks
                .filter(c => c.state !== 'pass')
                .map(c => c.message)
                .join('；') || '页面脚本不完整，请刷新';
        } catch {
          listenError = '页面自检不可用，请手动刷新 Arena 页面';
        } finally {
          selfCheck.disabled = false;
          showSaveStatus();
        }
      });
      drawMenu.append(menuHead, settings, drawControls, drawStatus, selfCheck, tasksButton);
      drawMenu.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          setDrawMenu(false);
          drawMenuButton.focus({preventScroll: true});
        }
      });
      header.append(drawMenu);
    }
    header.append(toggle);
    addDrag(header);
    header.removeAttribute('title');
    header.setAttribute('aria-label', '浮层标题栏');
    compact = el('section', 'compact');
    compact.setAttribute('aria-label', '精简模型信息');
    const compactHead = el('div', 'compact-head drag-handle');
    compactDot = el('span', 'dot compact-dot');
    const compactTitle = el('div', 'compact-title', 'ARENA · TRACE INSPECTOR');
    compactName = el('div', 'compact-name drag-handle');
    addDrag(compactName);
    expandButton = el('button', 'expand-button', '↗');
    expandButton.type = 'button';
    expandButton.title = '展开详细面板';
    expandButton.setAttribute('aria-label', '展开详细面板');
    expandButton.setAttribute('aria-expanded', 'false');
    expandButton.addEventListener('click', () => setCollapsed(false));
    compactHead.append(compactDot, compactTitle, expandButton);
    addDrag(compactHead);
    const grid = el('dl', 'compact-grid');
    const field = (label, name) => {
      const wrap = el('div', 'compact-field');
      const v = el('dd', name);
      wrap.append(el('dt', '', label), v);
      grid.append(wrap);
      return v;
    };
    compactToken = field('Token', 'compact-token');
    compactCost = field('trace 费用', 'compact-cost');
    compactCount = field('次数', 'compact-count');
    compactStatus = field('状态', 'compact-state');
    compact.append(compactHead, compactName, grid);
    content = el('div', 'content');
    status = el('p', 'status');
    status.setAttribute('role', 'status');
    status.hidden = true;
    const controls = el('div', 'listen-controls');
    const leftActions = el('div', 'left-actions');
    listenButton = el('button', 'listen-button', '读取状态…');
    listenButton.type = 'button';
    listenButton.disabled = true;
    listenButton.addEventListener('click', () => void changeListening());
    leftActions.append(listenButton);
    if (transcriptButton) leftActions.append(transcriptButton);
    if (drawMenuButton) leftActions.append(drawMenuButton);
    quotaHost = el('div', 'quota-slot');
    controls.append(leftActions, quotaHost);
    content.append(controls, status);
    if (globalThis.ArenaAutoDraw) updateDraw();
    panel = ArenaTracePanel.create(content, {
      quotaHost,
      onRecover: recoverCurrent,
      onArchive: archiveCurrentChat,
      onRerun: rerunCurrentDetail,
      onAutoRenameChange: setAutoRename,
      onRename: (model, view) => {
        if (archivePending || drawing()) throw Error('自动流程正在进行，请稍候');
        const isCurrent = () => {
          const current = ArenaTraceView.build(latestState);
          return (
            view.sessionId === currentSession() &&
            latestState?.sessionId === view.sessionId &&
            latestState?.runId === view.runId &&
            (view.automatic ? autoRename && current.renameReady && current.renameTitle === model : current.renameTitle === model || current.models.some(m => m.model === model))
          );
        };
        if (!isCurrent()) throw Error('当前对话或模型已变化，请重试');
        return ArenaConversationRename.rename({sessionId: view.sessionId, model, isCurrent, expectedTitle: view.automatic ? view.expectedTitle : null});
      }
    });
    shell.append(header, compact, content);
    root.append(style, shell);
    document.documentElement.append(host);
    applyMode();
    if (drawMenu) {
      root.addEventListener('pointerdown', event => {
        if (!drawMenuOpen) return;
        const path = event.composedPath?.() || [];
        if (!path.includes(drawMenu) && !path.includes(drawMenuButton)) setDrawMenu(false);
      });
      document.addEventListener(
        'pointerdown',
        event => {
          if (drawMenuOpen && event.target !== host) setDrawMenu(false);
        },
        true
      );
    }
    if (typeof ResizeObserver === 'function') {
      sizeObserver = new ResizeObserver(() => {
        if (!drag && host?.isConnected) keepVisible();
      });
      sizeObserver.observe(shell);
    }
  }
  const agentPage = () => /^\/agent(?:\/|$)/.test(location.pathname);
  function render(state) {
    if (!agentPage()) {
      host?.remove();
      host = null;
      latestState = null;
      return;
    }
    if (!state || state.restoring) return;
    if (state.sessionId && state.sessionId !== currentSession()) return;
    latestState = state;
    prefs ??= ArenaHudLayout.defaults();
    const created = !host?.isConnected;
    if (created) createHost();
    if (!state.initializing) lastListening = !!state.enabled;
    displayedSession = state.sessionId || null;
    for (const indicator of [dot, compactDot]) {
      indicator.style.background = state.enabled ? '#92e4b9' : '#d5bd83';
      indicator.title = state.initializing
        ? '正在核对监听状态'
        : state.listenState === 'reconnecting'
          ? '正在恢复监听连接'
          : state.enabled
            ? '监听中'
            : state.historical
              ? '本地历史 · 未开启监听'
              : '未开启监听';
      indicator.setAttribute('role', 'img');
      indicator.setAttribute('aria-label', indicator.title);
    }
    const view = ArenaTraceView.build(state);
    accountQuota = newerQuota(accountQuota, state.accountQuota);
    rateLimits = mergeRl(rateLimits, state.rateLimits);
    if (rateLimits && state.rateLimits !== rateLimits) latestState = {...state, rateLimits};
    const fullView = {
      ...view,
      ...(accountQuota ? {accountQuota} : {}),
      ...(rateLimits ? {rateLimits} : {}),
      sessionId: state.sessionId,
      recoveryPending: recoveryPending || drawing() || archivePending,
      statusText: typeof state.status === 'string' ? state.status : '',
      autoRename,
      autoRenamePending: autoPending || archivePending || drawing(),
      actionPending: archivePending || drawing() || rerunPending,
      rerun: state.rerun || null,
      rerunPending,
      archivePending: archivePending || drawing()
    };
    panel.render(fullView);
    globalThis.ArenaDrawTasks?.observe(state, true);
    void maybeAutoRename(fullView);
    compactName.textContent = view.switch?.state === 'switched' && view.renameTitle ? view.renameTitle : view.models.length ? [...new Set(view.models.map(m => m.model))].join(' / ') : '模型待确认';
    compactName.title = view.switch?.state === 'switched' ? '模型已切换：' + (view.switch.from || '') + ' → ' + (view.switch.to || '') : compactName.textContent;
    compactName.classList.toggle('switched', view.switch?.state === 'switched');
    compactToken.textContent = view.tokens + (view.tokenMissing ? ' · 部分' : '');
    compactToken.title = view.tokenMissing ? '已捕获调用覆盖 ' + view.tokenCoverage : '仅已捕获 Token，缩写标为约数';
    compactCost.textContent = view.cost + (view.costMissing ? ' · 部分' : '');
    compactCost.title = 'trace 展示费用，不代表实际账单';
    compactCount.textContent = view.count;
    compactStatus.textContent =
      (view.switch?.state === 'switched' ? '已切换 · ' : view.switch?.state === 'suspected' ? '疑似路由 · ' : '') +
      (view.historical && view.runId ? '历史 · ' : '') +
      (view.runId ? view.completion.replace(/^调用/, '') : state.enabled ? '监听中 · 等待数据' : '未开启监听');
    if (globalThis.ArenaAutoDraw) updateDraw();
    updateListenControl();
    showSaveStatus();
    if (created) placeSaved();
    else if (!drag) keepVisible();
    loadPrefs();
    void loadAutoRename();
    paintPulse();
    if (created) void loadPulse();
    else if (!view.historical && view.runId && view.completion === '调用已完成' && !state.detailPending && pulseRunKey !== view.runId) {
      pulseRunKey = view.runId;
      void loadPulse(true);
    }
    observeLazyTranscript();
  }
  window.addEventListener('resize', () => {
    if (host?.isConnected && !drag) placeSaved();
  });
  chrome.runtime.onMessage.addListener(msg => {
    if (msg.type === 'ATI_STATE') render(msg.state);
    // 2.3.0 auto-capture: only honoured for the session currently displayed.
    else if (msg.type === 'ATI_TRANSCRIPT_REQUEST' && msg.sessionId && msg.sessionId === currentSession()) void captureTranscriptNow(true);
  });
  function refresh() {
    if (!agentPage()) {
      requestVersion++;
      clearTimeout(retryTimer);
      clearTimeout(lazySaveTimer);
      host?.remove();
      host = null;
      latestState = null;
      return;
    }
    if (pageKey !== location.pathname) {
      pageKey = location.pathname;
      listenError = '';
      clearTimeout(lazySaveTimer);
      if (prefs) prefs.collapsed = false;
      host?.remove();
      host = null;
      latestState = null;
    }
    if (displayedSession !== currentSession()) {
      host?.remove();
      host = null;
    }
    if (!host) render({enabled: lastListening, sessionId: currentSession(), models: [], initializing: true, status: '正在读取监听状态…'});
    const version = ++requestVersion;
    clearTimeout(retryTimer);
    const delays = [250, 750, 1500, 3000];
    function request(attempt) {
      if (version !== requestVersion) return;
      const retry = () => {
        if (version !== requestVersion) return;
        if (attempt < delays.length) retryTimer = setTimeout(() => request(attempt + 1), delays[attempt]);
        else render({...latestState, sessionId: currentSession(), initializing: false, connectionError: true, status: '扩展连接暂时不可用，点击“重试连接”或重新加载扩展后刷新页面。'});
      };
      // Extension startup and overlapping navigation may briefly have no receiver.
      // Retry only a local state read; never send an Agent message or start capture.
      chrome.runtime
        .sendMessage({type: 'ATI_STATUS', pageUrl: location.href})
        .then(state => {
          if (version !== requestVersion) return;
          if (!state || state.restoring || (state.sessionId && state.sessionId !== currentSession())) retry();
          else render(state);
        })
        .catch(retry);
    }
    request(0);
  }
  window.addEventListener('pageshow', refresh);
  window.navigation?.addEventListener('navigatesuccess', refresh);
  window.addEventListener('popstate', () => {
    host?.remove();
    host = null;
    refresh();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh();
  });
  // Arena can replace root-level DOM during hydration. Recreate only this view,
  // never a previous conversation's overlay, and never fetch or attach here.
  new MutationObserver(() => {
    if (host && !host.isConnected && latestState && latestState.sessionId === currentSession()) render(latestState);
    observeLazyTranscript();
  }).observe(document, {childList: true, subtree: true});
  refresh();
})();
