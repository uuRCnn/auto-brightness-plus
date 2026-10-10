#!/usr/bin/env python3
"""Design mockups (SVG -> PNG via rsvg-convert).
   tools/mockups.py <out-dir>"""
import os
import subprocess
import sys

OUT = sys.argv[1] if len(sys.argv) > 1 else 'tasarim'

W, H = 1000, 800          # logical size, rendered at 2x
FONT = "Adwaita Sans, Inter, Cantarell, sans-serif"

TEXT = '#f5f5f7'
SUB = '#98989f'
FAINT = '#6e6e75'
PANEL = '#1f1f22'
CARD = 'rgba(255,255,255,0.06)'
ACCENT = '#0a84ff'
NIGHT = '#ffb340'
RED = '#ff453a'


# ---------------------------------------------------------------- primitives
def t(x, y, s, size=13, color=TEXT, weight=400, anchor='start', mono=False):
    fam = 'Adwaita Mono, monospace' if mono else FONT
    s = s.replace('&', '&amp;').replace('<', '&lt;')
    return (f'<text x="{x}" y="{y}" font-family="{fam}" font-size="{size}" fill="{color}" '
            f'font-weight="{weight}" text-anchor="{anchor}">{s}</text>')


def rect(x, y, w, h, r, fill, stroke=None, sw=1, op=None):
    s = f' stroke="{stroke}" stroke-width="{sw}"' if stroke else ''
    o = f' opacity="{op}"' if op is not None else ''
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{fill}"{s}{o}/>'


def sun(cx, cy, r=5, color=TEXT, sw=1.6):
    out = [f'<circle cx="{cx}" cy="{cy}" r="{r * 0.62}" fill="none" stroke="{color}" stroke-width="{sw}"/>']
    import math
    for i in range(8):
        a = i * math.pi / 4
        x1, y1 = cx + math.cos(a) * r * 1.05, cy + math.sin(a) * r * 1.05
        x2, y2 = cx + math.cos(a) * r * 1.45, cy + math.sin(a) * r * 1.45
        out.append(f'<line x1="{x1:.2f}" y1="{y1:.2f}" x2="{x2:.2f}" y2="{y2:.2f}" stroke="{color}" '
                   f'stroke-width="{sw}" stroke-linecap="round"/>')
    return ''.join(out)


def moon(cx, cy, r=6, color=TEXT, fill=None):
    f = fill or color
    return (f'<path d="M{cx + r * 0.35},{cy - r} A{r},{r} 0 1 0 {cx + r},{cy + r * 0.35} '
            f'A{r * 0.78},{r * 0.78} 0 0 1 {cx + r * 0.35},{cy - r} Z" fill="{f}"/>')


def monitor(cx, cy, s=1, color=TEXT):
    return (f'<rect x="{cx - 8 * s}" y="{cy - 6.5 * s}" width="{16 * s}" height="{10.5 * s}" rx="{1.8 * s}" '
            f'fill="none" stroke="{color}" stroke-width="1.5"/>'
            f'<line x1="{cx - 3.5 * s}" y1="{cy + 7 * s}" x2="{cx + 3.5 * s}" y2="{cy + 7 * s}" stroke="{color}" '
            f'stroke-width="1.5" stroke-linecap="round"/>')


def laptop(cx, cy, color=TEXT):
    return (f'<rect x="{cx - 7}" y="{cy - 6}" width="14" height="9.5" rx="1.5" fill="none" stroke="{color}" stroke-width="1.5"/>'
            f'<line x1="{cx - 9.5}" y1="{cy + 6}" x2="{cx + 9.5}" y2="{cy + 6}" stroke="{color}" stroke-width="1.6" stroke-linecap="round"/>')


def chevron(cx, cy, color=SUB, d='right', s=4):
    if d == 'right':
        p = f'M{cx - s * 0.5},{cy - s} L{cx + s * 0.5},{cy} L{cx - s * 0.5},{cy + s}'
    elif d == 'down':
        p = f'M{cx - s},{cy - s * 0.5} L{cx},{cy + s * 0.5} L{cx + s},{cy - s * 0.5}'
    else:
        p = f'M{cx - s},{cy + s * 0.5} L{cx},{cy - s * 0.5} L{cx + s},{cy + s * 0.5}'
    return f'<path d="{p}" fill="none" stroke="{color}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>'


def gear(cx, cy, color=SUB):
    import math
    out = [f'<circle cx="{cx}" cy="{cy}" r="2.6" fill="none" stroke="{color}" stroke-width="1.5"/>',
           f'<circle cx="{cx}" cy="{cy}" r="5.6" fill="none" stroke="{color}" stroke-width="1.5" stroke-dasharray="2.2 2.2"/>']
    return ''.join(out)


