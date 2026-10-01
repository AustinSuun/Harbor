// Metadata-only overview for the popup. Counts are bounded and never inspect record values.
const LEVELS = ['compatible', 'pending', 'partial', 'incompatible', 'limited', 'unknown'];
const LABELS = {compatible: '兼容', pending: '等待事件', partial: '部分兼容', incompatible: '需要更新', limited: '读取受限', unknown: '未评估'};
const count = value => (Number.isSafeInteger(value) && value > 0 ? Math.min(value, 9999) : 0);
export const metadataScopeText = '范围：模型标签、运行 ID、用量、白名单 span 详情与兼容性快照；不含对话正文、令牌或原始 trace。';
export const metadataHistoryText = '历史记录是本机快照，不会重新验证或补全未监听调用。';

export function summarizeMetadataWorkspace(records) {
  const list = Array.isArray(records) ? records.filter(record => record && typeof record === 'object') : [];
  const compatibility = Object.fromEntries(LEVELS.map(level => [level, 0]));
  let runs = 0,
    observations = 0;
  for (const record of list) {
    observations += count(Array.isArray(record.observations) ? record.observations.length : 0);
    for (const run of Array.isArray(record.runs) ? record.runs : []) {
      if (!run || typeof run !== 'object') continue;
      runs++;
      if (LEVELS.includes(run.compatibility?.level)) compatibility[run.compatibility.level]++;
    }
  }
  return {schemaVersion: 1, sessions: Math.min(list.length, 9999), runs: Math.min(runs, 9999), observations: Math.min(observations, 9999), compatibility};
}

export function formatMetadataWorkspace(summary) {
  const value = summary && summary.schemaVersion === 1 ? summary : summarizeMetadataWorkspace([]);
  const snapshots = LEVELS.filter(level => value.compatibility?.[level] > 0).map(level => LABELS[level] + ' ' + value.compatibility[level]);
  return {
    summary: '已保存元数据：' + value.sessions + ' 个会话 · ' + value.runs + ' 个运行 · ' + value.observations + ' 条模型观测。',
    compatibility: snapshots.length ? '兼容性快照：' + snapshots.join(' · ') + '。' : '兼容性快照：尚无已保存运行快照。'
  };
}
