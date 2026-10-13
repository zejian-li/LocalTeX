# SPDX-License-Identifier: Apache-2.0
"""Safe project import tests using only Python's standard library."""
import concurrent.futures
import importlib.util
import io
import json
from pathlib import Path, PurePosixPath, PureWindowsPath
import stat
import struct
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch
import zipfile

spec=importlib.util.spec_from_file_location('zip_app',Path(__file__).resolve().parents[1]/'server.py')
app=importlib.util.module_from_spec(spec);spec.loader.exec_module(app)

def archive(items):
    out=io.BytesIO()
    with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:
        for name,content in items:z.writestr(name,content)
    out.seek(0)
    return out

def legacy_relative_to(path, parent):
    # Modern pathlib.relative_to itself calls is_relative_to; emulate its older
    # component-based implementation as well when testing Python 3.8 behavior.
    parent=type(path)(parent)
    normalize=(lambda parts:tuple(p.casefold() for p in parts)) if isinstance(path,PureWindowsPath) else tuple
    if normalize(path.parts[:len(parent.parts)])!=normalize(parent.parts) or path.anchor.casefold()!=parent.anchor.casefold():
        raise ValueError('Path is outside the parent')
    return type(path)(*path.parts[len(parent.parts):])

class ZipImportTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.base=Path(self.temp.name)
        app.WORKSPACE=self.base/'projects';app.RECENT_FILE=self.base/'recents.json'
    def tearDown(self):self.temp.cleanup()
    def imported(self,items,name='Paper.zip'):
        key=app.import_project_zip(archive(items),name)
        return app.PROJECTS[key]
    def test_portable_containment(self):
        for kind,root,other in [(PurePosixPath,'/project','/project-other'),(PureWindowsPath,'C:/project','D:/project')]:
            parent=kind(root)
            self.assertTrue(app.is_within(parent,parent))
            self.assertTrue(app.is_within(parent/'sub'/'main.tex',parent))
            self.assertFalse(app.is_within(kind(other)/'main.tex',parent))
        outside=self.base/'outside.tex';outside.write_bytes(b'keep')
        with self.assertRaises(ValueError):app.safe_path(self.base/'project','../outside.tex')
        self.assertEqual(outside.read_bytes(),b'keep')
    def test_python38_missing_path_method(self):
        # Python 3.8 does not provide this method. Guard all import paths against
        # accidentally reintroducing it, including project registration via HTTP.
        with patch.object(Path,'relative_to',legacy_relative_to),patch.object(Path,'is_relative_to',side_effect=AttributeError("'PosixPath' object has no attribute 'is_relative_to'"),create=True):
            self.test_http_import_without_project_and_limits()
    def test_wrapped_project_assets_unicode_and_recents(self):
        project=self.imported([('Wrapper/main.tex',b'main'),('Wrapper/chapters/a.tex',b'chapter'),('Wrapper/images/图.png',bytes(range(256))),('Wrapper/empty/',b''),('__MACOSX/._main.tex',b'junk')])
        self.assertEqual(project['root'],app.WORKSPACE/'Paper')
        self.assertEqual(project['main'],'main.tex')
        self.assertEqual((project['root']/'images/图.png').read_bytes(),bytes(range(256)))
        self.assertTrue((project['root']/'empty').is_dir())
        self.assertFalse((project['root']/'__MACOSX').exists())
        self.assertEqual(app.recent_projects()[0]['path'],str(project['root']))
    def test_unwrapped_nested_and_uppercase_tex(self):
        p=self.imported([('README.md',b'notes'),('sub/Main.TEX',b'tex'),('refs.bib',b'bib')])
        self.assertEqual(p['main'],'sub/Main.TEX')
        self.assertTrue((p['root']/'README.md').is_file())
    def test_initial_source_prefers_standalone_document(self):
        p=self.imported([('a-fragment.tex',b'fragment'),('z-paper.tex',b'\\documentclass{article}\n')])
        self.assertEqual(p['main'],'z-paper.tex')
    def test_encrypted_and_unsupported_compression_rejected(self):
        for encrypted in (True,False):
            raw=bytearray(archive([('main.tex',b'x')]).getvalue())
            central=raw.index(b'PK\x01\x02')
            if encrypted:
                struct.pack_into('<H',raw,6,1);struct.pack_into('<H',raw,central+8,1)
            else:
                struct.pack_into('<H',raw,8,99);struct.pack_into('<H',raw,central+10,99)
            with self.subTest(encrypted=encrypted),self.assertRaises(ValueError):app.import_project_zip(io.BytesIO(raw),'Paper.zip')
        self.assertFalse(app.WORKSPACE.exists())
    def test_collision_and_concurrent_imports_never_overwrite(self):
        app.WORKSPACE.mkdir();(app.WORKSPACE/'Paper').mkdir();(app.WORKSPACE/'Paper'/'old').write_bytes(b'keep')
        def run(i):return self.imported([('main.tex',str(i))])['root']
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:roots=list(pool.map(run,range(4)))
        self.assertEqual(len(set(roots)),4)
        self.assertEqual({p.name for p in roots},{'Paper (2)','Paper (3)','Paper (4)','Paper (5)'})
        self.assertEqual((app.WORKSPACE/'Paper'/'old').read_bytes(),b'keep')
        self.assertFalse(list(app.WORKSPACE.glob('.localtex-import-*')))
    def test_unsafe_paths_duplicates_and_non_tex_rejected(self):
        cases=['../escape.tex','/escape.tex','C:/escape.tex','dir\\escape.tex','CON.tex','file:stream.tex','bad./main.tex','a//main.tex']
        for name in cases:
            with self.subTest(name=name),self.assertRaises(ValueError):self.imported([(name,b'x')])
        for items in [[('main.tex',b'a'),('main.tex',b'b')],[('Dir/a.tex',b'a'),('dir/b.tex',b'b')],[('a',b'a'),('a/main.tex',b'b')],[('asset.png',b'a')],[('__MACOSX/main.tex',b'x')]]:
            with self.subTest(items=items),self.assertRaises(ValueError):self.imported(items)
        self.assertFalse(app.WORKSPACE.exists())
        self.assertFalse((self.base/'escape.tex').exists())
    def test_symlinks_and_special_files_rejected(self):
        for kind in (stat.S_IFLNK,stat.S_IFIFO,stat.S_IFCHR):
            info=zipfile.ZipInfo('link');info.create_system=3;info.external_attr=(kind|0o777)<<16
            with self.subTest(kind=kind),self.assertRaises(ValueError):self.imported([('main.tex',b'x'),(info,b'/etc/passwd')])
    def test_resource_limits_and_corruption(self):
        with patch.object(app,'ZIP_EXPANDED_LIMIT',10),self.assertRaises(ValueError):self.imported([('main.tex',b'x'*11)])
        with patch.object(app,'ZIP_ENTRY_LIMIT',1),self.assertRaises(ValueError):self.imported([('main.tex',b'x'),('other.tex',b'y')])
        for raw in (b'not a zip',archive([('main.tex',b'x')]).getvalue()[:-10]):
            with self.assertRaises(ValueError):app.import_project_zip(io.BytesIO(raw),'bad.zip')
        data=bytearray(archive([('main.tex',b'hello')]).getvalue());data[40]^=255
        with self.assertRaises(ValueError):app.import_project_zip(io.BytesIO(data),'broken.zip')
        self.assertFalse(list(app.WORKSPACE.glob('*')) if app.WORKSPACE.exists() else [])
    def test_disk_failure_cleans_staging_and_reserved_folder(self):
        with patch.object(Path,'rename',side_effect=OSError('disk failure')),self.assertRaises(OSError):self.imported([('main.tex',b'x')])
        self.assertEqual(list(app.WORKSPACE.iterdir()),[])
        self.assertFalse(app.RECENT_FILE.exists())
    def test_http_import_without_project_and_limits(self):
        server=app.bind_server(0);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        def request(raw,name='Paper.zip'):
            req=urllib.request.Request(f'http://127.0.0.1:{server.server_port}/api/project/import?name={name}',data=raw,headers={'Content-Type':'application/zip'})
            try:
                with urllib.request.urlopen(req,timeout=5) as r:return r.status,json.loads(r.read())
            except urllib.error.HTTPError as e:return e.code,json.loads(e.read())
        try:
            code,result=request(archive([('main.tex',b'hello')]).getvalue());self.assertEqual(code,200)
            self.assertEqual(Path(result['projectRoot'])/'main.tex',app.WORKSPACE/'Paper'/'main.tex')
            # Reproduce the incomplete spooled-file interface on older Python.
            real_spool=app.tempfile.SpooledTemporaryFile
            class LegacySpool:
                def __init__(self,*args,**kwargs):self.file=real_spool(*args,**kwargs)
                def __getattr__(self,name):
                    if name=='seekable':raise AttributeError("'SpooledTemporaryFile' object has no attribute 'seekable'")
                    return getattr(self.file,name)
                def __enter__(self):return self
                def __exit__(self,*args):self.file.close()
            with patch.object(app.tempfile,'SpooledTemporaryFile',LegacySpool):
                code,result=request(archive([('main.tex',b'compatible')]).getvalue())
                self.assertEqual(code,200,result)
                self.assertEqual((Path(result['projectRoot'])/'main.tex').read_bytes(),b'compatible')
            self.assertEqual(request(b'bad')[0],400)
            self.assertEqual(request(b'x','wrong.txt')[0],400)
            with patch.object(app,'ZIP_UPLOAD_LIMIT',2):self.assertEqual(request(b'abc')[0],400)
        finally:server.shutdown();server.server_close();thread.join()

if __name__=='__main__':unittest.main()