def clock(cx, cy, r=6, color=SUB):
    return (f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="none" stroke="{color}" stroke-width="1.5"/>'
            f'<path d="M{cx},{cy - r * 0.55} L{cx},{cy} L{cx + r * 0.45},{cy + r * 0.3}" fill="none" stroke="{color}" '
            f'stroke-width="1.5" stroke-linecap="round"/>')


def switch(x, y, on, color=ACCENT):
    bg = color if on else 'rgba(255,255,255,0.16)'
    kx = x + 31 if on else x + 13
    return rect(x, y, 44, 26, 13, bg) + f'<circle cx="{kx}" cy="{y + 13}" r="11" fill="#fff"/>'


def toggle_bg():
    return ''


# Apple style thick slider: icon inside, white fill
def fat_slider(x, y, w, frac, icon='sun', h=30, fill='#f5f5f7', icon_color='#1d1d1f'):
    fw = max(h, w * frac)
    out = [rect(x, y, w, h, h / 2, 'rgba(255,255,255,0.13)'),
           rect(x, y, fw, h, h / 2, fill)]
    cx, cy = x + h / 2 + 1, y + h / 2
    if icon == 'sun':
        out.append(sun(cx, cy, 5.2, icon_color, 1.7))
    elif icon == 'moon':
        out.append(moon(cx, cy, 5.5, icon_color))
    return ''.join(out)


# GNOME style thin slider with knob
def thin_slider(x, y, w, frac, color='#f5f5f7'):
    k = x + w * frac
    return (rect(x, y - 2.5, w, 5, 2.5, 'rgba(255,255,255,0.16)') + rect(x, y - 2.5, k - x, 5, 2.5, color) +
            f'<circle cx="{k}" cy="{y}" r="10" fill="#fff"/>')


def chip(x, y, label, color=NIGHT, w=None, active=True, h=30):
    w = w or (40 + len(label) * 6.6)
    bg = 'rgba(255,179,64,0.14)' if active else 'rgba(255,255,255,0.08)'
    fg = color if active else SUB
    return (rect(x, y, w, h, h / 2, bg) + moon(x + 16, y + h / 2, 5.2, fg) +
            t(x + 28, y + h / 2 + 4.5, label, 12.5, fg, 600)), w


def wallpaper(night=False):
    a, b, c = ('#0b1a2a', '#1b2c4a', '#3a2350') if night else ('#12303a', '#1e3a5c', '#3b2b5c')
    return f'''<defs>
<radialGradient id="wp1" cx="25%" cy="85%" r="80%"><stop offset="0" stop-color="{a}"/><stop offset="1" stop-color="#0d0f17"/></radialGradient>
<radialGradient id="wp2" cx="85%" cy="40%" r="60%"><stop offset="0" stop-color="{c}" stop-opacity="0.75"/><stop offset="1" stop-color="{b}" stop-opacity="0"/></radialGradient>
<filter id="sh" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="#000" flood-opacity="0.5"/></filter>
</defs>
<rect width="{W}" height="{H}" fill="url(#wp1)"/><rect width="{W}" height="{H}" fill="url(#wp2)"/>'''


def topbar(active_icon=None, clock_text='10 Eki 21:14'):
    out = [rect(0, 0, W, 32, 0, '#000'),
           rect(12, 8, 44, 16, 8, 'rgba(255,255,255,0.16)'),
           '<circle cx="24" cy="16" r="3.2" fill="#fff"/><circle cx="35" cy="16" r="2.4" fill="#aaa"/><circle cx="44" cy="16" r="2.4" fill="#aaa"/>',
           t(W / 2, 21.5, clock_text, 13.5, TEXT, 700, 'middle')]
    # right side status icons
    x = W - 110
    if active_icon == 'own':
        out.append(rect(W - 166, 4, 36, 24, 12, 'rgba(255,255,255,0.18)'))
        out.append(sun(W - 148, 16, 5.2, TEXT, 1.6))
    if active_icon == 'qs':
        out.append(rect(x - 8, 4, 108, 24, 12, 'rgba(255,255,255,0.18)'))
    out.append(moon(x + 6, 16, 5.5, TEXT))
    out.append(f'<path d="M{x + 26},12 q6,-5 12,0 M{x + 28},15 q4,-3 8,0" fill="none" stroke="{TEXT}" stroke-width="1.6" stroke-linecap="round"/><circle cx="{x + 32}" cy="18.5" r="1.3" fill="{TEXT}"/>')
    out.append(f'<path d="M{x + 50},13 l4,0 l5,-4 l0,14 l-5,-4 l-4,0 Z" fill="{TEXT}"/>')
    out.append(f'<circle cx="{x + 78}" cy="16" r="6" fill="none" stroke="{TEXT}" stroke-width="1.6"/><line x1="{x + 78}" y1="9" x2="{x + 78}" y2="15" stroke="{TEXT}" stroke-width="1.6" stroke-linecap="round"/>')
    return ''.join(out)


