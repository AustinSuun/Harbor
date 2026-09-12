import sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from artifact_metrics import candidate_summary

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

if __name__=='__main__':unittest.main(verbosity=2)
