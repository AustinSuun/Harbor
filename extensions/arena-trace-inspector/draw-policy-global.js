/* 2.5: pure filtering and stop policy. Labels are Arena configuration names, not proof of vendor reasoning settings. */
(() => {
  const KEY = 'ati.autoDraw.policy.v1',
    TIERS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const FAMILY_RE = /^[a-z0-9][a-z0-9._\/-]{0,79}$/i;
  const integer = (v, min, max, fallback) => (Number.isInteger(v) && v >= min && v <= max ? v : fallback);
  function parseRule(x) {
    if (typeof x !== 'string') return null;
    const s = x.trim().toLowerCase();
    const colon = s.indexOf(':');
    if (colon === -1) {
      if (!FAMILY_RE.test(s)) return null;
      const t = s.match(new RegExp('^(.+)-(' + TIERS.join('|') + ')$'));
      return {raw: s, base: s, stem: t && FAMILY_RE.test(t[1]) ? t[1] : null, stemTier: t ? t[2] : null, tiers: []};
    }
    if (s.indexOf(':', colon + 1) !== -1) return null;
    const base = s.slice(0, colon),
      tierPart = s.slice(colon + 1);
    if (!FAMILY_RE.test(base) || !tierPart) return null;
    const parts = tierPart.split(/[\/|]/);
    if (!parts.length || parts.some(t => !TIERS.includes(t))) return null;
    const tiers = [...new Set(parts)];
    if (tiers.length !== parts.length) return null;
    return {raw: base + ':' + tiers.join('/'), base, stem: null, stemTier: null, tiers};
  }
  const families = v => [...new Set((Array.isArray(v) ? v : []).map(x => parseRule(x)?.raw).filter(Boolean))].slice(0, 20);
  function sanitize(v = {}) {
    v = v && typeof v === 'object' ? v : {};
    const r = v.rules || {},
      s = v.stop || {};
    return {
      schemaVersion: 1,
      rules: {
        enabled: r.enabled === true,
        include: families(r.include),
        exclude: families(r.exclude),
        tiers: [...new Set((Array.isArray(r.tiers) ? r.tiers : []).filter(x => TIERS.includes(x)))],
        unknown: 'review'
      },
      stop: {
        targetHits: integer(s.targetHits, 0, 100, 0),
        uniqueTargets: integer(s.uniqueTargets, 0, 100, 0),
        maxMinutes: integer(s.maxMinutes, 0, 360, 0),
        minPulse: typeof s.minPulse === 'number' && Number.isFinite(s.minPulse) && s.minPulse >= 0 && s.minPulse <= 100 ? s.minPulse : null,
        consecutiveFailures: integer(s.consecutiveFailures, 1, 20, 3)
      }
    };
  }
  function validate(v) {
    const p = sanitize(v);
    for (const key of ['include', 'exclude'])
      if (!Array.isArray(v?.rules?.[key]) || p.rules[key].length !== new Set(v.rules[key].map(x => String(x).trim().toLowerCase())).size)
        throw Error('模型规则仅接受字母、数字、点、短横线、下划线、斜杠及可选 :档位（如 gpt-6:high/max），最多 20 项');
    for (const key of ['targetHits', 'uniqueTargets', 'maxMinutes', 'consecutiveFailures']) if (p.stop[key] !== v?.stop?.[key]) throw Error('停止条件超出允许范围');
    if (!Array.isArray(v?.rules?.tiers) || p.rules.tiers.length !== new Set(v.rules.tiers).size) throw Error('档位后缀不在允许范围');
    if (p.stop.minPulse !== v?.stop?.minPulse) throw Error('额度阈值须为 0–100，留空表示关闭');
    return p;
  }
  const parse = s => globalThis.ArenaModelLabel?.parseModelLabel(s) || {base: s, tier: null, anonymous: false};
  // Boundary match, not prefix-anchored: a rule word matches anywhere in the label as long as it sits on a
  // separator boundary, so `fable-5` also matches `claude-fable-5.1-max`. `.` and `-` are equivalent because
  // Arena writes the same model both ways (claude-fable-5-1 / claude-fable-5.1-max). `fable-50` still misses.
  const normFamily = v =>
    String(v || '')
      .toLowerCase()
      .replace(/\./g, '-');
  const boundary = c => c === undefined || c === '-' || c === '_' || c === '/';
  const family = (label, prefix) => {
    const s = normFamily(label),
      f = normFamily(prefix);
    if (!f) return false;
    for (let i = s.indexOf(f); i !== -1; i = s.indexOf(f, i + 1)) {
      if (boundary(i === 0 ? undefined : s[i - 1]) && boundary(s[i + f.length])) return true;
    }
    return false;
  };
  function mapping(view) {
    const names = [
      ...new Set((view?.detail?.spans || []).filter(s => ['usage', 'cost'].includes(s.kind) && typeof s.values?.modelName === 'string' && s.values.modelName.trim()).map(s => s.values.modelName))
    ];
    if (!names.length) return 'missing';
    if (names.some(x => parse(x)?.anonymous)) return 'anonymous';
    const labels = (view?.serverModels || view?.models || []).map(m => m.serverLabel || m.model),
      matches = globalThis.ArenaModelLabel?.matchModelNames?.(labels, names);
    if (matches?.some(x => x.status === 'conflict')) return 'conflict';
    if (matches?.length) return matches.every(x => x.status === 'matched') ? 'matched' : 'mismatch';
    if (view?.models?.length && view.models.every(m => m.internal === true)) return 'matched';
    return 'mismatch';
  }

  function decide(view, policy) {
    const p = sanitize(policy),
      map = mapping(view);
    const result = (action, reason) => ({action, reason, mapping: map, known: map === 'matched'});
    if (map !== 'matched') return result('review', 'uncertain-model');
    if (!p.rules.enabled) return {...result('keep', 'no-filter'), targets: (view.models || []).map(m => m.model)};
    const models = view.models || [],
      candidates = m => [m.model, m.serverLabel, parse(m.model)?.base].filter(Boolean),
      modelTier = m => parse(m.model)?.tier || null;
    const matchFamilyOnly = (m, rule) => {
      const parsed = parseRule(rule);
      if (!parsed) return false;
      if (candidates(m).some(x => family(x, parsed.base))) return true;
      if (parsed.stem && candidates(m).some(x => family(x, parsed.stem))) return true;
      return false;
    };
    const matchRule = (m, rule) => {
      const parsed = parseRule(rule);
      if (!parsed) return false;
      const tier = modelTier(m);
      if (parsed.tiers.length) return candidates(m).some(x => family(x, parsed.base)) && parsed.tiers.includes(tier);
      if (candidates(m).some(x => family(x, parsed.base))) return true;
      if (parsed.stem && candidates(m).some(x => family(x, parsed.stem)) && tier === parsed.stemTier) return true;
      return false;
    };
    const excluded = p.rules.exclude.filter(f => models.some(m => matchRule(m, f)));
    if (excluded.length) return {...result('archive', 'exclude-match'), ruleMatches: excluded.map(x => 'exclude:' + x)};
    const familyMatched = models.filter(m => !p.rules.include.length || p.rules.include.some(f => matchFamilyOnly(m, f)));
    if (!familyMatched.length) return result('archive', 'include-miss');
    const eligible = models.filter(m => !p.rules.include.length || p.rules.include.some(f => matchRule(m, f)));
    if (!eligible.length) return result('archive', 'tier-miss');
    if (p.rules.tiers.length && !eligible.some(m => p.rules.tiers.includes(modelTier(m)))) return result('archive', 'tier-miss');
    const targets = eligible.filter(m => !p.rules.tiers.length || p.rules.tiers.includes(modelTier(m)));
    return {
      ...result('keep', 'rule-match'),
      targets: targets.map(m => m.model),
      ruleMatches: [
        ...p.rules.include.filter(f => targets.some(m => matchRule(m, f))).map(x => 'include:' + x),
        ...p.rules.tiers.filter(t => targets.some(m => modelTier(m) === t)).map(t => 'tier:' + t)
      ]
    };
  }
  function stopReason(policy, {hits = 0, unique = 0, elapsedMs = 0, pulse = null, checkPulse = false} = {}) {
    const s = sanitize(policy).stop;
    if (s.targetHits && hits >= s.targetHits) return 'target-count';
    if (s.uniqueTargets && unique >= s.uniqueTargets) return 'unique-count';
    if (s.maxMinutes && elapsedMs >= s.maxMinutes * 60000) return 'time-limit';
    if (checkPulse && s.minPulse !== null) {
      if (typeof pulse !== 'number' || !Number.isFinite(pulse)) return 'quota-unavailable';
      if (pulse <= s.minPulse) return 'quota-threshold';
    }
    return null;
  }
  const reasonText = {
    'cleanup-failed': '聊天已归档，本地记录清理失败',
    'cleanup-changed': '本地记录已变化，未删除新数据',
    'preflight-failed': '启动自检未通过',
    'page-frozen': '页面被冻结，请手动激活后重查',
    'page-unresponsive': '页面暂不可响应，任务状态待核对',
    'no-filter': '未启用筛选',
    'rule-match': '命中保留规则',
    'exclude-match': '命中排除规则',
    'include-miss': '未命中模型范围',
    'tier-miss': '未命中档位范围',
    'uncertain-model': '内部名缺失、匿名或映射不明确，保留待确认',
    'target-count': '已达到确认目标数量',
    'unique-count': '已达到不同目标数量',
    'time-limit': '已达到最长运行时间',
    'quota-threshold': '剩余额度已达到停止阈值',
    'quota-unavailable': '无法读取剩余额度，未继续发送',
    'create-chat-limit': '新建会话限流额度已用尽',
    'failure-limit': '已达到连续失败上限',
    'user-stop': '用户停止',
    completed: '轮数已完成',
    interrupted: '页面刷新、离站或任务进程已中断',
    'capture-stopped': '监听已停止',
    'naming-unavailable': '内部名未就绪，补读已结束',
    'operation-failed': '页面操作或读取失败',
    'state-changed': '会话或运行已变化',
    'storage-failed': '任务记录保存失败',
    'retry-requested': '用户请求重试',
    'retry-ready': '当前运行补读成功',
    'retry-failed': '未完成补读或命名',
    'manual-title': '标题已变化，未自动覆盖',
    'unconfirmed-send': '未确认发送结果，不自动重发'
  };
  globalThis.ArenaDrawPolicy = {KEY, TIERS, parseRule, sanitize, validate, mapping, decide, stopReason, reasonText, family};
})();