def caption(title, desc, y=H - 52):
    return t(40, y, title, 22, TEXT, 800) + t(40, y + 28, desc, 13.5, SUB, 400)


def save(name, body):
    svg = f'<svg xmlns="http://www.w3.org/2000/svg" width="{W * 2}" height="{H * 2}" viewBox="0 0 {W} {H}">{body}</svg>'
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, name)
    with open(path + '.svg', 'w') as f:
        f.write(svg)
    subprocess.run(['rsvg-convert', '-o', path + '.png', path + '.svg'], check=True)
    os.remove(path + '.svg')
    print(path + '.png')


# ---------------------------------------------------------- quick settings
def qs_toggle(x, y, w, icon, title, sub=None, on=False, arrow=False, color=ACCENT):
    bg = color if on else 'rgba(255,255,255,0.10)'
    fg = '#fff' if on else TEXT
    out = [rect(x, y, w, 48, 24, bg)]
    ix = x + 24
    if icon == 'moon':
        out.append(moon(ix, y + 24, 6.5, fg))
    elif icon == 'wifi':
        out.append(f'<path d="M{ix - 8},{y + 21} q8,-8 16,0 M{ix - 5},{y + 25} q5,-5 10,0" fill="none" stroke="{fg}" stroke-width="1.8" stroke-linecap="round"/><circle cx="{ix}" cy="{y + 29}" r="1.6" fill="{fg}"/>')
    elif icon == 'bt':
        out.append(f'<path d="M{ix - 4},{y + 19} l8,8 l-4,4 l0,-14 l4,4 l-8,8" fill="none" stroke="{fg}" stroke-width="1.6" stroke-linejoin="round"/>')
    elif icon == 'power':
        out.append(f'<path d="M{ix - 3},{y + 17} l-4,8 l5,0 l-2,7 l8,-10 l-5,0 l3,-5 Z" fill="{fg}"/>')
    elif icon == 'dark':
        out.append(f'<circle cx="{ix}" cy="{y + 24}" r="7" fill="none" stroke="{fg}" stroke-width="1.6"/><path d="M{ix},{y + 17} a7,7 0 0 1 0,14 Z" fill="{fg}"/>')
    if sub:
        out.append(t(x + 44, y + 21, title, 13, fg, 700))
        out.append(t(x + 44, y + 37, sub, 11.5, 'rgba(255,255,255,0.75)' if on else SUB, 400))
    else:
        out.append(t(x + 44, y + 29, title, 13, fg, 700))
    if arrow:
        sep = 'rgba(255,255,255,0.35)' if on else 'rgba(255,255,255,0.12)'
        out.append(f'<line x1="{x + w - 40}" y1="{y + 12}" x2="{x + w - 40}" y2="{y + 36}" stroke="{sep}" stroke-width="1"/>')
        out.append(chevron(x + w - 20, y + 24, fg))
    return ''.join(out)


def qs_header(x, y, w):
    out = [rect(x, y, 36, 36, 18, 'rgba(255,255,255,0.10)'),
           f'<path d="M{x + 12},{y + 18} l4,0 M{x + 20},{y + 18} l4,0" stroke="{TEXT}" stroke-width="1.6"/>',
           t(x + 46, y + 23, '%86', 13, TEXT, 600)]
    for i, xx in enumerate([w - 120, w - 76, w - 32]):
        out.append(rect(x + xx, y, 36, 36, 18, 'rgba(255,255,255,0.10)'))
    out.append(f'<circle cx="{x + w - 102}" cy="{y + 18}" r="5" fill="none" stroke="{TEXT}" stroke-width="1.5"/>')
    out.append(f'<rect x="{x + w - 63}" y="{y + 12}" width="10" height="12" rx="2" fill="none" stroke="{TEXT}" stroke-width="1.5"/>')
    out.append(f'<circle cx="{x + w - 14}" cy="{y + 18}" r="6" fill="none" stroke="{TEXT}" stroke-width="1.5"/><line x1="{x + w - 14}" y1="{y + 11}" x2="{x + w - 14}" y2="{y + 17}" stroke="{TEXT}" stroke-width="1.5"/>')
    return ''.join(out)


