from pathlib import Path
from PIL import Image, ImageOps, ImageDraw
import sys

root = Path(sys.argv[1])
for stage in ['before', 'after']:
    for viewport in ['desktop', 'mobile']:
        for theme in ['light', 'dark']:
            paths = sorted((root / stage).glob(f'{viewport}-{theme}-filled*.png'))
            if not paths:
                continue
            width, height = (460, 420) if viewport == 'desktop' else (300, 620)
            cols = 4
            sheet = Image.new('RGB', (cols * width, ((len(paths) + cols - 1) // cols) * height), '#dee4ed')
            draw = ImageDraw.Draw(sheet)
            for n, path in enumerate(paths):
                image = Image.open(path).convert('RGB')
                image.thumbnail((width - 12, height - 36))
                x, y = (n % cols) * width, (n // cols) * height
                sheet.paste(image, (x + 6, y + 30))
                draw.text((x + 6, y + 6), path.stem.replace(f'{viewport}-{theme}-filled_', ''), fill='black')
            sheet.save(root / f'{stage}-{viewport}-{theme}-contact.jpg', quality=90)
