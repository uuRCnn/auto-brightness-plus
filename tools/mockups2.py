#!/usr/bin/env python3
"""Round 2 mockups: native-looking thin sliders.
   tools/mockups2.py <out-dir>"""
import sys

import mockups as m
from mockups import t, rect, moon, chevron, switch, TEXT, SUB, FAINT, W

m.OUT = sys.argv[1] if len(sys.argv) > 1 else 'tasarim/2-sade'
QS = '#242428'
BTN = 'rgba(255,255,255,0.10)'
ORANGE = '#e8890c'
NIGHTC = '#ffb340'
RED = '#ff453a'

PX, PW = 590, 380
X0, IW = PX + 14, PW - 28


def panel(h):
    return f'<g filter="url(#sh)">{rect(PX, 44, PW, h, 24, QS, "rgba(255,255,255,0.08)")}</g>'


def header(y):
    out = [rect(X0, y, 74, 34, 17, BTN),
           f'<rect x="{X0 + 12}" y="{y + 11}" width="20" height="12" rx="3" fill="none" stroke="{TEXT}" stroke-width="1.5"/>',
           f'<rect x="{X0 + 14}" y="{y + 13}" width="12" height="8" rx="1.5" fill="{TEXT}"/>',
           t(X0 + 40, y + 22, '%86', 12.5, TEXT, 600)]
    for i in range(3):
        cx = X0 + IW - 17 - i * 44
        out.append(rect(cx - 17, y, 34, 34, 17, BTN))
    cx = X0 + IW - 17
    out.append(f'<circle cx="{cx}" cy="{y + 17}" r="6" fill="none" stroke="{TEXT}" stroke-width="1.5"/>'
               f'<line x1="{cx}" y1="{y + 10}" x2="{cx}" y2="{y + 16}" stroke="{TEXT}" stroke-width="1.5" stroke-linecap="round"/>')
    cx -= 44
    out.append(f'<rect x="{cx - 5}" y="{y + 15}" width="10" height="8" rx="1.5" fill="none" stroke="{TEXT}" stroke-width="1.5"/>'
               f'<path d="M{cx - 3},{y + 15} v-3 a3,3 0 0 1 6,0 v3" fill="none" stroke="{TEXT}" stroke-width="1.5"/>')
    cx -= 44
    out.append(f'<circle cx="{cx}" cy="{y + 17}" r="2.4" fill="none" stroke="{TEXT}" stroke-width="1.5"/>'
               f'<circle cx="{cx}" cy="{y + 17}" r="6" fill="none" stroke="{TEXT}" stroke-width="1.5" stroke-dasharray="2.4 2.2"/>')
    return ''.join(out)


def slider(x, y, w, frac, accent=TEXT):
    k = x + 10 + (w - 20) * frac
    return (rect(x + 10, y - 2, w - 20, 4, 2, 'rgba(255,255,255,0.16)') + rect(x + 10, y - 2, k - x - 10, 4, 2, accent) +
            f'<circle cx="{k}" cy="{y}" r="9" fill="#fff"/>')


def round_btn(cx, cy, inner, active=False, bg=None):
    b = bg or ('rgba(255,179,64,0.16)' if active else 'transparent')
    return f'<circle cx="{cx}" cy="{cy}" r="16" fill="{b}"/>' + inner


def badge(cx, cy, label):
    if len(label) == 1:
        return (f'<circle cx="{cx}" cy="{cy}" r="12" fill="none" stroke="rgba(255,255,255,0.55)" stroke-width="1.4"/>' +
                t(cx, cy + 4.5, label, 12, TEXT, 700, 'middle'))
    return t(cx, cy + 4.5, label, 12, TEXT, 700, 'middle')