def volume_row(x, y, w):
    return (f'<path d="M{x + 6},{y - 3} l3,0 l4,-3.5 l0,13 l-4,-3.5 l-3,0 Z" fill="{TEXT}"/>' +
            thin_slider(x + 32, y + 3, w - 72, 0.55) + rect(x + w - 30, y - 11, 30, 28, 14, 'rgba(255,255,255,0.08)') +
            chevron(x + w - 15, y + 3, TEXT))


# ============================================================ A: Quick Settings
def design_a():
    body = [wallpaper(True), topbar('qs')]
    px, py, pw = 560, 44, 410
    ph = 452
    body.append(f'<g filter="url(#sh)">{rect(px, py, pw, ph, 26, PANEL, "rgba(255,255,255,0.08)")}</g>')
    x0 = px + 16
    iw = pw - 32
    body.append(qs_header(x0, py + 16, iw))
    y = py + 80
    # monitor sliders (Brightness+)
    rows = [('monitor', 'LG ULTRAGEAR', 0.72, '%72', ('19:20', '%35')),
            ('monitor', 'ViewSonic VX3211', 0.52, '%52', ('19:20', '%30'))]
    for ic, name, frac, val, ch in rows:
        body.append(t(x0 + 2, y, name, 11.5, SUB, 600))
        y += 20
        body.append(fat_slider(x0, y, iw - 138, frac))
        body.append(t(x0 + iw - 94, y + 20, val, 12.5, TEXT, 600, 'end'))
        c, cw = chip(x0 + iw - 82, y, ch[0], w=82)
        body.append(c)
        y += 46
    y += 2
    body.append(volume_row(x0, y + 8, iw))
    y += 40
    # toggles grid
    cw = (iw - 12) / 2
    body.append(qs_toggle(x0, y, cw, 'wifi', 'Ev-5G', on=True, arrow=True))
    body.append(qs_toggle(x0 + cw + 12, y, cw, 'bt', 'Bluetooth', on=False, arrow=True))
    y += 60
    body.append(qs_toggle(x0, y, cw, 'power', 'Dengeli', on=False, arrow=True))
    body.append(qs_toggle(x0 + cw + 12, y, cw, 'moon', 'Gece Işığı', '19:12 – 06:48', on=True, arrow=True, color='#e8890c'))
    y += 60
    body.append(qs_toggle(x0, y, cw, 'dark', 'Koyu Stil', on=True))
    # annotation
    body.append(t(140, 180, 'GNOME menüsüne yerleşik', 15, TEXT, 700))
    body.append(t(140, 202, 'Her monitörün kendi slider’ı var.', 13, SUB))
    body.append(t(140, 222, 'Sağdaki ay çipine tıkla → o monitörün', 13, SUB))
    body.append(t(140, 242, 'akşam saatini ve hedef ışığını ayarla.', 13, SUB))
    body.append(t(140, 280, 'Çip: kararmanın başlayacağı saat.', 13, SUB))
    body.append(t(140, 300, 'Kararma sürerken turuncu, gündüz gri.', 13, SUB))
    body.append(caption('A · Hızlı Ayarlar (GNOME menüsünün içi)',
                        'Apple tarzı kalın slider’lar GNOME menüsünde, sağında zamanlama çipi. Ek simge yok, en sade entegrasyon.'))
    save('A_hizli_ayarlar', ''.join(body))


