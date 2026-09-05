"""Rebuild CHDSS icons using Pillow (development-only)."""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[1] / 'assets'
root.mkdir(exist_ok=True)
image = Image.new('RGBA', (1024, 1024))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((40, 40, 984, 984), radius=220, fill='#191b24', outline='#363a4e', width=8)
draw.rounded_rectangle((165, 225, 859, 708), radius=55, outline='#c6c5ed', width=22)
draw.line((420, 806, 604, 806), fill='#c6c5ed', width=24)
draw.line((512, 720, 512, 800), fill='#c6c5ed', width=24)
for x, height in [(328, 122), (450, 264), (572, 264), (694, 122)]:
    draw.rounded_rectangle((x-20, 470-height//2, x+20, 470+height//2), radius=20, fill='#a09bff')
image.save(root / 'icon.png')
image.save(root / 'icon.ico', sizes=[(16,16),(32,32),(48,48),(64,64),(128,128),(256,256)])
image.save(root / 'icon.icns')
print('Generated macOS, Windows, and PNG icons.')