def volume_row(y):
    x = X0
    return (f'<path d="M{x + 10},{y - 3} l3,0 l4,-3.5 l0,13 l-4,-3.5 l-3,0 Z" fill="{TEXT}"/>'
            f'<path d="M{x + 21},{y - 3} q3,3 0,6" fill="none" stroke="{TEXT}" stroke-width="1.4" stroke-linecap="round"/>' +
            slider(x + 30, y + 3, IW - 66, 0.55) +
            round_btn(x + IW - 17, y + 3, chevron(x + IW - 17, y + 3, TEXT), bg=BTN))


def brightness_rows(y, labels, values, active=(True, True), hover=None, open_idx=None):
    out = []
    for i, (lab, v) in enumerate(zip(labels, values)):
        cy = y + 3
        out.append(badge(X0 + 16, cy, lab))
        out.append(slider(X0 + 30, cy, IW - 66, v))
        mc = NIGHTC if active[i] else SUB
        bg = 'rgba(255,179,64,0.30)' if open_idx == i else ('rgba(255,179,64,0.14)' if active[i] else 'transparent')
        out.append(round_btn(X0 + IW - 17, cy, moon(X0 + IW - 17, cy, 5.8, mc), bg=bg))
        if hover == i:
            kx = X0 + 40 + (IW - 86) * v
            tw = 150
            out.append(rect(kx - tw / 2, cy - 44, tw, 26, 9, 'rgba(0,0,0,0.85)', 'rgba(255,255,255,0.10)'))
            out.append(t(kx, cy - 26.5, f'{["LG ULTRAGEAR", "ViewSonic VX3211"][i]} · %{round(v * 100)}', 11.5, TEXT, 600, 'middle'))
        y += 44
    return ''.join(out), y


def toggle(x, y, w, title, sub=None, on=False, color='#3584e4', icon='wifi', arrow=True):
    bg = color if on else 'rgba(255,255,255,0.10)'
    fg = '#fff'
    out = [rect(x, y, w, 46, 23, bg)]
    ix, iy = x + 23, y + 23
    if icon == 'moon':
        out.append(moon(ix, iy, 6.2, fg))
    elif icon == 'wifi':
        out.append(f'<path d="M{ix - 8},{iy - 2} q8,-8 16,0 M{ix - 5},{iy + 2} q5,-5 10,0" fill="none" stroke="{fg}" stroke-width="1.8" stroke-linecap="round"/><circle cx="{ix}" cy="{iy + 6}" r="1.6" fill="{fg}"/>')
    elif icon == 'bt':
        out.append(f'<path d="M{ix - 4},{iy - 4} l8,8 l-4,4 l0,-16 l4,4 l-8,8" fill="none" stroke="{fg}" stroke-width="1.6" stroke-linejoin="round"/>')
    elif icon == 'power':
        out.append(f'<path d="M{ix - 2},{iy - 7} l-4,8 l5,0 l-2,7 l8,-10 l-5,0 l3,-5 Z" fill="{fg}"/>')
    elif icon == 'dark':
        out.append(f'<circle cx="{ix}" cy="{iy}" r="7" fill="none" stroke="{fg}" stroke-width="1.6"/><path d="M{ix},{iy - 7} a7,7 0 0 1 0,14 Z" fill="{fg}"/>')
    if sub:
        out.append(t(x + 42, y + 20, title, 12.5, fg, 700) + t(x + 42, y + 35, sub, 11, 'rgba(255,255,255,0.78)'))
    else:
        out.append(t(x + 42, y + 27.5, title, 12.5, fg, 700))
    if arrow:
        out.append(f'<line x1="{x + w - 38}" y1="{y + 12}" x2="{x + w - 38}" y2="{y + 34}" stroke="rgba(255,255,255,0.25)"/>')
        out.append(chevron(x + w - 19, y + 23, fg))
    return ''.join(out)


