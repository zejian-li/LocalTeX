# SPDX-License-Identifier: Apache-2.0
"""Bounded timeout/cancellation even with compiler descendants and stuck cleanup."""
import importlib.util
import io
import json
import signal
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch

spec=importlib.util.spec_from_file_location('lifecycle_app',Path(__file__).resolve().parents[1]/'server.py')
app=importlib.util.module_from_spec(spec);spec.loader.exec_module(app)

def job():return {'output':'','cancel':threading.Event(),'lock':threading.Lock(),'process':None}

class BuildLifecycleTests(unittest.TestCase):
    def test_stalled_status_client_cannot_block_timeout_cleanup(self):
        state=job();state.update(id='blocked-client',state='running',target='main.tex',result=None,steps=[])
        entered=threading.Event();release=threading.Event()
        handler=object.__new__(app.Handler);handler.path='/api/build?id=blocked-client'
        handler.allowed=lambda:True;handler.project=lambda:('project',Path('.'))
        state['project']='project'
        def blocked_send(payload,status=200):entered.set();release.wait(8)
        handler.send_json=blocked_send
        with patch.dict(app.JOBS,{'blocked-client':state}):
            client=threading.Thread(target=handler.do_GET,daemon=True);client.start()
            try:
                self.assertTrue(entered.wait(2))
                # This is the same lock the pipe-reader/timeout cleanup needs.
                self.assertTrue(state['lock'].acquire(timeout=.2))
                state['lock'].release()
                started=time.monotonic()
                with self.assertRaises(subprocess.TimeoutExpired):
                    app.streamed_command([sys.executable,'-c',"import time;print('biber',flush=True);time.sleep(60)"],None,.2,state)
                self.assertLess(time.monotonic()-started,5)
            finally:release.set();client.join(2)

    def test_post_responses_are_written_without_operation_locks(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);(root/'main.tex').write_text('source')
            scenarios=[('/api/delete',{'path':'main.tex'}),('/api/settings',{'target':'main.tex','options':{}}),
                       ('/api/save',{'path':'main.tex','version':'wrong','text':'draft'}),
                       ('/api/upload',{'path':'main.tex','content':''}),('/api/compile',{'target':'main.tex'})]
            for endpoint,payload in scenarios:
                with self.subTest(endpoint=endpoint):
                    handler=object.__new__(app.Handler);handler.path=endpoint
                    body=json.dumps(payload).encode();handler.rfile=io.BytesIO(body);handler.headers={'Content-Length':str(len(body))}
                    handler.allowed=lambda:True;handler.project=lambda:('project',root)
                    def write(payload,status=200):
                        for lock in [app.BUILD_LOCK,app.FILE_LOCK,app.PICKER_LOCK]:
                            self.assertTrue(lock.acquire(timeout=.2),'HTTP response retained an operation lock')
                            lock.release()
                    handler._write_json=write
                    with patch.object(app,'trash_operation',return_value={'ok':True}),patch.object(app.Handler,'compile',return_value={'ok':True,'target':'main.tex','diagnostics':[]}):handler.do_POST()

    @unittest.skipIf(sys.platform=='win32','SIGINT delivery to a subprocess differs on Windows; cleanup is tested separately')
    def test_server_ctrl_c_terminates_registered_compiler(self):
        with tempfile.TemporaryDirectory() as folder:
            marker=Path(folder)/'pid';source=Path(app.__file__).resolve()
            child='import os,time;from pathlib import Path;Path('+repr(str(marker))+').write_text(str(os.getpid()));time.sleep(60)'
            wrapper="import importlib.util,sys,threading;spec=importlib.util.spec_from_file_location('app',"+repr(str(source))+");a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a);job={'id':'shutdown-test','state':'running','output':'','lock':threading.Lock(),'cancel':threading.Event(),'process':None};job['thread']=threading.Thread(target=lambda:a.streamed_command([sys.executable,'-c',"+repr(child)+"],None,60,job),daemon=True);a.JOBS[job['id']]=job;job['thread'].start();sys.argv=['server.py','--port','0','--no-browser'];a.main()"
            server=subprocess.Popen([sys.executable,'-c',wrapper],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            pid=None
            try:
                for _ in range(50):
                    if marker.exists():break
                    time.sleep(.1)
                pid=int(marker.read_text());time.sleep(.2);server.send_signal(signal.SIGINT);server.wait(timeout=12)
                with self.assertRaises(ProcessLookupError):app.os.kill(pid,0)
            finally:
                if server.poll() is None:server.kill();server.wait()
                if pid:
                    try:app.os.killpg(pid,signal.SIGKILL)
                    except ProcessLookupError:pass

    def test_timeout_kills_compiler_and_child_and_can_run_again(self):
        with tempfile.TemporaryDirectory() as folder:
            marker=Path(folder)/'child-survived'
            child="import time;from pathlib import Path;time.sleep(1.5);Path("+repr(str(marker))+").write_text('alive');time.sleep(60)"
            code="import subprocess,sys,time;subprocess.Popen([sys.executable,'-c',"+repr(child)+"]);print('Running biber test.bcf',flush=True);time.sleep(60)"
            state=job();started=time.monotonic()
            with self.assertRaises(subprocess.TimeoutExpired) as caught:
                app.streamed_command([sys.executable,'-c',code],folder,.3,state)
            self.assertLess(time.monotonic()-started,12)
            self.assertIn('Running biber',caught.exception.output)
            self.assertIsNone(state['process'])
            time.sleep(1.6);self.assertFalse(marker.exists())
            result=app.streamed_command([sys.executable,'-c',"print('next build')"],folder,5,job())
            self.assertEqual(result.returncode,0);self.assertIn('next build',result.stdout)

    def test_cancel_returns_and_stdin_is_not_interactive(self):
        state=job();timer=threading.Timer(.3,state['cancel'].set);timer.start()
        try:
            started=time.monotonic()
            result=app.streamed_command([sys.executable,'-c',"import sys,time;print(repr(sys.stdin.read()),flush=True);time.sleep(60)"],None,30,state)
            self.assertLess(time.monotonic()-started,12)
            self.assertNotEqual(result.returncode,0);self.assertIn("''",result.stdout)
            self.assertIsNone(state['process'])
        finally:timer.cancel()

    def test_windows_taskkill_timeout_falls_back_to_kill(self):
        process=Mock(pid=123);process.poll.return_value=None
        with patch.object(app.os,'name','nt'),patch.object(app.subprocess,'run',side_effect=subprocess.TimeoutExpired('taskkill',5)) as run:
            notes=app.terminate_build({'process':process})
        self.assertEqual(run.call_args.kwargs['timeout'],5);process.kill.assert_called_once()
        self.assertTrue(any('process-tree cleanup failed' in note for note in notes))

    def test_large_output_bounded_and_utf8_split_decodes(self):
        code="import os,time;os.write(1,b'x'*500000);os.write(1,b'\\xe4');time.sleep(.1);os.write(1,b'\\xb8\\xad')"
        state=job();result=app.streamed_command([sys.executable,'-c',code],None,10,state)
        self.assertLessEqual(len(result.stdout),200000);self.assertLessEqual(len(state['output']),200000)
        self.assertTrue(result.stdout.endswith('中'));self.assertNotIn('�',result.stdout)

    def test_unreapable_process_waits_are_bounded(self):
        process=Mock(pid=123);process.poll.return_value=None
        process.wait.side_effect=subprocess.TimeoutExpired('compiler',5)
        process.stdout.read1.return_value=b''
        state=job();state['cancel'].set()
        with patch.object(app.subprocess,'Popen',return_value=process),patch.object(app,'terminate_build',return_value=[]):
            with self.assertRaisesRegex(RuntimeError,'could not be stopped'):
                app.streamed_command(['compiler'],None,1,state)
        self.assertTrue(all(call.kwargs['timeout']==5 for call in process.wait.call_args_list))
        self.assertIs(state['cleanupFailed'],process)
        self.assertIsNone(state['process'])

if __name__=='__main__':unittest.main()
