import json,hashlib,sqlite3,sys,tempfile,unittest,zipfile
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import update_service as u
import manager_credentials as credentials

class Updates(unittest.TestCase):
 def setUp(self):self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
 def tearDown(self):self.tmp.cleanup()
 def archive(self,extra=None):
  p=self.root/'package.zip'
  with zipfile.ZipFile(p,'w') as z:
   z.writestr('Harbor/Harbor.exe',b'fixture-not-executable')
   z.writestr('Harbor/distribution-manifest.json',json.dumps({'application_version':'9.0.0'}))
   if extra:z.writestr(extra,'test')
  return p,hashlib.sha256(p.read_bytes()).hexdigest()
 def test_versions(self):
  self.assertEqual(u.version('v9.1.2'),(9,1,2))
  for s in ('v1.2.3-rc1','evil','1.2','1.2.3;cmd'):self.assertIsNone(u.version(s))
 def test_fixed_origin(self):
  self.assertTrue(u.asset_url(u.REPO+'/releases/download/v9.0.0/a.zip'))
  self.assertFalse(u.asset_url('https://evil.invalid/a.zip'))
 def test_release_and_asset_selection(self):
  name='Harbor-Windows-x64-test.zip';url=u.REPO+'/releases/download/v9.0.0/'
  data={'tag_name':'v9.0.0','assets':[{'name':name,'browser_download_url':url+name},{'name':name+'.sha256','browser_download_url':url+name+'.sha256'}]}
  self.assertTrue(u.release_info(data,current='0.3.8')['available'])
  self.assertFalse(u.release_info(dict(data,prerelease=True),allow_preview=False)['available'])
  self.assertTrue(u.release_info(dict(data,prerelease=True))['prerelease'])
  self.assertFalse(u.release_info(dict(data,assets=[]))['available'])
  self.assertFalse(u.release_info(data,current='10.0.0')['available'])
 def test_extract_valid(self):
  p,h=self.archive();exe=u.extract_checked(p,self.root/'ok',h)
  self.assertTrue(exe.is_file())
 def test_checksum_rejects_before_extract(self):
  p,h=self.archive()
  with self.assertRaises(ValueError):u.extract_checked(p,self.root/'bad','0'*64)
  self.assertFalse((self.root/'bad').exists())
 def test_path_and_private_data_rejected(self):
  for name in ('Harbor/../../outside','Harbor/.. /outside','/absolute','Harbor/a:stream','Harbor/CON','Harbor/a//b','Harbor/profiles/data','Harbor/x.sqlite3'):
   p,h=self.archive(name)
   with self.subTest(name=name),self.assertRaises(ValueError):u.extract_checked(p,self.root/'bad',h)
 def test_duplicate_paths_rejected(self):
  p,h=self.archive('Harbor/HARBOR.EXE')
  with self.assertRaises(ValueError):u.extract_checked(p,self.root/'bad',h)
 def test_symlink_rejected(self):
  p,h=self.archive()
  with zipfile.ZipFile(p,'a') as z:
   i=zipfile.ZipInfo('Harbor/link');i.create_system=3;i.external_attr=(0o120777<<16);z.writestr(i,'outside')
  with self.assertRaises(ValueError):u.extract_checked(p,self.root/'bad',hashlib.sha256(p.read_bytes()).hexdigest())
 def test_update_pointer_confined(self):
  d=self.root/'updates';d.mkdir();outside=self.root/'Harbor.exe';outside.write_bytes(b'fixture')
  (d/'current.json').write_text(json.dumps({'version':'9.0.0','executable':str(outside)}))
  self.assertIsNone(u.installed_update(self.root))
  inside=d/'Harbor.exe';inside.write_bytes(b'fixture');(d/'current.json').write_text(json.dumps({'version':'9.0.0','executable':str(inside)}))
  self.assertEqual(u.installed_update(self.root),inside)
 def test_schedule_does_not_kill_old_process(self):
  service=u.Updates(self.root);service.root.mkdir();exe=service.root/'Harbor.exe';exe.write_bytes(b'fixture')
  with patch.object(u.subprocess,'Popen') as spawn:
   spawn.return_value.pid=999;service.schedule(exe,1234,'9.0.0')
   script=next(service.root.glob('switch-*.ps1')).read_text(encoding='utf-8-sig')
   self.assertIn('Wait-Process -Id 1234',script);self.assertNotIn('Stop-Process',script)
   self.assertEqual(spawn.call_count,1)

class MacKeychain(unittest.TestCase):
 def test_mac_keychain_reference_not_plaintext(self):
  store={}
  class Backend:
   def set_password(self,service,token,value):store[(service,token)]=value
   def get_password(self,service,token):return store.get((service,token))
  with patch.object(credentials.sys,'platform','darwin'),patch.object(credentials,'_mac_keychain',return_value=Backend()):
   cipher=credentials.encrypt_password('fixture-password')
   self.assertNotIn('fixture-password',cipher);self.assertTrue(cipher.startswith('macos-keychain:'))
   self.assertEqual(credentials.decrypt_password(cipher),'fixture-password')
   with self.assertRaises(credentials.CredentialError):credentials.decrypt_password('windows-data')
 def test_mac_unavailable_never_plaintext(self):
  with patch.object(credentials.sys,'platform','darwin'),patch.object(credentials,'_mac_keychain',side_effect=RuntimeError):
   with self.assertRaises(credentials.CredentialError):credentials.encrypt_password('fixture')
if __name__=='__main__':unittest.main(verbosity=2)