# ============================================================ B: single slider + submenu
def design_b():
    body = [wallpaper(True), topbar('qs')]
    px, py, pw = 560, 44, 410
    ph = 548
    body.append(f'<g filter="url(#sh)">{rect(px, py, pw, ph, 26, PANEL, "rgba(255,255,255,0.08)")}</g>')
    x0 = px + 16
    iw = pw - 32
    body.append(qs_header(x0, py + 16, iw))
    y = py + 74
    # one master slider + expand arrow
    body.append(fat_slider(x0, y, iw - 40, 0.62))
    body.append(rect(x0 + iw - 30, y, 30, 30, 15, 'rgba(255,255,255,0.14)') + chevron(x0 + iw - 15, y + 15, TEXT, 'up'))
    y += 44
    # expanded submenu card
    sub_h = 222
    body.append(rect(x0, y, iw, sub_h, 18, 'rgba(255,255,255,0.06)'))
    sx = x0 + 16
    body.append(sun(sx + 8, y + 24, 5, TEXT) + t(sx + 26, y + 29, 'Ekran Parlaklığı', 14, TEXT, 700))
    yy = y + 52
    for name, frac, val, ch in [('LG ULTRAGEAR', 0.72, '%72', '19:20'), ('ViewSonic VX3211', 0.52, '%52', '19:20')]:
        body.append(monitor(sx + 8, yy + 2, 0.85, SUB) + t(sx + 26, yy + 6, name, 12.5, TEXT, 600))
        body.append(t(x0 + iw - 16, yy + 6, val, 12, SUB, 600, 'end'))
        yy += 18
        body.append(thin_slider(sx + 2, yy + 13, iw - 32 - 100, frac))
        c, _ = chip(x0 + iw - 16 - 82, yy, ch, w=82, h=26)
        body.append(c)
        yy += 46
    body.append(f'<line x1="{sx}" y1="{yy - 4}" x2="{x0 + iw - 16}" y2="{yy - 4}" stroke="rgba(255,255,255,0.07)"/>')
    body.append(gear(sx + 8, yy + 14) + t(sx + 26, yy + 19, 'Brightness+ Ayarları', 12.5, SUB, 500))
    y += sub_h + 14
    body.append(volume_row(x0, y + 8, iw))
    y += 40
    cw = (iw - 12) / 2
    body.append(qs_toggle(x0, y, cw, 'wifi', 'Ev-5G', on=True, arrow=True))
    body.append(qs_toggle(x0 + cw + 12, y, cw, 'bt', 'Bluetooth', on=False, arrow=True))
    y += 60
    body.append(qs_toggle(x0, y, cw, 'power', 'Dengeli', on=False, arrow=True))
    body.append(qs_toggle(x0 + cw + 12, y, cw, 'moon', 'Gece Işığı', '19:12 – 06:48', on=True, arrow=True, color='#e8890c'))
    body.append(t(140, 180, 'Tek ana slider, detaylar içeride', 15, TEXT, 700))
    body.append(t(140, 202, 'Ana slider tüm monitörleri birlikte', 13, SUB))
    body.append(t(140, 222, 'oransal olarak değiştirir.', 13, SUB))
    body.append(t(140, 250, 'Ok ile açılan kartta her monitörün', 13, SUB))
    body.append(t(140, 270, 'ince slider’ı + sağında ay çipi.', 13, SUB))
    body.append(caption('B · Tek slider + açılır kart',
                        'Menü kapalıyken sadece bir slider yer kaplar. GNOME’un kendi parlaklık menüsü gibi davranır.'))
    save('B_tek_slider_acilir', ''.join(body))


# ============================================================ C: own indicator, control center card
def design_c():
    body = [wallpaper(True), topbar('own')]
    pw = 340
    px, py = W - 166 + 18 - pw + 40, 44
    ph = 304
    body.append(f'<g filter="url(#sh)">{rect(px, py, pw, ph, 24, PANEL, "rgba(255,255,255,0.08)")}</g>')
    x0, iw = px + 18, pw - 36
    y = py + 22
    body.append(t(x0, y + 12, 'Ekranlar', 17, TEXT, 800))
    body.append(rect(x0 + iw - 30, y - 6, 30, 30, 15, 'rgba(255,255,255,0.08)') + gear(x0 + iw - 15, y + 9))
    y += 42
    for name, frac, val, ch in [('LG ULTRAGEAR', 0.72, '%72', '19:20'), ('ViewSonic VX3211', 0.52, '%52', '19:20')]:
        body.append(rect(x0, y, iw, 86, 16, CARD))
        body.append(monitor(x0 + 22, y + 22, 0.9, TEXT) + t(x0 + 40, y + 27, name, 13, TEXT, 700))
        body.append(t(x0 + iw - 14, y + 27, val, 13, SUB, 600, 'end'))
        body.append(fat_slider(x0 + 12, y + 44, iw - 24 - 92, frac, h=28))
        c, _ = chip(x0 + iw - 12 - 84, y + 43, ch, w=84)
        body.append(c)
        y += 98
    # schedule summary
    body.append(rect(x0, y, iw, 54, 16, CARD))
    body.append(f'<circle cx="{x0 + 24}" cy="{y + 27}" r="13" fill="rgba(255,179,64,0.16)"/>' + moon(x0 + 24, y + 27, 6, NIGHT))
    body.append(t(x0 + 46, y + 23, 'Akşam modu', 13, TEXT, 700))
    body.append(t(x0 + 46, y + 40, 'Gün batımı 18:52 · 19:20’de başlar', 11.5, SUB))
    body.append(switch(x0 + iw - 56, y + 14, True, NIGHT))
    body.append(t(70, 180, 'Kendi simgesi, Kontrol Merkezi kartı', 15, TEXT, 700))
    body.append(t(70, 202, 'Üst barda ayrı ☀ simgesi. Tıklayınca', 13, SUB))
    body.append(t(70, 222, 'macOS Kontrol Merkezi gibi kartlar.', 13, SUB))
    body.append(t(70, 250, 'Altta akşam modu tek dokunuşla', 13, SUB))
    body.append(t(70, 270, 'açılıp kapanır.', 13, SUB))
    body.append(caption('C · Ayrı simge + Kontrol Merkezi kartı',
                        'GNOME menüsüne dokunmaz; tüm parlaklık işleri tek bir şık pencerede. En “Apple” görünen seçenek.'))
    save('C_kontrol_merkezi', ''.join(body))


