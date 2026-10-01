/* Chat transcripts, stored SEPARATELY from model metadata (2.4.0).

   Key space:  ati.chat.v1.<accountId>.<sessionId>
   Metadata:   ati.conversation.v2.<accountId>.<sessionId>   (history.js)

   The two never share a record and are exported as two different files. A chat can
   exist for a session that has no model observations, and deleting one does not
   delete the other unless the caller asks for both.

   This is the personal-use build: message text is kept verbatim, no redaction. */
import {conversationUrl} from './history.js';
import {accountKeyPart} from './account.js';
import {sanitizeTranscript} from './transcript.js';

export const CHAT_PREFIX = 'ati.chat.v1.';
export const UNKNOWN_ACCOUNT = 'unknown';
export const CHAT_CAPTURE_VERSION = '2.8.4';

export const PLACEHOLDER_CHAT_TITLES = new Set(['Arena 会话', 'Agent Mode | Autonomous AI Agents for Real-World Tasks', 'Arena | Benchmark & Compare the Best AI Models']);

export function normalizeChatTitle(title) {
  if (typeof title !== 'string') return null;
  const trimmed = title.trim().slice(0, 300);
  return trimmed && !PLACEHOLDER_CHAT_TITLES.has(trimmed) ? trimmed : null;
}

export function chatKey(accountId, sessionId) {
  conversationUrl(sessionId);
  return CHAT_PREFIX + accountKeyPart(accountId || UNKNOWN_ACCOUNT) + '.' + sessionId;
}

const validChat = r => r && r.schemaVersion === 1 && r.kind === 'chat' && Array.isArray(r.messages);

const messageFp = m => (m?.role || '') + '\0' + String(m?.text || '').trim() + '\0' + String(m?.reasoning || '').trim();

