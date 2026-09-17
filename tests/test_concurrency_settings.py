"""Offline validation and worker allocation tests; no browser/account use."""
import asyncio
from html.parser import HTMLParser
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from pydantic import ValidationError
from pelican_tasks import TaskSettings, PelicanTasks

class Settings(unittest.TestCase):
 def test_positive_values_have_no_fixed_cap(self):
  for value in (1,3,4,20,50,1000000):
   self.assertEqual(TaskSettings(concurrency=value).concurrency,value)
  self.assertNotIn('maximum',TaskSettings.model_json_schema()['properties']['concurrency'])
 def test_nonpositive_and_fractional_rejected(self):
  for value in (0,-1,1.5):
   with self.assertRaises(ValidationError):TaskSettings(concurrency=value)
 def test_html_has_no_max(self):
  found=[]
  class Parser(HTMLParser):
   def handle_starttag(self,tag,attrs):
    a=dict(attrs)
    if a.get('id')=='task-concurrency':found.append(a)
  Parser().feed((ROOT/'browser_manager.html').read_text(encoding='utf-8'))
  self.assertEqual(len(found),1);self.assertNotIn('max',found[0]);self.assertEqual(found[0]['min'],'1');self.assertEqual(found[0]['step'],'1')

class Allocation(unittest.IsolatedAsyncioTestCase):
 async def allocate(self,concurrency,total):
  service=PelicanTasks.__new__(PelicanTasks);calls=[]
  service.history=SimpleNamespace(save_run=lambda r:None,cache={})
  service.manager=SimpleNamespace(log=lambda *a:None)
  async def persist(run):await asyncio.Event().wait()
  async def worker(eid,run):calls.append(1);await asyncio.sleep(0)
  service.persist_loop=persist;service.worker=worker
  run={'stop':asyncio.Event(),'settings':{'concurrency':concurrency},'jobs':[{'record_id':str(i),'status':'success'} for i in range(total)]}
  await service.execute('fixture',run)
  self.assertEqual(len(calls),min(concurrency,total));self.assertEqual(run['status'],'completed')
 async def test_more_than_three_workers(self):await self.allocate(8,20)
 async def test_huge_value_only_allocates_existing_jobs(self):await self.allocate(1000000,5)

if __name__=='__main__':unittest.main(verbosity=2)
