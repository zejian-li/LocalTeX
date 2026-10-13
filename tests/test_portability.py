# SPDX-License-Identifier: Apache-2.0
"""Run with: python -m unittest discover -s tests -v (stdlib only)."""
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import socket
import stat
import tempfile
import threading
import unittest
import urllib.request
import urllib.error
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('localtex',Path(__file__).resolve().parents[1]/'server.py')
app=importlib.util.module_from_spec(spec);spec.loader.exec_module(app)

class PortabilityTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        app.RECENT_FILE=self.root/'recent.json'
        (self.root/'main.tex').write_bytes(b'first\nsecond\n')
        self.key=app.register_project(self.root)
        self.server=app.bind_server(0);self.port=self.server.server_port
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
    def tearDown(self):
        self.server.shutdown();self.server.server_close();self.thread.join();self.temp.cleanup()
    def request(self,path,data=None,headers=None):
        req=urllib.request.Request(f'http://127.0.0.1:{self.port}'+path,data=json.dumps(data).encode() if data is not None else None,
            headers={'Content-Type':'application/json','X-LocalTeX-Project':self.key,**(headers or {})})
        try:
            with urllib.request.urlopen(req,timeout=5) as r:return r.status,json.loads(r.read())
        except urllib.error.HTTPError as e:
            body=e.read()
            try:body=json.loads(body)
            except ValueError:pass
            return e.code,body
    def save(self,text):
        raw=(self.root/'main.tex').read_bytes()
        return self.request('/api/save',{'path':'main.tex','text':text,'version':hashlib.sha256(raw).hexdigest()})
    def test_format_and_permissions(self):
        p=self.root/'main.tex';raw=b'\xef\xbb\xbffirst\r\nsecond\r\n';p.write_bytes(raw);p.chmod(0o644)
        code,loaded=self.request('/api/file?path=main.tex');self.assertEqual(loaded['text'],'first\nsecond\n')
        self.assertEqual(self.save('new\ntext\n')[0],200)
        self.assertEqual(p.read_bytes(),b'\xef\xbb\xbfnew\r\ntext\r\n')
        if app.os.name!='nt':self.assertEqual(stat.S_IMODE(p.stat().st_mode),0o644)
        code,history=self.request('/api/snapshot?path=main.tex&id='+hashlib.sha256(raw).hexdigest())
        self.assertEqual(history['text'],'first\nsecond\n')
    def test_encoding_and_readonly_are_not_overwritten(self):
        p=self.root/'main.tex';raw=b'\xffbroken';p.write_bytes(raw)
        self.assertEqual(self.request('/api/file?path=main.tex')[0],400);self.assertEqual(self.save('replace')[0],400);self.assertEqual(p.read_bytes(),raw)
        p.write_bytes(b'original');p.chmod(0o444)
        try:self.assertEqual(self.save('replace')[0],400);self.assertEqual(p.read_bytes(),b'original')
        finally:p.chmod(0o644)
    def test_save_failure_and_conflict_preserve_original(self):
        p=self.root/'main.tex';original=p.read_bytes();real=app.os.replace
        def fail(src,dst):
            if Path(dst)==p:raise OSError('simulated disk failure')
            return real(src,dst)
        with patch.object(app.os,'replace',fail):self.assertEqual(self.save('replacement')[0],400)
        self.assertEqual(p.read_bytes(),original);self.assertFalse(list(self.root.glob('.localtex-*')))
        self.assertEqual(self.request('/api/save',{'path':'main.tex','text':'replacement','version':'old'})[0],409)
        self.assertEqual(p.read_bytes(),original)
    def test_mixed_newlines_rejected(self):
        p=self.root/'main.tex';raw=b'one\r\ntwo\n';p.write_bytes(raw)
        self.assertEqual(self.save('new\ntext')[0],400);self.assertEqual(p.read_bytes(),raw)
    def test_upload_bytes_collisions_and_escape(self):
        raw=b'\x00\xffbinary';payload={'path':'图 image.pdf','content':base64.b64encode(raw).decode()}
        self.assertEqual(self.request('/api/upload',payload)[0],200);self.assertEqual((self.root/payload['path']).read_bytes(),raw)
        self.assertEqual(self.request('/api/upload',payload)[0],409)
        payload['path']='../escape.pdf';self.assertEqual(self.request('/api/upload',payload)[0],400)
        payload['path']='.localtex/settings.json';self.assertEqual(self.request('/api/upload',payload)[0],400)
    def test_browser_picker(self):
        from urllib.parse import quote
        code,listing=self.request('/api/browse?path='+quote(str(self.root)));self.assertEqual(code,200)
        self.assertTrue(any(e['name']=='main.tex' for e in listing['entries']))
        self.assertEqual(self.request('/api/browse/create',{'parent':str(self.root),'name':'new folder','kind':'folder'})[0],200)
        self.assertEqual(self.request('/api/project/open',{'path':str(self.root/'new folder')})[0],200)
        self.assertEqual(self.request('/api/browse/create',{'parent':str(self.root),'name':'../bad','kind':'folder'})[0],400)
    def test_forwarded_port_and_request_validation(self):
        headers={'Host':'localhost:12345','Origin':'http://localhost:12345'}
        self.assertEqual(self.request('/api/projects',headers=headers)[0],200)
        self.assertEqual(self.request('/api/projects',headers={'Host':'evil.example:12345'})[0],403)
        self.assertEqual(self.request('/api/projects',headers={**headers,'Origin':'http://evil.example:12345'})[0],403)
    def test_busy_port(self):
        other=app.bind_server(self.port)
        try:self.assertNotEqual(other.server_port,self.port)
        finally:other.server_close()
    def test_missing_dependencies_and_remote_picker(self):
        import builtins
        actual=builtins.__import__
        def missing(name,*args,**kwargs):
            if name=='tkinter':raise ImportError('missing Tk')
            return actual(name,*args,**kwargs)
        with patch.dict(app.os.environ,{'DISPLAY':':0','SSH_CONNECTION':'','SSH_CLIENT':'','SSH_TTY':''}),patch('builtins.__import__',side_effect=missing),patch.object(app.shutil,'which',return_value=None):
            info=app.capabilities();self.assertFalse(info['nativePicker']);self.assertIn('same interpreter',info['pickerReason']);self.assertNotIn('sudo apt',info['pickerReason']);self.assertTrue(any('No TeX engine' in w for w in info['warnings']))
        with patch.dict(app.os.environ,{'SSH_CONNECTION':'client 100 server 22'}),patch.object(app,'run_command') as native:
            code,info=self.request('/api/project/open',{'kind':'file'});self.assertTrue(info['pickerUnavailable']);self.assertIn('Remote',info['reason']);native.assert_not_called()
        with patch.object(app,'REMOTE_MODE',True),patch.object(app,'run_command') as native:
            self.assertFalse(self.request('/api/capabilities')[1]['nativePicker']);native.assert_not_called()
    def test_console_dependency_notices(self):
        import contextlib
        import io
        from unittest.mock import Mock
        server=Mock(server_port=12345);server.serve_forever.side_effect=KeyboardInterrupt
        report={'nativePicker':False,'pickerReason':'Tkinter/Tcl-Tk missing','remote':False,'warnings':['Enable Tcl/Tk using your Python installer or package manager.','No TeX engine: use --tex-path DIR.']}
        output=io.StringIO()
        with patch.object(app.sys,'argv',['server.py','--no-browser']),patch.object(app,'bind_server',return_value=server),patch.object(app,'capabilities',return_value=report),contextlib.redirect_stdout(output):
            app.main()
        self.assertIn('NOTICE: Enable Tcl/Tk',output.getvalue());self.assertIn('NOTICE: No TeX engine',output.getvalue());server.server_close.assert_called_once()
    def test_custom_tex_directory(self):
        tools=self.root/'custom tools';tools.mkdir();previous=app.TEX_DIR
        exe=tools/('pdflatex.exe' if app.os.name=='nt' else 'pdflatex');exe.write_bytes(b'fake executable');exe.chmod(0o755)
        try:
            code,info=self.request('/api/tools',{'texPath':str(tools)});self.assertEqual(code,200);self.assertEqual(Path(info['tools']['pdflatex']),exe)
            self.assertEqual(json.loads((app.RECENT_FILE.parent/'tool-path.json').read_text())['texPath'],str(tools))
            self.assertEqual(self.request('/api/tools',{'texPath':str(tools/'missing')})[0],400);self.assertEqual(app.TEX_DIR,str(tools))
            app.BUILD_LOCK.acquire()
            try:self.assertEqual(self.request('/api/tools',{'texPath':''})[0],400)
            finally:app.BUILD_LOCK.release()
        finally:app.configure_tex_path(previous)
    def test_preview_and_archive(self):
        import io
        import zipfile
        (self.root/'image.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>',encoding='utf-8')
        (self.root/'empty').mkdir();(self.root/'.secret').write_bytes(b'keep')
        (self.root/'.localtex-trash').mkdir();(self.root/'.localtex-trash'/'private').write_bytes(b'omit')
        self.save('saved draft')
        def get(endpoint):
            req=urllib.request.Request(f'http://127.0.0.1:{self.port}'+endpoint,headers={'X-LocalTeX-Project':self.key})
            with urllib.request.urlopen(req,timeout=5) as r:return r.headers,r.read()
        headers,content=get('/api/image?path=image.svg');self.assertEqual(headers['Content-Type'],'image/svg+xml');self.assertIn('sandbox',headers['Content-Security-Policy'])
        headers,content=get('/api/asset?path=main.tex');self.assertIn('attachment',headers['Content-Disposition']);self.assertEqual(content,b'saved draft')
        headers,content=get('/api/project/download')
        with zipfile.ZipFile(io.BytesIO(content)) as z:
            self.assertEqual(z.read('main.tex'),b'saved draft');self.assertIn('empty/',z.namelist());self.assertEqual(z.read('.secret'),b'keep')
            self.assertFalse(any(p.startswith('.localtex/history') or p.startswith('.localtex-trash') for p in z.namelist()))

if __name__=='__main__':unittest.main()
