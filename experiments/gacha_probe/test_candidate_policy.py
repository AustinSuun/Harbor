import unittest
from datetime import datetime, timezone
from candidate_policy import candidate_summary, ImmediateThinking, site_action, retry_after_seconds

class Policies(unittest.TestCase):
    def html(self, n):
        return '<!doctype html>\n<html><body>\n' + '\n'.join('<div>x</div>' for _ in range(n-3)) + '\n</body></html>'
    def test_150_included(self):
        r = candidate_summary(self.html(150), complete_validated=True)
        self.assertEqual(r['raw_lines'], 150)
        self.assertTrue(r['candidate'])
    def test_151_kept(self):
        r = candidate_summary(self.html(151), complete_validated=True)
        self.assertFalse(r['candidate']); self.assertFalse(r['automatic_discard'])
    def test_newlines(self):
        for separator in ('\n', '\r\n', '\r'):
            s = self.html(150).replace('\n', separator)+separator
            self.assertEqual(candidate_summary(s)['raw_lines'], 150)
    def test_blank_lines_count(self):
        r = candidate_summary('a\n\nb\n')
        self.assertEqual((r['raw_lines'],r['nonempty_lines']), (3,2))
    def test_incomplete_and_wrong_kind(self):
        self.assertFalse(candidate_summary('<html>')['candidate'])
        self.assertFalse(candidate_summary('', complete_validated=True)['candidate'])
        self.assertFalse(candidate_summary(self.html(10), complete_validated=True, kind='stickman')['candidate'])
    def test_minified_warning(self):
        r = candidate_summary('<html><body>'+('x'*2000)+'</body></html>', complete_validated=True)
        self.assertTrue(r['candidate']); self.assertTrue(r['compressed_or_long_line'])
        self.assertEqual(r['model_identity'], 'unknown')
    def thinking(self):
        return dict(url='https://arena.ai/agent/test',turn_id='new-turn',thinking_explicit=True,generating=True,stop_count=1)
    def test_immediate_without_wait(self):
        s=self.thinking(); self.assertTrue(ImmediateThinking(s['url'],s['turn_id']).observe(s,now=0))
    def test_thinking_boundaries(self):
        s=self.thinking(); p=ImmediateThinking(s['url'],s['turn_id'])
        for key,value in [('turn_id','old'),('url','other'),('thinking_explicit',False),('generating',False),('stop_count',2),('stop_count',0)]:
            self.assertFalse(p.observe(dict(s,**{key:value})))
    def test_captcha_precedes_rate(self):
        r=site_action(dict(captcha_active=True,rate_limited=True))
        self.assertEqual(r['action'],'wait_for_human'); self.assertFalse(r['bypass_challenge'])
    def test_rate_backoff(self):
        self.assertEqual([site_action({'rate_limited':True},rate_attempts=n)['wait_seconds'] for n in range(5)], [60,120,240,480,960])
        self.assertEqual(site_action({'rate_limited':True},rate_attempts=5)['action'],'manual_review')
    def test_server_wait_not_shortened(self):
        self.assertEqual(site_action({'rate_limited':True},retry_after='7200')['wait_seconds'],7200)
    def test_http_date(self):
        now=datetime(2026,9,12,0,0,tzinfo=timezone.utc)
        self.assertEqual(retry_after_seconds('Sat, 12 Sep 2026 00:02:00 GMT',now=now),120)
        for value in (None,'invalid','-3','Infinity'):
            self.assertIsNone(retry_after_seconds(value,now=now))
    def test_denied_and_login(self):
        self.assertEqual(site_action({'access_denied':True})['action'],'manual_review')
        self.assertEqual(site_action({'session_expired':True})['action'],'wait_for_login')
    def test_unknown_and_duplicate(self):
        self.assertEqual(site_action({})['action'],'observe_only')
        self.assertEqual(site_action({'submission_outcome_unknown':True})['action'],'reconcile_submission')
    def test_clear_does_not_automatically_send(self):
        s={k:False for k in ('captcha_active','rate_limited','access_denied','session_expired','submission_outcome_unknown','generation_active')}
        s['composer_ready']=True
        r=site_action(s); self.assertEqual(r['action'],'ready_for_explicit_resume')
        self.assertFalse(r['automatic_resubmit']); self.assertFalse(r['allow_submission'])

if __name__ == '__main__':unittest.main(verbosity=2)
