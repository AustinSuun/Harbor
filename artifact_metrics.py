"""Original HTML line-count heuristic; not model identification or quality scoring."""
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