def toggles(y, night_sub='19:12 – 06:48', night_color=ORANGE):
    cw = (IW - 10) / 2
    out = [toggle(X0, y, cw, 'Ev-5G', on=True, icon='wifi'),
           toggle(X0 + cw + 10, y, cw, 'Bluetooth', icon='bt'),
           toggle(X0, y + 56, cw, 'Dengeli', icon='power'),
           toggle(X0 + cw + 10, y + 56, cw, 'Gece Işığı', night_sub, on=True, color=night_color, icon='moon')]
    return ''.join(out), y + 102


def submenu(y, h):
    return rect(X0, y, IW, h, 18, 'rgba(255,255,255,0.07)')


def sub_header(y, title, subtitle, color, on=True):
    return (f'<circle cx="{X0 + 30}" cy="{y + 26}" r="16" fill="{color}"/>' + moon(X0 + 30, y + 26, 6.5, '#fff') +
            t(X0 + 56, y + 22, title, 14, TEXT, 800) + t(X0 + 56, y + 39, subtitle, 11.5, SUB))


def note(lines, y0=170):
    out = []
    y = y0
    for i, line in enumerate(lines):
        out.append(t(70, y, line, 15 if i == 0 else 13, TEXT if i == 0 else SUB, 700 if i == 0 else 400))
        y += 30 if i == 0 else 21
    return ''.join(out)


# ------------------------------------------------------------------ R1 / R2
def r_rows(name, labels, title, desc, lines):
    body = [m.wallpaper(True), m.topbar('qs')]
    rows, y_end = brightness_rows(44 + 76, labels, [0.72, 0.52], hover=0)
    tg, y2 = toggles(y_end + 44)
    body.append(panel(y2 - 44 + 18))
    body.append(header(44 + 16))
    body.append(rows)
    body.append(volume_row(y_end))
    body.append(tg)
    body.append(note(lines))
    body.append(m.caption(title, desc))
    m.save(name, ''.join(body))


# ------------------------------------------------------------------ R3 schedule open
def r_schedule():
    body = [m.wallpaper(True), m.topbar('qs')]
    y = 44 + 76
    rows1, y = brightness_rows(y, ['1'], [0.72], open_idx=0)
    sh = 168
    sub = [submenu(y - 10, sh), sub_header(y - 10, 'Akşam kararması', 'LG ULTRAGEAR', ORANGE),
           switch(X0 + IW - 58, y + 3, True, ORANGE)]
    yy = y - 10 + 70
    sub.append(t(X0 + 16, yy + 4, 'Başlangıç', 13, TEXT, 600) + t(X0 + 16, yy + 21, 'Gün batımı 18:50 + 30 dk', 11, SUB))
    bx = X0 + IW - 16 - 112
    sub.append(f'<circle cx="{bx + 14}" cy="{yy + 6}" r="14" fill="{BTN}"/>' + t(bx + 14, yy + 11, '−', 16, TEXT, 500, 'middle'))
    sub.append(t(bx + 56, yy + 11, '19:20', 14, NIGHTC, 700, 'middle'))
    sub.append(f'<circle cx="{bx + 98}" cy="{yy + 6}" r="14" fill="{BTN}"/>' + t(bx + 98, yy + 11, '+', 16, TEXT, 500, 'middle'))
    yy += 44
    sub.append(t(X0 + 16, yy + 4, 'Gece parlaklığı', 13, TEXT, 600) + t(X0 + IW - 16, yy + 4, '%35', 13, NIGHTC, 700, 'end'))
    sub.append(slider(X0 + 6, yy + 26, IW - 12, 0.35, NIGHTC))
    body_rows = [rows1, ''.join(sub)]
    y = y - 10 + sh + 26
    rows2, y = brightness_rows(y, ['2'], [0.52])
    body_rows.append(rows2.replace('>1<', '>2<'))
    tg, y2 = toggles(y + 44)
    body.append(panel(y2 - 44 + 18))
    body.append(header(44 + 16))
    body += body_rows
    body.append(volume_row(y))
    body.append(tg)
    body.append(note(['Aya tıklayınca altında açılır',
                      'GNOME’un kendi menüleri gibi yerinde açılır.',
                      'Sadece 3 şey: aç/kapa, başlangıç saati,',
                      'gece parlaklığı. Gerisi Ayarlar penceresinde.',
                      '',
                      'Ay turuncu: akşam kararması açık.',
                      'Ay gri: kapalı.']))
    body.append(m.caption('3 · Ay simgesi → Akşam kararması',
                          'Gün batımına göre (± dakika) yavaş yavaş iner; sabah aynı şekilde geri döner.'))
    m.save('3_aksam_kararmasi', ''.join(body))


