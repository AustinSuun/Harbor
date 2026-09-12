"""Offline experimental decisions only; no network, clicks, DB, or scheduler imports.
Inputs must be observations of the bound current task, not generated prose.
"""
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import math

CANDIDATE_LINE_LIMIT = 150


def candidate_summary(source, *, complete_validated=False, kind='pelican'):
    """Caller validates complete original HTML; never format or remove scripts here."""
    text = source.replace('\r\n', '\n').replace('\r', '\n')
    lines = text.split('\n') if text else []
    if lines and lines[-1] == '':
        lines.pop()  # A terminal newline does not add a physical line.
    raw = len(lines)
    longest = max(map(len, lines), default=0)
    eligible = kind in ('pelican', 'pelican_quick') and complete_validated is True and raw > 0
    return dict(raw_lines=raw, nonempty_lines=sum(bool(x.strip()) for x in lines),
                longest_line=longest, line_limit=CANDIDATE_LINE_LIMIT,
                candidate=eligible and raw <= CANDIDATE_LINE_LIMIT,
                status=('short_code_candidate' if raw <= CANDIDATE_LINE_LIMIT else 'over_threshold_keep')
                       if eligible else 'not_eligible',
                compressed_or_long_line=longest > 1000,
                source_may_include_platform_injections=True,
                model_identity='unknown', automatic_discard=False)


@dataclass(frozen=True)
class ImmediateThinking:
    """Pass to probe.attempt_stop; dry-run remains its default.
    No time threshold; fresh rechecks/unique-button checks still apply.
    Task owner must bind both URL and newly observed current assistant turn ID.
    """
    expected_url: str
    expected_turn_id: str

    def observe(self, snapshot, now=None):
        return bool(self.expected_url and self.expected_turn_id
                    and snapshot.get('url') == self.expected_url
                    and snapshot.get('turn_id') == self.expected_turn_id
                    and snapshot.get('thinking_explicit') is True
                    and snapshot.get('generating') is True
                    and snapshot.get('stop_count') == 1)


def retry_after_seconds(value, *, now=None):
    """HTTP delta seconds or HTTP date. Invalid/unbounded values fail closed upstream."""
    if value is None:
        return None
    value = str(value).strip()
    if value.isascii() and value.isdigit():
        try:
            return int(value)
        except ValueError:
            return None
    try:
        stamp = parsedate_to_datetime(value)
        if stamp.tzinfo is None:
            return None
        current = datetime.now(timezone.utc) if now is None else now
        return max(0, math.ceil((stamp-current).total_seconds()))
    except (ValueError, TypeError, OverflowError):
        return None


def site_action(snapshot, *, retry_after=None, rate_attempts=0, now=None):
    """Policy, NOT a detector: verified signals must come from site UI or relevant
    request metadata. Never feed assistant prose or unrelated asset errors here.
    wait_seconds is a minimum, not permission to replay a submitted prompt.
    """
    base = dict(automatic_resubmit=False, rotate_account=False, bypass_challenge=False,
                allow_submission=False, requires_recheck=True)
    if snapshot.get('captcha_active') is True:
        return dict(base, action='wait_for_human', reason='captcha', wait_seconds=None)
    if snapshot.get('access_denied') is True:
        return dict(base, action='manual_review', reason='access_denied', wait_seconds=None)
    if snapshot.get('session_expired') is True:
        return dict(base, action='wait_for_login', reason='session_expired', wait_seconds=None)
    if snapshot.get('rate_limited') is True:
        if rate_attempts >= 5:
            return dict(base, action='manual_review', reason='repeated_rate_limit', wait_seconds=None)
        delay = retry_after_seconds(retry_after, now=now)
        if delay is None:
            delay = min(1800, 60 * 2 ** max(0, min(5, rate_attempts)))
        # Never shorten a long server-requested wait to our fallback ceiling.
        return dict(base, action='cooldown', reason='rate_limit', wait_seconds=max(1, delay))
    if snapshot.get('submission_outcome_unknown') is True:
        return dict(base, action='reconcile_submission', reason='avoid_duplicate', wait_seconds=None)
    if snapshot.get('generation_active') is True:
        return dict(base, action='wait_for_generation', reason='already_running', wait_seconds=None)
    clear = all(snapshot.get(k) is False for k in
                ('captcha_active', 'access_denied', 'session_expired', 'rate_limited',
                 'submission_outcome_unknown', 'generation_active'))
    if clear and snapshot.get('composer_ready') is True:
        return dict(base, action='ready_for_explicit_resume', reason='clear_observation', wait_seconds=0)
    return dict(base, action='observe_only', reason='insufficient_evidence', wait_seconds=None)
