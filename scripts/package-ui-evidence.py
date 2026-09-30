from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import json

root = Path(__file__).resolve().parents[1]
evidence = root / 'docs/evidence/ui-audit'
files = [root / 'docs/UI-PAGE-AUDIT.md']
files += sorted(evidence.glob('*-results.json'))
files += sorted(evidence.glob('figure*.png'))
files += sorted(evidence.glob('*-contact.jpg'))
for stage in ['before', 'after']:
    for viewport in ['desktop', 'mobile']:
        for theme in ['light', 'dark']:
            for page in ['_app_admin_ai', '_app_projects_fixture']:
                file = evidence / stage / f'{viewport}-{theme}-filled{page}.png'
                if file.exists():
                    files.append(file)
with ZipFile(evidence / 'ui-audit-delivery.zip', 'w', ZIP_DEFLATED) as archive:
    for file in files:
        archive.write(file, file.relative_to(root))
(evidence / 'curated-files.json').write_text(json.dumps([str(f.relative_to(root)).replace('\\', '/') for f in files], indent=2), encoding='utf-8')
print(f'Packaged {len(files)} files, {(evidence / "ui-audit-delivery.zip").stat().st_size} bytes')