# ============================================================ D: schedule popover (chip click)
def schedule_card(x, y, w, compact=False):
    out = []
    h = 296
    out.append(f'<g filter="url(#sh)">{rect(x, y, w, h, 20, "#2a2a2e", "rgba(255,255,255,0.09)")}</g>')
    xi, iw = x + 18, w - 36
    yy = y + 30
    out.append(monitor(xi + 8, yy - 4, 0.9, TEXT) + t(xi + 26, yy + 1, 'LG ULTRAGEAR · Akşam', 14, TEXT, 700))
    out.append(switch(xi + iw - 44, yy - 17, True, NIGHT))
    yy += 26
    # segmented control
    out.append(rect(xi, yy, iw, 32, 10, 'rgba(255,255,255,0.08)'))
    out.append(rect(xi + 3, yy + 3, iw / 2 - 3, 26, 8, 'rgba(255,255,255,0.18)'))
    out.append(t(xi + iw / 4, yy + 21, 'Gün batımı', 12.5, TEXT, 700, 'middle'))
    out.append(t(xi + iw * 3 / 4, yy + 21, 'Sabit saat', 12.5, SUB, 600, 'middle'))
    yy += 50
    # offset stepper
    out.append(t(xi, yy + 5, 'Başlangıç', 13, TEXT, 600))
    out.append(t(xi, yy + 22, 'Gün batımı 18:52  +28 dk', 11.5, SUB))
    bx = xi + iw - 118
    out.append(rect(bx, yy - 12, 118, 34, 17, 'rgba(255,255,255,0.08)'))
    out.append(t(bx + 18, yy + 10, '−', 18, TEXT, 500, 'middle') + t(bx + 59, yy + 9, '19:20', 13.5, NIGHT, 700, 'middle') +
               t(bx + 100, yy + 10, '+', 17, TEXT, 500, 'middle'))
    yy += 48
    out.append(t(xi, yy + 5, 'Geçiş süresi', 13, TEXT, 600))
    bx = xi + iw - 118
    out.append(rect(bx, yy - 12, 118, 34, 17, 'rgba(255,255,255,0.08)'))
    out.append(t(bx + 18, yy + 10, '−', 18, TEXT, 500, 'middle') + t(bx + 59, yy + 9, '45 dk', 13.5, TEXT, 700, 'middle') +
               t(bx + 100, yy + 10, '+', 17, TEXT, 500, 'middle'))
    yy += 40
    out.append(t(xi, yy + 5, 'Gece ışığı', 13, TEXT, 600))
    out.append(t(xi + iw, yy + 5, '%35', 13, NIGHT, 700, 'end'))
    yy += 18
    out.append(fat_slider(xi, yy, iw, 0.35, icon='moon', h=28, fill=NIGHT, icon_color='#2a1a00'))
    yy += 46
    # mini timeline
    out.append(rect(xi, yy, iw, 6, 3, 'rgba(255,255,255,0.10)'))
    out.append(f'<defs><linearGradient id="tl" x1="0" x2="1"><stop offset="0" stop-color="#f5f5f7"/><stop offset="1" stop-color="{NIGHT}"/></linearGradient></defs>')
    out.append(rect(xi + iw * 0.55, yy, iw * 0.2, 6, 3, 'url(#tl)'))
    out.append(t(xi + iw * 0.55, yy + 22, '19:20', 10.5, SUB, 600, 'middle') + t(xi + iw * 0.75, yy + 22, '20:05', 10.5, SUB, 600, 'middle'))
    out.append(t(xi, yy + 22, '%72', 10.5, FAINT, 600) + t(xi + iw, yy + 22, '%35', 10.5, NIGHT, 600, 'end'))
    return ''.join(out)


