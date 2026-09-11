"""Durable local review records. Machine updates never overwrite human review."""
from __future__ import annotations
from datetime import datetime, timezone
import json
from pathlib import Path
from typing import Literal
from fastapi import HTTPException
from pydantic import BaseModel, Field

TERMINAL={'success','archived','archive_failed','failed','unknown','untracked','cancelled','interrupted','parse_failed'}


def timestamp():
    return datetime.now(timezone.utc).isoformat()


class ReviewInput(BaseModel):
    rating: Literal['pending','good','average','bad']='pending'
    starred: bool=False
    tags: str=Field(default='',max_length=300)
    note: str=Field(default='',max_length=2000)


class History:
    def __init__(self,manager):
        self.manager=manager
        self.artifacts=None
        self.cache={}

    def initialize(self):
        database=Path(self.manager.db.execute('PRAGMA database_list').fetchone()[2])
        self.artifacts=database.parent/'task-artifacts'
        self.artifacts.mkdir(exist_ok=True)
        with self.manager.db:
            self.manager.db.execute('''CREATE TABLE IF NOT EXISTS task_records (
                id TEXT PRIMARY KEY, run_id TEXT NOT NULL, environment_id TEXT NOT NULL,
                environment_name TEXT NOT NULL, kind TEXT NOT NULL, number INTEGER NOT NULL,
                status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                url TEXT NOT NULL DEFAULT '', payload TEXT NOT NULL,
                rating TEXT NOT NULL DEFAULT 'pending', starred INTEGER NOT NULL DEFAULT 0,
                tags TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
                analysis TEXT, manual_answers TEXT NOT NULL DEFAULT '{}',
                screenshot TEXT NOT NULL DEFAULT '')''')
            self.manager.db.execute('CREATE INDEX IF NOT EXISTS task_records_created ON task_records(created_at DESC)')
            self.manager.db.execute('CREATE INDEX IF NOT EXISTS task_records_env ON task_records(environment_id)')
            # Never auto-resume or re-send an interrupted run after a crash/restart.
            for row in self.manager.db.execute('SELECT id,status,payload FROM task_records').fetchall():
                if row['status'] not in TERMINAL:
                    data=json.loads(row['payload'])
                    data.update(status='interrupted',message='管理器重启：任务不自动恢复；请检查网页是否仍在生成')
                    self.manager.db.execute('UPDATE task_records SET status=?,payload=?,updated_at=? WHERE id=?',
                                            ('interrupted',json.dumps(data,ensure_ascii=False),timestamp(),row['id']))

    def save_job(self,run,job):
        rid=job['record_id']
        public={k:v for k,v in job.items() if not k.startswith('_')}
        public['settings']=run['settings']
        payload=json.dumps(public,ensure_ascii=False)
        if self.cache.get(rid)==payload:
            return
        now=timestamp()
        with self.manager.db:
            self.manager.db.execute('''INSERT INTO task_records
                (id,run_id,environment_id,environment_name,kind,number,status,created_at,updated_at,url,payload)
                VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
                status=excluded.status, updated_at=excluded.updated_at,url=excluded.url,payload=excluded.payload''',
                (rid,run['id'],run['environment_id'],run['environment_name'],run['settings'].get('kind','pelican'),
                 job['number'],job['status'],run['started_at'],now,job.get('url',''),payload))
        self.cache[rid]=payload

    def save_run(self,run):
        for job in run['jobs']:
            message=(job['status'],job.get('message',''))
            if job.get('_event_key')!=message:
                job['_event_key']=message
                job.setdefault('events',[]).append({'time':timestamp(),'status':message[0],'message':message[1]})
                job['events']=job['events'][-150:]
            self.save_job(run,job)

    def get(self,rid):
        row=self.manager.db.execute('SELECT * FROM task_records WHERE id=?',(rid,)).fetchone()
        if not row:
            raise HTTPException(404,'任务记录不存在')
        data=dict(row)
        data['payload']=json.loads(data['payload'])
        data['manual_answers']=json.loads(data['manual_answers'])
        data['analysis']=json.loads(data['analysis']) if data['analysis'] else data['payload'].get('analysis')
        data['starred']=bool(data['starred'])
        return data

    def list(self,q='',rating='',starred=False,kind='',environment_id='',page=1):
        conditions=[];args=[]
        if q:
            conditions.append('(environment_name LIKE ? OR tags LIKE ? OR note LIKE ? OR id LIKE ?)')
            args.extend(['%'+q+'%']*4)
        for col,value in [('rating',rating),('kind',kind),('environment_id',environment_id)]:
            if value: conditions.append(col+'=?');args.append(value)
        if starred: conditions.append('starred=1')
        where=' WHERE '+' AND '.join(conditions) if conditions else ''
        total=self.manager.db.execute('SELECT count(*) FROM task_records'+where,args).fetchone()[0]
        rows=self.manager.db.execute('''SELECT id,run_id,environment_id,environment_name,kind,number,status,
            created_at,updated_at,url,rating,starred,tags,note,screenshot FROM task_records'''+where+
            ' ORDER BY created_at DESC,number ASC LIMIT 30 OFFSET ?',args+[(page-1)*30]).fetchall()
        return {'records':[dict(r) for r in rows],'total':total,'page':page,'page_size':30}

    def review(self,rid,inp):
        self.get(rid)
        with self.manager.db:
            self.manager.db.execute('UPDATE task_records SET rating=?,starred=?,tags=?,note=? WHERE id=?',
                                    (inp.rating,int(inp.starred),inp.tags,inp.note,rid))
        return self.get(rid)

    async def screenshot(self,run,job,page):
        if page is None or page.is_closed() or not job.get('submitted'):
            return
        name=job['record_id']+'.png'
        try:
            await page.screenshot(path=str(self.artifacts/name),full_page=False,timeout=5000)
            with self.manager.db:
                self.manager.db.execute('UPDATE task_records SET screenshot=? WHERE id=?',(name,job['record_id']))
        except Exception as exc:
            job['screenshot_error']=str(exc)[:300]

    def screenshot_path(self,rid):
        row=self.get(rid)
        expected=rid+'.png'
        if row['screenshot']!=expected or not (self.artifacts/expected).is_file():
            raise HTTPException(404,'该记录没有截图')
        # rid comes from a database lookup, not a filesystem path supplied by users.
        path=(self.artifacts/expected).resolve()
        if path.parent!=self.artifacts.resolve(): raise HTTPException(400,'无效截图路径')
        return path
