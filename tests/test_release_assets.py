# SPDX-License-Identifier: Apache-2.0
"""Keep public docs, bundled licenses and audited vendor bytes together."""
import hashlib
import json
from pathlib import Path
import re
import unittest
ROOT=Path(__file__).resolve().parents[1]
class ReleaseAssetsTests(unittest.TestCase):
    def test_vendor_manifest_and_licenses(self):
        manifest=json.loads((ROOT/'docs/vendor-manifest.json').read_text())
        self.assertEqual(manifest['version'],'4.10.38')
        actual={p.relative_to(ROOT/'web/vendor').as_posix():hashlib.sha256(p.read_bytes()).hexdigest()
                for p in (ROOT/'web/vendor').rglob('*') if p.is_file()}
        missing=set(manifest['files'])-set(actual);extra=set(actual)-set(manifest['files'])
        changed=sorted(name for name in set(actual)&set(manifest['files']) if actual[name]!=manifest['files'][name])
        self.assertFalse(missing or extra or changed,
            'Vendor bytes differ: missing='+str(sorted(missing))+', extra='+str(sorted(extra))+', changed='+str(changed)+
            '. Preserve web/vendor bytes with .gitattributes; do not normalize hashes.')
        for rel in ['LICENSE','NOTICE','THIRD_PARTY_NOTICES.md','web/vendor/LICENSE','web/vendor/cmaps/LICENSE',
                    'web/vendor/standard_fonts/LICENSE_FOXIT','web/vendor/standard_fonts/LICENSE_LIBERATION']:
            self.assertGreater((ROOT/rel).stat().st_size,100)
    def test_document_links_and_demo(self):
        for doc in [ROOT/'README.md',ROOT/'THIRD_PARTY_NOTICES.md',*list((ROOT/'docs').glob('*.md'))]:
            for target in re.findall(r'!?\[[^\]]*\]\(([^)]+)\)',doc.read_text()):
                if '://' in target or target.startswith('#'):continue
                self.assertTrue((doc.parent/target.split('#')[0]).exists(),str(doc)+': '+target)
        self.assertTrue((ROOT/'examples/demo/main.tex').exists())
        self.assertTrue((ROOT/'docs/images/workspace.png').exists())
if __name__=='__main__':unittest.main()
