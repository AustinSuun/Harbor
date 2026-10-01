/* Bounded, opt-in UI automation. Requires active listening; no send retries. */
(() => {
  let running = false,
    cancelled = false,
    progress = '请先开启监听，再设置轮数并开始抽卡',
    phase = 'idle',
    sent = false,
    sessionId = null;
  let total = 5,
    round = 0,
    completed = 0,
    failed = 0,
    archived = 0,
    cleanupPending = 0;
  let policy = null,
    taskId = null,
    startedAt = 0,
    hits = 0,
    stopReason = null;
  const uniqueTargets = new Set();
  const task = () => globalThis.ArenaDrawTasks;
  async function recorded(method, ...args) {
    try {
      return await task()?.[method](...args);
    } catch (e) {
      if (e?.code === 'preflight') {
        stopReason = 'preflight-failed';
        throw fatal(e.message);
      }
      stopReason = 'storage-failed';
      throw fatal('任务记录保存失败，已停止；未自动重试操作');
    }
  }
  const failReason = () =>
    stopReason ||
    (cancelled
      ? 'user-stop'
      : userStoppedListening || readState()?.enabled === false
        ? 'capture-stopped'
        : sent && !sessionId
          ? 'unconfirmed-send'
          : readState()?.namingUnavailable
            ? 'naming-unavailable'
            : 'operation-failed');
  function createChatLimitReached() {
    const cc = readState()?.rateLimits?.createChat;
    if (!cc || typeof cc.remaining !== 'number' || cc.remaining > 0) return null;
    const now = Date.now();
    const resetMs = cc.resetAt ? Date.parse(cc.resetAt) : NaN;
    if (Number.isFinite(resetMs) && now >= resetMs) return null;
    const remainSec = Number.isFinite(resetMs) ? Math.max(1, Math.ceil((resetMs - now) / 1000)) : null;
    const waitHint = remainSec === null ? '稍后' : remainSec >= 60 ? Math.floor(remainSec / 60) + 'm ' + (remainSec % 60) + 's 后' : remainSec + 's 后';
    return {limit: cc.limit || 30, waitHint};
  }
  function stopMessage(reason) {
    if (reason === 'create-chat-limit') {
      const cc = createChatLimitReached();
      return `新建会话限流额度已用尽（0/${cc?.limit || 30}${cc?.waitHint ? '，预计 ' + cc.waitHint + '重置' : ''}，或切换代理 IP 后继续）；不再发送`;
    }
    return (globalThis.ArenaDrawPolicy?.reasonText?.[reason] || '已达到停止条件') + '；不再发送';
  }
  async function stopCheck(checkPulse = false) {
    if ((checkPulse || round < total) && createChatLimitReached()) return 'create-chat-limit';
    let pulse = null;
    if (checkPulse && policy?.stop.minPulse !== null) {
      try {
        const r = await chrome.runtime.sendMessage({type: 'ATI_PULSE', force: true, pageUrl: location.href});
        if (!r?.error) pulse = r?.pulse?.pulse ?? null;
      } catch {}
    }
    return globalThis.ArenaDrawPolicy?.stopReason(policy, {hits, unique: uniqueTargets.size, elapsedMs: Date.now() - startedAt, pulse, checkPulse}) || null;
  }
  function countTargets(decision) {
    if (decision?.action === 'keep' && decision.known) {
      hits++;
      for (const label of decision.targets || []) uniqueTargets.add(label);
    }
  }
  let notify = () => {},
    readState = () => null;
  let userStoppedListening = false,
    archivePausedListening = false;
  // Explicit user stop is distinct from the temporary pause made by archive preparation.
  chrome.runtime.onMessage?.addListener(message => {
    if (message?.type === 'ATI_LISTENING_USER_STOP' && running) userStoppedListening = true;
  });
  // 2.0.0: the message text comes from ArenaDrawPrefs and is frozen for the whole job.
  let prompt = '1+1=';
  const prefsApi = () => globalThis.ArenaDrawPrefs || null;
  const visible = e => !!e?.isConnected && e.getClientRects().length > 0;
  // Arena's compact selector now says "Agent"; its menu still says "Agent Mode".
  const modeText = e => (e?.textContent || '').replace(/\s+/g, ' ').trim();
  const agentLabel = e => /^Agent(?: Mode)?$/.test(modeText(e));
  const agentOption = e => /^Agent(?: Mode)?(?:\s*Built for complex tasks)?$/.test(modeText(e));
  const modeButton = () => [...document.querySelectorAll('button[role="combobox"]')].find(visible);
  function agentSelected() {
    const combo = modeButton();
    if (!combo || !agentLabel(combo)) return false;
    // If the dropdown exposes a selected option, it must agree with the trigger.
    if (combo.getAttribute?.('aria-expanded') === 'true') {
      const selected = [...document.querySelectorAll('[role="option"]')].filter(e => visible(e) && e.getAttribute?.('aria-selected') === 'true');
      if (selected.length && !selected.every(agentOption)) return false;
    }
    return true;
  }
  const session = () => location.pathname.match(/^\/agent\/([a-zA-Z0-9-]{1,128})\/?$/)?.[1] || null;
  const status = () => ({
    running,
    phase,
    progress,
    sent,
    sessionId,
    total,
    round,
    completed,
    failed,
    archived,
    cleanupPending,
    prompt,
    taskId,
    hits,
    uniqueTargets: uniqueTargets.size,
    stopReason
  });
  const publish = (p, text) => {
    phase = p;
    progress = text;
    notify(status());
  };
  // fatal: the job must stop (user draft, listening lost, navigation, cancel, unconfirmed send). Everything else is a
  // transient failure of one round: it is recorded and the next round proceeds, bounded by the round count and 3 consecutive failures.
  const fatal = m => Object.assign(Error(m), {fatal: true});
  const generating = () => visible(document.querySelector('button[aria-label="Stop generating"]'));
  function guard() {
    if (policy?.stop.maxMinutes && Date.now() - startedAt >= policy.stop.maxMinutes * 60000) {
      stopReason = 'time-limit';
      throw fatal('已达到最长运行时间；不再执行后续步骤');
    }
    if (cancelled) throw fatal('已停止自动抽卡；已发送的消息不会撤回');
    if (location.origin !== 'https://arena.ai') throw fatal('已离开 Arena，自动抽卡已停止');
    if (userStoppedListening || (!archivePausedListening && readState()?.enabled === false && !readState()?.initializing)) throw fatal('监听已停止，自动抽卡终止');
  }
  async function wait(check, message, ms = 15000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      guard();
      const result = await check();
      if (result) return result;
      await new Promise(r => setTimeout(r, 250));
    }
    throw Error(message);
  }
  const editors = () => [...document.querySelectorAll('[contenteditable="true"]')].filter(visible);
  const editorText = e => (e?.innerText ?? e?.textContent ?? '').trim();
  function noDraft(allowPrompt = false) {
    if (editors().some(e => editorText(e) && !(allowPrompt && editorText(e) === prompt))) throw fatal('输入框有未发送内容，已停止；不会覆盖草稿');
  }
  async function newChat(allowPrompt = false) {
    guard();
    noDraft(allowPrompt && !session());
    // Arena can reload the document when New Chat is clicked on an already blank route.
    // Reuse that blank editor instead of destroying this opt-in task's content context.
    if (location.pathname.replace(/\/$/, '') === '/agent') {
      await wait(() => editors().length === 1, '等待新聊天输入框超时');
      noDraft(allowPrompt);
      return;
    }
    const links = [...document.querySelectorAll('a[href]')].filter(a => {
      try {
        return new URL(a.href).origin === 'https://arena.ai' && new URL(a.href).pathname === '/agent' && ['New Chat', '新建聊天', '新对话'].includes(a.textContent.trim());
      } catch {
        return false;
      }
    });
    if (!links.length) throw Error('未找到 New Chat 入口，已停止');
    links[0].click();
    await wait(() => location.pathname.replace(/\/$/, '') === '/agent', '新建聊天超时');
    await wait(() => editors().length === 1, '等待新聊天输入框超时');
    noDraft(allowPrompt);
  }
  async function mode() {
    const combo = await wait(modeButton, '未找到模式选择器');
    if (!agentSelected()) {
      if (combo.getAttribute?.('aria-expanded') !== 'true') combo.click();
      const option = await wait(() => [...document.querySelectorAll('[role="option"]')].find(e => visible(e) && agentOption(e) && !e.hasAttribute('data-disabled')), '未找到 Agent Mode 选项');
      option.click();
    }
    await wait(agentSelected, '未能确认 Agent Mode');
  }
  async function nextBlank() {
    await newChat(true);
    await mode();
    guard();
    const editor = editors()[0];
    // Arena may restore the just-submitted prompt as its new-chat draft.
    // Clear only this exact owned prompt, never another user draft.
    if (editorText(editor) === prompt) {
      editor.focus();
      const selection = window.getSelection(),
        range = document.createRange();
      range.selectNodeContents(editor);
      selection.removeAllRanges();
      selection.addRange(range);
      if (!document.execCommand('delete', false)) throw Error('已进入新聊天，但残留提示未能清理；未再次发送');
      await wait(() => !editorText(editors()[0]), '新聊天草稿未能清空；未再次发送');
    }
    noDraft();
  }
  // Archive the just-drawn chat through Arena's own UI (same ticket chain as the HUD button): background invalidates the
  // capture and issues a ticket, the page performs the archive, background deletes the local record only after confirmation.
  async function archiveChat(isCurrent) {
    const prep = await chrome.runtime.sendMessage({type: 'ATI_ARCHIVE_PREPARE', sessionId, pageUrl: location.href});
    if (!prep?.ticket) throw Error(prep?.error || '归档准备失败');
    archivePausedListening = true;
    const result = await ArenaConversationRename.archive({sessionId, isCurrent});
    if (!result?.archived) throw Error('未确认归档，本地记录保留');
    await recorded('emit', 'archive-confirmed', {cleanupFingerprint: prep.cleanupFingerprint});
    let removed;
    try {
      removed = await chrome.runtime.sendMessage({type: 'ATI_ARCHIVE_FINISH', ticket: prep.ticket, archived: true});
    } catch {
      removed = null;
    }
    if (!removed?.ok) {
      await recorded('emit', 'cleanup-failed', {reason: 'cleanup-failed'});
      cleanupPending++;
      return {archived: true, cleanup: false};
    }
    await recorded('emit', 'cleanup-confirmed');
    return {archived: true, cleanup: true};
  }
  async function listen(enabled) {
    const r = await chrome.runtime.sendMessage({type: 'ATI_SET_LISTENING', enabled, pageUrl: location.href});
    if (r?.error || !!r?.enabled !== enabled) throw Error(r?.error || '监听状态切换失败');
    return r;
  }
  async function requireListening() {
    const state = await chrome.runtime.sendMessage({type: 'ATI_STATUS', pageUrl: location.href});
    if (state?.enabled !== true || state.restoring || state.error) throw fatal('请先开启监听；未发送消息');
    return state;
  }
  async function start(rounds = 5) {
    if (running) return status();
    const count = Number(rounds);
    if (!Number.isInteger(count) || count < 1 || count > 100) {
      publish('blocked', '轮数必须是 1–100 的整数');
      return status();
    }
    if (readState()?.enabled !== true) {
      publish('blocked', '请先开启监听，再开始自动抽卡');
      return status();
    }
    running = true;
    cancelled = false;
    userStoppedListening = false;
    archivePausedListening = false;
    sent = false;
    sessionId = null;
    total = count;
    round = 0;
    completed = 0;
    failed = 0;
    archived = 0;
    cleanupPending = 0;
    let consecutiveFailures = 0,
      halted = false;
    policy = null;
    taskId = null;
    hits = 0;
    uniqueTargets.clear();
    stopReason = null;
    startedAt = Date.now();
    publish('checking', '正在确认当前页监听状态…');
    try {
      // Preferences are read once per job. The text is normalized (one line, <=200 chars, non-empty) before anything is typed.
      const p = prefsApi();
      let saved = null;
      try {
        const r = await chrome.runtime.sendMessage({type: 'ATI_DRAW_PREFS_GET', pageUrl: location.href});
        saved = r?.prefs || null;
      } catch {
        saved = null;
      }
      const prefs = p ? p.sanitize(saved) : {prompt: '1+1='};
      prompt = prefs.prompt;
      await requireListening();
      guard();
      if (!task()) throw fatal('任务记录模块未加载，请刷新页面；未发送消息');
      const created = await recorded('begin', total);
      taskId = created.taskId;
      policy = created.policy;
      for (round = 1; round <= total; round++) {
        sent = false;
        sessionId = null;
        const stop = await stopCheck(true);
        if (stop) {
          stopReason = stop;
          halted = true;
          publish('stopped', stopMessage(stop));
          break;
        }
        await recorded('startRound', round);
        publish('new-chat', `${round}/${total} · 正在新建聊天`);
        let failureStep = 'navigation';
        try {
          if (ArenaConversationRename.isBusy()) throw Error('聊天操作正在进行，请稍后重试');
          noDraft(!session());
          if (generating()) {
            publish('waiting', `${round}/${total} · 上一条回复仍在生成，等待结束后再新建聊天（最多 240 秒）`);
            await wait(() => !generating(), '上一条回复超过 240 秒仍在生成，本轮跳过', 240000);
          }
          await newChat(true);
          publish('mode', `${round}/${total} · 正在确认 Agent Mode`);
          await mode();
          guard();
          if (location.pathname.replace(/\/$/, '') !== '/agent') throw Error('页面已变化，未发送');
          publish('listen', `${round}/${total} · 确认监听`);
          guard();
          await requireListening();
          guard();
          if (session()) throw Error('新聊天状态已变化，未发送');
          noDraft(true);
          const editor = editors()[0];
          if (!editor) throw Error('输入框不可用');
          if (editorText(editor) !== prompt) {
            editor.focus();
            const selection = window.getSelection(),
              range = document.createRange();
            range.selectNodeContents(editor);
            selection.removeAllRanges();
            selection.addRange(range);
            if (!document.execCommand('insertText', false, prompt)) throw Error('输入消息失败；未发送');
          }
          const button = await wait(() => [...document.querySelectorAll('button[aria-label="Send message"]')].find(b => visible(b) && !b.disabled), '发送按钮不可用；未发送');
          guard();
          if (editorText(editor) !== prompt || session()) throw Error('输入或页面已变化；未发送');
          if (!agentSelected()) throw Error('模式已变化；未发送');
          await requireListening();
          guard();
          if (session()) throw Error('页面已变化，未发送');
          failureStep = 'send';
          await recorded('emit', 'send-intent');
          guard();
          if (session() || editorText(editor) !== prompt || !agentSelected()) throw fatal('发送前页面已变化；未发送');
          sent = true;
          publish('detect', `${round}/${total} · 已发送「${prompt.length > 20 ? prompt.slice(0, 20) + '…' : prompt}」，等待完成检测（最多 180 秒）`);
          button.click();
          try {
            sessionId = await wait(() => session(), '发送后未确认新会话；不重发', 30000);
          } catch (e) {
            throw e?.fatal ? e : fatal(e?.message || '发送后未确认新会话；不重发');
          }
          await recorded('confirmed', sessionId);
          failureStep = 'recognition';
          const detectStart = Date.now();
          const detectCheck = () => {
            if (session() !== sessionId) throw fatal('已切换到其他聊天，停止抽卡');
            if (readState()?.enabled === false && !readState()?.initializing) throw fatal('监听已停止，自动抽卡终止');
            const state = readState();
            if (state?.sessionId !== sessionId || state.historical || !state.saved) return null;
            const view = ArenaTraceView.build(state);
            if (state.namingUnavailable === true) throw Error('内部模型名未就绪，补读已结束；保留聊天，不使用临时标签');
            if (!view.models.length || view.completion !== '调用已完成') return null;
            if (!view.renameReady) {
              if (phase !== 'detail') publish('detail', `${round}/${total} · 已取得模型标签，等待 Arena 内部名与当前运行详情就绪`);
              return null;
            }
            return {state, view};
          };
          let detected = null;
          // 180 s base; while Arena still shows "Stop generating" keep waiting (long reasoning runs), hard cap 600 s.
          while (!detected) {
            try {
              detected = await wait(detectCheck, 'detect-timeout', 180000);
            } catch (e) {
              if (e?.message !== 'detect-timeout') throw e;
              const elapsed = Math.round((Date.now() - detectStart) / 1000);
              if (!generating() || elapsed >= 600) throw Error(`检测超时（${elapsed} 秒），不重发`);
              publish('detect', `${round}/${total} · 回复仍在生成，继续等待（已 ${elapsed} 秒，上限 600 秒）`);
            }
          }
          guard();
          await recorded('ready', detected.state, detected.view);
          const decision = globalThis.ArenaDrawPolicy ? globalThis.ArenaDrawPolicy.decide(detected.view, policy) : {action: 'keep', reason: 'no-filter', known: false};
          await recorded('emit', 'rule-evaluated', {decision: decision.action, reason: decision.reason, mapping: decision.mapping, ruleMatches: decision.ruleMatches});
          countTargets(decision);
          const model = detected.view.renameTitle || detected.view.models[0].model;
          const modelKey = view => JSON.stringify(view.models.map(m => [m.model, m.internal === true]));
          const detectedModels = modelKey(detected.view);
          const isCurrent = () => {
            const state = readState();
            if (cancelled || userStoppedListening || session() !== sessionId || state?.sessionId !== sessionId || state?.runId !== detected.state.runId) return false;
            const view = ArenaTraceView.build(state);
            return view.renameReady === true && (view.renameTitle || view.models[0]?.model) === model && modelKey(view) === detectedModels;
          };
          if (!isCurrent()) throw Error('运行详情或模型已变化，未修改聊天');
          if (decision.action === 'archive') {
            // Filtering and naming use the same verified snapshot. Never fall back
            // to an earlier server label after a detail timeout.
            guard();
            const keep = false;
            if (!keep) {
              const label = detected.view.models[0].model;
              publish('archive', `${round}/${total} · ${label} 不在保留列表，正在归档聊天`);
              try {
                guard();
                await requireListening();
                if (!isCurrent()) throw Error('模型已变化，未归档聊天');
                failureStep = 'archive';
                await recorded('emit', 'archive-start');
                guard();
                if (!isCurrent()) throw Error('模型已变化，未归档聊天');
                await archiveChat(() => !cancelled && !userStoppedListening && session() === sessionId);
                archived++;
              } finally {
                // ATI_ARCHIVE_PREPARE stops this tab's capture. Turn listening back on whether or not the archive succeeded,
                // so a failed archive is a skippable round (the chat is simply kept) and the next round can proceed.
                if (archivePausedListening && !userStoppedListening && location.origin === 'https://arena.ai' && (!session() || session() === sessionId)) {
                  try {
                    await listen(true);
                  } catch {}
                }
                archivePausedListening = false;
              }
              await recorded('emit', 'round-finished', {outcome: 'archived', reason: decision.reason});
              const reachedAfterArchive = await stopCheck(false);
              if (reachedAfterArchive) {
                stopReason = reachedAfterArchive;
                halted = true;
                completed++;
                publish('stopped', stopMessage(reachedAfterArchive));
                break;
              }
              guard();
              publish('next', `${round}/${total} · 已归档 ${label}，正在进入新的空白聊天`);
              failureStep = 'navigation';
              await recorded('emit', 'next-chat');
              await nextBlank();
              completed++;
              consecutiveFailures = 0;
              guard();
              continue;
            }
          }
          publish('rename', `${round}/${total} · 检测完成，正在重命名`);
          guard();
          if (!isCurrent()) throw Error('运行详情或模型已变化，未重命名');
          failureStep = 'rename';
          await recorded('renameStart', model);
          guard();
          if (!isCurrent()) throw Error('运行详情已变化，未重命名');
          try {
            await ArenaConversationRename.rename({sessionId, model, isCurrent, onStage: type => recorded('emit', type)});
          } catch (e) {
            e.drawFailure = {renameState: e?.submitted === false ? 'safe-failed' : 'uncertain', outcome: decision.action === 'review' ? 'review' : 'failed'};
            throw e;
          }
          await recorded('emit', 'rename-confirmed', {confirmedTitle: model});
          await recorded('emit', 'round-finished', {outcome: decision.action === 'review' ? 'review' : 'kept', reason: decision.reason});
          const reached = await stopCheck(false);
          if (reached) {
            stopReason = reached;
            halted = true;
            completed++;
            publish('stopped', stopMessage(reached));
            break;
          }
          guard();
          publish('next', `${round}/${total} · 已重命名，正在进入新的空白聊天`);
          failureStep = 'navigation';
          await recorded('emit', 'next-chat');
          await nextBlank();
          completed++;
          consecutiveFailures = 0;
        } catch (e) {
          if (cancelled) throw e;
          failed++;
          consecutiveFailures++;
          await recorded('emit', 'round-failed', {reason: failReason(), failureStep, ...(e?.drawFailure || {}), ...(readState()?.namingUnavailable ? {outcome: 'review'} : {})});
          const message = e?.message || '本轮失败';
          // Skippable: nothing was sent this round (retrying is safe), or the send is confirmed on this very chat and only
          // detection/rename failed. Never continue after a fatal condition (draft, listening lost, navigation, unconfirmed send).
          const listening = readState()?.enabled === true;
          const canSkip = !e?.fatal && listening && (!sent || (sessionId && session() === sessionId));
          const failureLimit = policy?.stop.consecutiveFailures || 3;
          if (!canSkip || consecutiveFailures >= failureLimit) {
            halted = true;
            stopReason = consecutiveFailures >= failureLimit ? 'failure-limit' : failReason();
            publish('skipped', message + (consecutiveFailures >= failureLimit ? '；连续失败 ' + failureLimit + ' 次，已停止' : '；已停止抽卡'));
            break;
          }
          publish('skipped', `${round}/${total} · ${message}；${sent ? '保留聊天，' : ''}跳过本轮`);
        }
        guard();
      }
      round = Math.min(round, total);
      if (!halted)
        publish(
          'done',
          `抽卡结束：成功 ${completed} 轮${archived ? `（归档 ${archived} 个非保留模型）` : ''}，跳过 ${failed} 轮${cleanupPending ? '；本地清理待重试 ' + cleanupPending + ' 轮' : ''}；不再自动发送`
        );
    } catch (e) {
      halted = true;
      stopReason = failReason();
      publish(cancelled ? 'stopped' : 'skipped', e?.message || '自动抽卡已停止');
    } finally {
      // Drawing owns automatic sending, not the user's listening switch.
      // Never disable capture on completion/cancel, or revive a user's stopped capture.
      if (taskId) {
        try {
          await task().finish(stopReason === 'interrupted' ? 'interrupted' : halted || cancelled ? 'stopped' : 'completed', halted || cancelled ? failReason() : 'completed');
        } catch {
          publish('skipped', '任务记录保存失败；已停止，请核对本轮页面');
        }
      }
      running = false;
      notify(status());
    }
    return status();
  }
  window.addEventListener?.('pagehide', () => {
    if (running) {
      cancelled = true;
      stopReason = 'interrupted';
      publish('stopping', '页面已离开；返回后不自动续跑');
    }
  });
  function stop() {
    if (running) {
      cancelled = true;
      publish('stopping', '正在停止；不会再发送新消息');
    }
  }
  globalThis.ArenaAutoDraw = {
    start,
    stop,
    status,
    configure(options) {
      readState = options.readState;
      notify = options.onProgress || (() => {});
      notify(status());
    }
  };
})();