def design_d():
    body = [wallpaper(True), topbar('qs')]
    # left: popover from chip (D1)
    body.append(t(60, 80, 'D1 · Çipe tıklayınca açılan küçük kart', 15, TEXT, 700))
    body.append(t(60, 100, 'Slider’ın sağındaki çip → yerinde açılır, dışarı tıklayınca kapanır.', 12.5, SUB))
    body.append(schedule_card(60, 130, 400))
    # right: inline expand (D2)
    body.append(t(540, 80, 'D2 · Menü içinde aşağı açılan bölüm', 15, TEXT, 700))
    body.append(t(540, 100, 'Çip tıklanınca slider’ın altında genişler, menü uzar.', 12.5, SUB))
    x0, iw = 540, 400
    body.append(f'<g filter="url(#sh)">{rect(x0, 130, iw, 380, 24, PANEL, "rgba(255,255,255,0.08)")}</g>')
    xi, w2 = x0 + 16, iw - 32
    y = 152
    body.append(t(xi + 2, y, 'LG ULTRAGEAR', 11.5, SUB, 600))
    y += 20
    body.append(fat_slider(xi, y, w2 - 138, 0.72))
    body.append(t(xi + w2 - 94, y + 20, '%72', 12.5, TEXT, 600, 'end'))
    c, _ = chip(xi + w2 - 82, y, '19:20', w=82)
    body.append(c.replace('rgba(255,179,64,0.14)', 'rgba(255,179,64,0.30)'))
    y += 42
    body.append(rect(xi, y, w2, 212, 16, CARD))
    yy = y + 20
    body.append(rect(xi + 12, yy - 8, w2 - 24, 28, 9, 'rgba(255,255,255,0.08)') + rect(xi + 15, yy - 5, (w2 - 24) / 2 - 3, 22, 7, 'rgba(255,255,255,0.18)'))
    body.append(t(xi + 12 + (w2 - 24) / 4, yy + 10, 'Gün batımı', 12, TEXT, 700, 'middle') + t(xi + 12 + (w2 - 24) * 3 / 4, yy + 10, 'Sabit saat', 12, SUB, 600, 'middle'))
    yy += 44
    for label, val, col in [('Başlangıç (18:52 +28 dk)', '19:20', NIGHT), ('Geçiş süresi', '45 dk', TEXT)]:
        body.append(t(xi + 14, yy + 4, label, 12.5, TEXT, 600))
        bx = xi + w2 - 14 - 108
        body.append(rect(bx, yy - 12, 108, 30, 15, 'rgba(255,255,255,0.08)'))
        body.append(t(bx + 16, yy + 8, '−', 17, TEXT, 500, 'middle') + t(bx + 54, yy + 7, val, 13, col, 700, 'middle') + t(bx + 92, yy + 8, '+', 16, TEXT, 500, 'middle'))
        yy += 40
    body.append(t(xi + 14, yy + 4, 'Gece ışığı', 12.5, TEXT, 600) + t(xi + w2 - 14, yy + 4, '%35', 12.5, NIGHT, 700, 'end'))
    yy += 16
    body.append(fat_slider(xi + 14, yy, w2 - 28, 0.35, icon='moon', h=26, fill=NIGHT, icon_color='#2a1a00'))
    y += 226
    body.append(t(xi + 2, y, 'ViewSonic VX3211', 11.5, SUB, 600))
    y += 20
    body.append(fat_slider(xi, y, w2 - 138, 0.52))
    body.append(t(xi + w2 - 94, y + 20, '%52', 12.5, TEXT, 600, 'end'))
    c, _ = chip(xi + w2 - 82, y, '19:20', w=82)
    body.append(c)
    body.append(caption('D · Zamanlama ayarı nasıl açılsın?',
                        'İki seçenek de aynı ayarları içerir: gün batımı ± dakika veya sabit saat, geçiş süresi ve gece parlaklığı.'))
    save('D_zamanlama_karti', ''.join(body))