function findSubsequence(haystack, needle) {
  if (!needle.length || needle.length > haystack.length) return -1;
  for (let i = 0; i <= haystack.length - needle.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

function longestSuffixPrefix(left, right) {
  const max = Math.min(left.length, right.length);
  for (let k = max; k >= 1; k--) {
    let ok = true;
    const offset = left.length - k;
    for (let j = 0; j < k; j++) {
      if (left[offset + j] !== right[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return k;
  }
  return 0;
}

/* 2.8.4: Align and stitch partial captures by longest message-fingerprint overlap,
   and allow a newer capture version to replace older bloated records. */
export function mergeTranscriptMessages(oldMessages, newMessages, {sameVersion = true} = {}) {
  const A = Array.isArray(oldMessages) ? oldMessages : [];
  const B = Array.isArray(newMessages) ? newMessages : [];
  if (!A.length) return {messages: B, gap: false};
  if (!B.length) return {messages: A, gap: false};
  const fa = A.map(messageFp);
  const fb = B.map(messageFp);

  if (!sameVersion) {
    if (fa[0] === fb[0]) return {messages: B, gap: false};
    const k = longestSuffixPrefix(fa, fb);
    if (k > 0 && A.length - k > 0) return {messages: A.slice(0, A.length - k).concat(B), gap: false};
    return {messages: B, gap: false};
  }

  if (findSubsequence(fb, fa) !== -1) return {messages: B, gap: false};
  const subInA = findSubsequence(fa, fb);
  if (subInA !== -1) {
    return {messages: A.slice(0, subInA).concat(B, A.slice(subInA + B.length)), gap: false};
  }

  const kAB = longestSuffixPrefix(fa, fb);
  const kBA = longestSuffixPrefix(fb, fa);
  if (kAB > 0 || kBA > 0) {
    if (kAB >= kBA) return {messages: A.slice(0, A.length - kAB).concat(B), gap: false};
    return {messages: B.concat(A.slice(kBA)), gap: false};
  }

  if (A.length >= 2 && B.length >= 2) {
    const kTrim = longestSuffixPrefix(fa.slice(0, -1), fb);
    if (kTrim > 0 && kTrim < B.length && A[A.length - 1].role === B[kTrim].role) {
      return {messages: A.slice(0, A.length - 1 - kTrim).concat(B), gap: false};
    }
  }

  return {messages: A.length > B.length ? A : B, gap: true};
}

export function createChatStore(area) {
  let queue = Promise.resolve();
  const enqueue = task => {
    const work = queue.then(task);
    queue = work.catch(() => {});
    return work;
  };

  return {
    save(sessionId, transcript, {account = null, title = null, capturedBy = CHAT_CAPTURE_VERSION} = {}) {
      return enqueue(async () => {
        const url = conversationUrl(sessionId);
        const clean = sanitizeTranscript(transcript);
        if (!clean) throw new Error('没有可保存的对话正文');
        const key = chatKey(account?.accountId, sessionId);
        const old = (await area.get(key))[key];
        const nextVersion = typeof capturedBy === 'string' && capturedBy.trim() ? capturedBy.trim() : CHAT_CAPTURE_VERSION;
        const hasOld = validChat(old);
        const sameVersion = hasOld && old.capturedBy === nextVersion;
        const merged = hasOld ? mergeTranscriptMessages(old.messages, clean.messages, {sameVersion}) : {messages: clean.messages, gap: false};
        const finalClean = sanitizeTranscript({capturedAt: clean.capturedAt, messages: merged.messages, truncated: clean.truncated}) || clean;
        const messages = finalClean.messages;
        const resolvedTitle = normalizeChatTitle(title) || (hasOld ? normalizeChatTitle(old.title) : null) || 'Arena 会话';
        const record = {
          schemaVersion: 1,
          kind: 'chat',
          sessionId,
          url,
          ...(account ? {account} : hasOld && old.account ? {account: old.account} : {}),
          title: resolvedTitle,
          capturedBy: nextVersion,
          firstCaptured: (hasOld && old.firstCaptured) || clean.capturedAt,
          lastCaptured: clean.capturedAt,
          messages,
          messageCount: messages.length,
          chars: messages.reduce((n, m) => n + (m.text?.length || 0) + (m.reasoning?.length || 0), 0),
          ...(finalClean.truncated ? {truncated: true} : {}),
          ...(merged.gap ? {gap: true} : {})
        };
        await area.set({[key]: record});
        return record;
      });
    },
    setTitle(sessionId, title, accountId) {
      return enqueue(async () => {
        const url = conversationUrl(sessionId);
        const cleanTitle = normalizeChatTitle(title);
        if (!cleanTitle) return null;
        const all = await area.get(null);
        const exactKey = accountId ? chatKey(accountId, sessionId) : null;
        const keys = Object.keys(all).filter(k => (k === exactKey || (k.startsWith(CHAT_PREFIX) && k.endsWith('.' + sessionId))) && validChat(all[k]) && all[k].url === url);
        if (!keys.length) return null;
        const updates = {};
        let updated = null;
        for (const k of keys) {
          updated = {...all[k], title: cleanTitle};
          updates[k] = updated;
        }
        await area.set(updates);
        return updated;
      });
    },
    async get(sessionId, accountId) {
      const url = conversationUrl(sessionId);
      await queue;
      const key = chatKey(accountId, sessionId);
      let record = (await area.get(key))[key];
      if (!validChat(record)) {
        const all = await area.get(null);
        const found = Object.keys(all).find(k => k.startsWith(CHAT_PREFIX) && k.endsWith('.' + sessionId) && validChat(all[k]));
        record = found ? all[found] : null;
      }
      return validChat(record) && record.url === url ? record : null;
    },
    async list() {
      await queue;
      const all = await area.get(null);
      return Object.entries(all)
        .filter(([k, r]) => k.startsWith(CHAT_PREFIX) && validChat(r))
        .map(([, r]) => r)
        .filter(r => {
          try {
            return r.url === conversationUrl(r.sessionId);
          } catch {
            return false;
          }
        })
        .sort((a, b) => String(b.lastCaptured).localeCompare(String(a.lastCaptured)));
    },
    remove(sessionId) {
      return enqueue(async () => {
        conversationUrl(sessionId);
        const all = await area.get(null);
        const keys = Object.keys(all).filter(k => k.startsWith(CHAT_PREFIX) && k.endsWith('.' + sessionId));
        if (keys.length) await area.remove(keys);
        return keys.length;
      });
    }
  };
}

/* Export shaping. Reasoning lives in its own field, so dropping it never touches
   the answer text — this is the switch the user asked for. */
export function shapeChatForExport(record, {includeReasoning = true, includeToolMarks = true} = {}) {
  if (!record) return null;
  const stripMarks = text => String(text || '').replace(/^> used [^\n]*\n?\n?/gm, '');
  const messages = record.messages.map(m => (includeReasoning || !m.reasoning ? m : (({reasoning, ...rest}) => rest)(m))).map(m => (includeToolMarks ? m : {...m, text: stripMarks(m.text)}));
  return {...record, messages, ...(includeReasoning ? {} : {reasoningOmitted: true}), ...(includeToolMarks ? {} : {toolMarksOmitted: true})};
}
