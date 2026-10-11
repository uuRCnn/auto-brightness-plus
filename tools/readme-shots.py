#!/usr/bin/env python3
"""Crop the screenshots of tools/readme-shots.js into docs/ (Quick Settings only).
   tools/readme-shots.py [build/shots]"""
import json
import os
import sys

from PIL import Image

src = sys.argv[1] if len(sys.argv) > 1 else 'build/shots'
docs = os.path.join(os.path.dirname(__file__), '..', 'docs')
rects = json.load(open(os.path.join(src, 'rects.json')))
for name, (x, y, w, h) in rects.items():
    pad = 6
    im = Image.open(os.path.join(src, f'{name}.png'))
    im.crop((x - pad, y - pad, x + w + pad, y + h + pad)).save(os.path.join(docs, f'{name}.png'), optimize=True)
    print(f'docs/{name}.png')
