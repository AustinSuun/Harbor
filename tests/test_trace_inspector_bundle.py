"""Bundled resources and portable settings; disposable data, no network/accounts."""
import base64, hashlib, json, shutil, sqlite3, sys, tempfile, unittest
from pathlib import Path
from unittest.mock import patch
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import trace_inspector_bundle as bundle
import trace_inspector_support as support

class BundledTraceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='harbor-bundle-test-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.original = Path(bundle.verified_bundle())

    def copy(self, name='copy'):
        return Path(shutil.copytree(self.original, self.root/name))

    def db(self):
        db = sqlite3.connect(':memory:')
        self.addCleanup(db.close)
        support.initialize(db, self.root/'backups')
        return db

    def test_default_is_disabled_and_portable(self):
        self.assertEqual(support.read_settings(self.db(), 'new'), {'enabled':False,'folder':''})

    def test_bundle_enables_without_path_and_persists_sentinel(self):
        db = self.db()
        support.write_settings(db, 'new', 'persistent', True, '  ')
        self.assertEqual(support.read_settings(db, 'new'), {'enabled':True,'folder':''})
        self.assertEqual(Path(support.resolve_folder('')), self.original)
        self.assertIn(str(self.original), support.launch_args('persistent', support.read_settings(db, 'new'), [])[1])

    def test_custom_directory_preserved(self):
        custom = self.copy('legacy custom')
        manifest = json.loads((custom/'manifest.json').read_text(encoding='utf-8'))
        manifest.pop('key')
        (custom/'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
        db = self.db()
        support.write_settings(db, 'old', 'persistent', True, str(custom))
        self.assertEqual(support.read_settings(db,'old')['folder'], str(custom.resolve()))
        self.assertEqual(support.resolve_folder(str(custom)), str(custom.resolve()))

    def test_disabled_needs_no_bundle_and_never_loads(self):
        with patch.object(support, 'verified_bundle', side_effect=ValueError('absent')):
            self.assertEqual(support.launch_args('persistent', {'enabled':False,'folder':''}, ['existing']), ['existing'])
            support.write_settings(self.db(), 'new', 'persistent', False, '')

    def test_missing_bundle_rejected_only_on_enable(self):
        with patch.object(support, 'verified_bundle', side_effect=ValueError('absent')):
            with self.assertRaises(ValueError):support.write_settings(self.db(), 'new', 'persistent', True, '')
            with self.assertRaises(ValueError):support.launch_args('persistent', {'enabled':True,'folder':''}, [])

    def test_incognito_not_enabled(self):
        with self.assertRaises(ValueError):support.launch_args('incognito', {'enabled':True,'folder':''}, [])
        with self.assertRaises(ValueError):support.write_settings(self.db(), 'new', 'incognito', True, '')

    def test_yescaptcha_flags_merged(self):
        args=support.launch_args('persistent', {'enabled':True,'folder':''}, ['--load-extension=C:/fixture/yescaptcha', '--disable-extensions-except=C:/fixture/yescaptcha'])
        self.assertEqual(len(args),2)
        for flag in args:
            self.assertIn('C:/fixture/yescaptcha',flag)
            self.assertEqual(flag.count(str(self.original)),1)

    def test_resource_root_relocation_and_stable_id(self):
        one=self.copy('v1/extensions/arena-trace-inspector')
        two=self.copy('v2/extensions/arena-trace-inspector')
        ids=[]
        for folder in [one,two]:
            with patch.object(bundle, 'RESOURCE_DIR', folder.parent.parent):
                self.assertEqual(Path(bundle.verified_bundle()), folder.resolve())
            manifest=json.loads((folder/'manifest.json').read_text(encoding='utf-8'))
            raw=base64.b64decode(manifest['key'],validate=True)
            self.assertGreater(len(raw),250)
            ids.append(''.join(chr(97+int(c,16)) for c in hashlib.sha256(raw).hexdigest()[:32]))
        self.assertEqual(ids[0],ids[1])

    def test_missing_runtime_file_rejected(self):
        folder=self.copy();(folder/'popup.html').unlink()
        with self.assertRaises(ValueError):bundle.verified_bundle(folder)

    def test_changed_runtime_file_rejected(self):
        folder=self.copy();(folder/'background.js').write_text('// changed',encoding='utf-8')
        with self.assertRaises(ValueError):bundle.verified_bundle(folder)

    def test_extra_private_file_rejected(self):
        folder=self.copy();(folder/'capture.json').write_text('{}',encoding='utf-8')
        with self.assertRaises(ValueError):bundle.verified_bundle(folder)

    def test_expected_version_and_permissions(self):
        manifest=json.loads((self.original/'manifest.json').read_text(encoding='utf-8'))
        self.assertEqual(manifest['version'],'2.0.0')
        self.assertEqual(set(manifest['permissions']),{'activeTab','debugger','storage'})
        self.assertFalse(manifest.get('update_url'))
        self.assertEqual(set(p.name for p in self.original.iterdir()),set(bundle.FILE_HASHES))
        self.assertFalse(any(p.endswith(('.sqlite3','.log')) for p in bundle.FILE_HASHES))

if __name__=='__main__':unittest.main(verbosity=2)
