# SPDX-License-Identifier: Apache-2.0
"""Backend lifecycle checks, plus real TeX/SyncTeX when installed."""
import importlib.util
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch
import subprocess

spec=importlib.util.spec_from_file_location('stable_app',Path(__file__).resolve().parents[1]/'server.py')
app=importlib.util.module_from_spec(spec);spec.loader.exec_module(app)

class SessionStabilityTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        app.RECENT_FILE=self.root/'recent.json';self.handler=object.__new__(app.Handler)
    def tearDown(self):self.temp.cleanup()
    def test_stale_pdf_rejected_and_quoted_reverse_input(self):
        pdf=self.root/'main.pdf';pdf.write_bytes(b'old PDF')
        folder=self.root/'chapters';folder.mkdir();source=folder/'part one.tex';source.write_text('source')
        old=app.pdf_version(pdf);pdf.write_bytes(b'new larger PDF')
        with patch.object(app.shutil,'which',return_value='synctex'):
            with self.assertRaises(ValueError) as caught:self.handler.sync(self.root,{'pdf':'main.pdf','pdfVersion':old,'page':1,'x':10,'y':10},False)
            self.assertEqual(caught.exception.code,'STALE_PDF')
            output='Input:"chapters/part one.tex"\nLine:1\nColumn:-1\n'
            with patch.object(app,'run_command',return_value=subprocess.CompletedProcess([],0,output)):
                match=self.handler.sync(self.root,{'pdf':'main.pdf','pdfVersion':app.pdf_version(pdf),'page':1,'x':10,'y':10},False)
                self.assertEqual(match,{'path':'chapters/part one.tex','line':1,'column':1})
            current=app.pdf_version(pdf)
            def replace_pdf(*args):
                pdf.write_bytes(b'changed during SyncTeX command')
                return subprocess.CompletedProcess([],0,output)
            with patch.object(app,'run_command',side_effect=replace_pdf),self.assertRaises(ValueError) as changed:
                self.handler.sync(self.root,{'pdf':'main.pdf','pdfVersion':current,'page':1,'x':10,'y':10},False)
            self.assertEqual(changed.exception.code,'STALE_PDF')
    @unittest.skipUnless(shutil.which('pdflatex') and shutil.which('synctex'),'Real TeX tools unavailable')
    def test_real_rebuilds_preserve_both_sync_directions(self):
        (self.root/'chapters').mkdir();chapter=self.root/'chapters'/'part one.tex'
        (self.root/'main.tex').write_text('\\documentclass{article}\n\\begin{document}\n\\input{chapters/part one.tex}\n\\end{document}\n')
        for cycle in range(3):
            chapter.write_text('\\section{Cycle '+str(cycle)+'}\nA synchronization target in an included file with spaces.\n')
            result=self.handler.compile(self.root,'main.tex',{'engine':'pdflatex','timeout':60},clean=cycle==1)
            self.assertTrue(result['ok'],result['output'])
            version=app.pdf_version(self.root/'main.pdf')
            point=self.handler.sync(self.root,{'pdf':'main.pdf','pdfVersion':version,'path':'chapters/part one.tex','line':2,'column':1},True)
            back=self.handler.sync(self.root,{'pdf':'main.pdf','pdfVersion':version,**point},False)
            self.assertEqual(back['path'],'chapters/part one.tex');self.assertGreaterEqual(back['line'],1)

if __name__=='__main__':unittest.main()
