import asyncio,json,sqlite3,tempfile,unittest,uuid
from pathlib import Path
from types import SimpleNamespace
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from task_history import History,ReviewInput
from html_results import complete_html,from_answer,collect_html,preview_html
HTML='<!doctype html><html><head><title>Test</title></head><body><svg width="100" height="100"><circle r="15" cx="20" cy="30"><animate attributeName="cx" values="20;80;20" dur="2s" repeatCount="indefinite"/></circle></svg></body></html>'
class Tests(unittest.IsolatedAsyncioTestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
  self.manager=SimpleNamespace(db=None);self.h=History(self.manager)
  self.db=sqlite3.connect(self.root/'data.sqlite3');self.db.row_factory=sqlite3.Row;self.manager.db=self.db
  self.db.executescript("CREATE TABLE accounts(id TEXT,name TEXT,login_email TEXT,password_cipher TEXT);CREATE TABLE environments(id TEXT,account_id TEXT);INSERT INTO accounts VALUES('a','Account A','a@example.invalid','SECRET');INSERT INTO environments VALUES('e','a');")
  self.h.initialize()
 def tearDown(self):self.db.close();self.tmp.cleanup()
 def new(self,index=1,kind='pelican',account='A'):
  run={'id':uuid.uuid4().hex,'environment_id':'e','environment_name':'Env','settings':{'kind':kind},'started_at':'2026-01-01T00:00:00+00:00','account_snapshot':{'id':account,'name':'Account '+account,'email':account+'@example.invalid'}}
  job={'record_id':uuid.uuid4().hex,'number':index,'status':'success','turns':[{'raw_text':'```html\n'+HTML+'\n```'}]};run['jobs']=[job];self.h.save_job(run,job);return run,job
 def test_retention_deletes_record_source_screenshot_and_never_resurrects(self):
  first=None
  for i in range(101):
   r,j=self.new(i,account='A' if i%2 else 'B')
   if i==0:
    first=(r,j);self.h.review(j['record_id'],ReviewInput(starred=True,note='review'))
    (self.h.artifacts/(j['record_id']+'.png')).write_bytes(b'old screenshot')
   self.h.html.save(r,j,HTML,'test')
  rid=first[1]['record_id'];self.assertEqual(self.h.html.list()['total'],100)
  self.assertIsNone(self.db.execute('SELECT * FROM task_records WHERE id=?',(rid,)).fetchone())
  self.assertFalse((self.h.artifacts/(rid+'.png')).exists())
  first[1]['message']='late save';self.h.save_run(first[0]);self.assertFalse(self.h.html.save(*first,HTML,'test'))
  self.assertIsNone(self.db.execute('SELECT * FROM task_records WHERE id=?',(rid,)).fetchone())
  self.assertEqual(self.db.execute('SELECT count(*) FROM accounts').fetchone()[0],1)
  self.assertEqual(len(self.h.html.list(q='Account A')['results']),50)
 def test_non_html_record_not_pruned(self):
  r,j=self.new();old=j['record_id']
  for i in range(101):
   a,b=self.new(i);self.h.html.save(a,b,HTML,'test')
  self.assertIsNotNone(self.h.get(old));self.assertEqual(self.h.html.list()['total'],100)
 def test_rollback_is_atomic(self):
  for i in range(100):
   r,j=self.new(i);self.h.html.save(r,j,HTML,'test')
  before=[x['id'] for x in self.h.html.list()['results']]
  self.db.execute("CREATE TRIGGER refuse_delete BEFORE DELETE ON task_records BEGIN SELECT RAISE(ABORT,'synthetic');END;")
  self.db.commit();r,j=self.new()
  with self.assertRaises(sqlite3.IntegrityError):self.h.html.save(r,j,HTML,'test')
  self.assertEqual(before,[x['id'] for x in self.h.html.list()['results']]);self.assertEqual(self.db.execute('SELECT count(*) FROM html_pruned').fetchone()[0],0)
 def test_account_snapshot_and_backup(self):
  account=self.h.account_snapshot('e');self.assertNotIn('password_cipher',account)
  r,j=self.new();r['account_snapshot']=account;self.h.html.save(r,j,HTML,'test')
  with self.db:self.db.execute("DELETE FROM accounts")
  self.assertEqual(self.h.get(j['record_id'])['html_result']['account_email'],'a@example.invalid')
  self.assertEqual(len(list((self.root/'migration-backups').glob('*.sqlite3'))),1)
 def test_html_validation(self):
  self.assertTrue(complete_html(HTML));self.assertFalse(complete_html('<html>unfinished'))
  self.assertFalse(complete_html('<div>fragment</div>'));self.assertEqual(from_answer('```html\n'+HTML+'\n```'),HTML)
  self.assertFalse(complete_html('<html>'+('x'*2_000_000)+'</html>'))
 async def test_capture_and_no_false_gallery(self):
  class P:
   url='https://arena.ai/agent/test'
   async def evaluate(self,_):return {'code':[HTML],'links':[],'srcdoc':[]}
  r,j=self.new();await self.h.capture_html(r,j,P());self.assertEqual(self.h.html.list()['total'],1);self.assertEqual(j['html_capture'],'saved')
  class Empty:
   url='https://arena.ai/agent/test'
   async def evaluate(self,_):return {'code':[],'links':[{'url':'https://evil.invalid/hello.html','name':'hello.html'}],'srcdoc':[]}
  r,j=self.new();j['turns']=[{'raw_text':'生成好了 /home/user/index.html'}];await self.h.capture_html(r,j,Empty());self.assertEqual(self.h.html.list()['total'],1);self.assertIn('未取得',j['html_capture'])
 async def test_deleted_screenshot_not_recreated(self):
  r,j=self.new();rid=j['record_id']
  with self.db:self.db.execute('INSERT INTO html_pruned VALUES (?)',(rid,))
  class P:
   def is_closed(self):raise AssertionError('Should not access page')
  await self.h.screenshot(r,j,P())

if __name__=='__main__':unittest.main(verbosity=2)