# ============================================================ N: Night light menu
def design_n():
    body = [wallpaper(True), topbar('qs')]
    # left: closed toggle detail
    px, py, pw = 520, 44, 440
    ph = 432
    body.append(f'<g filter="url(#sh)">{rect(px, py, pw, ph, 26, PANEL, "rgba(255,255,255,0.08)")}</g>')
    x0, iw = px + 16, pw - 32
    y = py + 18
    # header of opened submenu
    body.append(f'<circle cx="{x0 + 24}" cy="{y + 22}" r="20" fill="#e8890c"/>' + moon(x0 + 24, y + 22, 8, '#fff'))
    body.append(t(x0 + 56, y + 18, 'Gece Işığı', 17, TEXT, 800))
    body.append(t(x0 + 56, y + 37, 'Açık · 06:48’e kadar', 12, SUB))
    body.append(switch(x0 + iw - 48, y + 9, True, '#e8890c'))
    y += 74
    body.append(t(x0 + 4, y, 'Renk sıcaklığı', 12.5, SUB, 600) + t(x0 + iw - 4, y, '2700 K', 12.5, SUB, 600, 'end'))
    y += 14
    body.append(f'<defs><linearGradient id="temp" x1="0" x2="1"><stop offset="0" stop-color="#ff8a2a"/><stop offset="1" stop-color="#fff3df"/></linearGradient></defs>')
    body.append(rect(x0, y, iw, 28, 14, 'url(#temp)') + f'<circle cx="{x0 + iw * 0.35}" cy="{y + 14}" r="11" fill="#fff" stroke="rgba(0,0,0,0.25)"/>')
    y += 46
    body.append(f'<line x1="{x0}" y1="{y}" x2="{x0 + iw}" y2="{y}" stroke="rgba(255,255,255,0.07)"/>')
    y += 14
    # red mode row
    body.append(rect(x0, y, iw, 64, 16, CARD))
    body.append(f'<circle cx="{x0 + 26}" cy="{y + 32}" r="15" fill="{RED}"/>')
    body.append(t(x0 + 52, y + 28, 'Kırmızı ekran', 14, TEXT, 700))
    body.append(t(x0 + 52, y + 46, 'Tüm mavi ve yeşil ışığı keser · uyku dostu', 11.5, SUB))
    body.append(switch(x0 + iw - 58, y + 19, False, RED))
    y += 76
    # soft dim row
    body.append(rect(x0, y, iw, 108, 16, CARD))
    body.append(f'<circle cx="{x0 + 26}" cy="{y + 32}" r="15" fill="rgba(255,255,255,0.12)"/>' + moon(x0 + 26, y + 32, 6.5, TEXT))
    body.append(t(x0 + 52, y + 28, 'Ekstra karartma', 14, TEXT, 700))
    body.append(t(x0 + 52, y + 46, 'Monitör en düşükteyken daha da karart (yazılımsal)', 11.5, SUB))
    body.append(switch(x0 + iw - 58, y + 19, True, ACCENT))
    body.append(fat_slider(x0 + 16, y + 66, iw - 32 - 46, 0.6, icon='moon', h=26))
    body.append(t(x0 + iw - 16, y + 84, '%60', 12.5, TEXT, 600, 'end'))
    y += 120
    body.append(t(x0 + 6, y + 12, 'ⓘ  Ekstra karartma görüntü kalitesini düşürebilir; yalnızca', 11.5, FAINT))
    body.append(t(x0 + 24, y + 28, 'monitör ışığı yetmediğinde kullan. Varsayılan: kapalı.', 11.5, FAINT))
    # left notes
    body.append(t(60, 140, 'Gece Işığı düğmesi menülü olur', 15, TEXT, 700))
    body.append(t(60, 162, 'GNOME’un kendi “Gece Işığı” düğmesine', 13, SUB))
    body.append(t(60, 182, 'ok (›) eklenir. Tıklayınca bu sayfa açılır:', 13, SUB))
    body.append(t(60, 210, '• Sıcaklık slider’ı (sarı ↔ turuncu)', 13, SUB))
    body.append(t(60, 230, '• Kırmızı ekran (ekstra, kapalı gelir)', 13, SUB))
    body.append(t(60, 250, '• Ekstra karartma (ekstra, kapalı gelir)', 13, SUB))
    # mini closed toggle
    body.append(t(60, 300, 'Kapalı hâli (Hızlı Ayarlar’da):', 12.5, FAINT, 600))
    body.append(qs_toggle(60, 312, 200, 'moon', 'Gece Işığı', '19:12 – 06:48', on=True, arrow=True, color='#e8890c'))
    body.append(qs_toggle(60, 372, 200, 'moon', 'Gece Işığı', 'Kırmızı ekran', on=True, arrow=True, color=RED))
    body.append(caption('N · Gece Işığı + Kırmızı ekran + Ekstra karartma',
                        'İki ekstra seçenek GNOME’un Gece Işığı menüsünde durur; ikisi de varsayılan olarak kapalıdır.'))
    save('N_gece_isigi_menusu', ''.join(body))


if __name__ == '__main__':
    design_a()
    design_b()
    design_c()
    design_d()
    design_n()