# ------------------------------------------------------------------ R4 night light
def r_night():
    body = [m.wallpaper(True), m.topbar('qs')]
    y = 44 + 76
    rows, y = brightness_rows(y, ['1', '2'], [0.72, 0.52])
    tg_y = y + 44
    tg, _ = toggles(tg_y)
    sy = tg_y + 112
    sh = 200
    sub = [submenu(sy, sh), sub_header(sy, 'Gece Işığı', '06:48’e kadar açık', ORANGE)]
    yy = sy + 66
    sub.append(t(X0 + 16, yy + 4, 'Sıcaklık', 13, TEXT, 600))
    sub.append(slider(X0 + 6, yy + 24, IW - 12, 0.38, '#ffa040'))
    yy += 50
    sub.append(f'<line x1="{X0 + 16}" y1="{yy - 6}" x2="{X0 + IW - 16}" y2="{yy - 6}" stroke="rgba(255,255,255,0.07)"/>')
    sub.append(f'<circle cx="{X0 + 24}" cy="{yy + 12}" r="6" fill="{RED}"/>' + t(X0 + 40, yy + 17, 'Kırmızı ekran', 13, TEXT, 600))
    sub.append(switch(X0 + IW - 60, yy - 1, False, RED))
    yy += 40
    sub.append(moon(X0 + 24, yy + 12, 6, SUB) + t(X0 + 40, yy + 17, 'Ekstra karartma', 13, TEXT, 600))
    sub.append(switch(X0 + IW - 60, yy - 1, False))
    body.append(panel(sy + sh + 16 - 44))
    body.append(header(44 + 16))
    body.append(rows)
    body.append(volume_row(y))
    body.append(tg)
    body.append(''.join(sub))
    body.append(note(['Gece Işığı’na ok (›) eklenir',
                      'Tıklayınca altında açılır:',
                      '• Sıcaklık (sarı ↔ turuncu)',
                      '• Kırmızı ekran: mavi ışığı tamamen keser',
                      '• Ekstra karartma: monitör en düşükteyken',
                      '   ekranı yazılımla biraz daha karartır',
                      '',
                      'İkisi de varsayılan olarak kapalı gelir.']))
    body.append(m.caption('4 · Gece Işığı menüsü', 'Kırmızı ekran ve Ekstra karartma, ihtiyaç olursa diye burada durur.'))
    m.save('4_gece_isigi', ''.join(body))


if __name__ == '__main__':
    r_rows('1_numara', ['1', '2'], '1 · Solda monitör numarası',
           'Ses slider’ı ile aynı ince slider. Üstüne gelince monitörün adı ve yüzdesi görünür.',
           ['Ses ayarı ile aynı görünüm',
            'Her monitörün kendi ince slider’ı.',
            'Solda numara: 1, 2, 3…',
            'Üstüne gelince: “LG ULTRAGEAR · %72”',
            'Sağdaki ay: akşam kararması (tıkla).'])
    r_rows('2_kisa_ad', ['LG', 'VS'], '2 · Solda kısa ad',
           'Aynı düzen; numara yerine monitör adının kısaltması. Ayarlardan ikisi arasında seçilebilir.',
           ['Numara yerine kısa ad',
            'LG ULTRAGEAR → LG',
            'ViewSonic VX3211 → VS',
            'Ayarlardan değiştirilebilir.'])
    r_schedule()
    r_night()
