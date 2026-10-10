#!/usr/bin/env python3
"""Round 3 mockups (final spec): sun icon on the left, per-monitor menu with
   evening dimming + extra dimming + screen off, red screen strength.
   tools/mockups3.py <out-dir>"""
import sys

import mockups as m
import mockups2 as r
from mockups import t, rect, moon, sun, monitor, switch, TEXT, SUB

m.OUT = sys.argv[1] if len(sys.argv) > 1 else 'tasarim/3-son'
X0, IW = r.X0, r.IW
ORANGE, NIGHTC, RED, BTN = r.ORANGE, r.NIGHTC, r.RED, r.BTN

_badge = r.badge


def badge(cx, cy, label):
    if label == 'sun':
        return sun(cx, cy, 5.6, TEXT, 1.6)
    return _badge(cx, cy, label)


r.badge = badge


def sep(y):
    return f'<line x1="{X0 + 16}" y1="{y}" x2="{X0 + IW - 16}" y2="{y}" stroke="rgba(255,255,255,0.07)"/>'


def pill_btn(x, y, w, label, icon=None):
    out = [rect(x, y, w, 32, 16, BTN)]
    tx = x + w / 2
    if icon == 'off':
        out.append(f'<circle cx="{x + 22}" cy="{y + 16}" r="5.5" fill="none" stroke="{TEXT}" stroke-width="1.5"/>'
                   f'<line x1="{x + 22}" y1="{y + 9}" x2="{x + 22}" y2="{y + 15}" stroke="{TEXT}" stroke-width="1.5" stroke-linecap="round"/>')
        tx += 8
    elif icon == 'others':
        out.append(monitor(x + 20, y + 16, 0.62, TEXT) + monitor(x + 30, y + 16, 0.62, SUB))
        tx += 10
    out.append(t(tx, y + 20.5, label, 12, TEXT, 600, 'middle'))
    return ''.join(out)


def monitor_menu(y):
    """Expanded per-monitor submenu. Returns (svg, height)."""
    h = 312
    out = [r.submenu(y, h)]
    # header
    out.append(f'<circle cx="{X0 + 30}" cy="{y + 26}" r="16" fill="rgba(255,255,255,0.12)"/>' + monitor(X0 + 30, y + 26, 0.8, TEXT))
    out.append(t(X0 + 56, y + 22, 'LG ULTRAGEAR', 14, TEXT, 800) + t(X0 + 56, y + 39, 'Parlaklık %72', 11.5, SUB))
    yy = y + 64
    out.append(sep(yy))
    yy += 22
    # evening dimming
    out.append(moon(X0 + 24, yy, 6, NIGHTC) + t(X0 + 40, yy + 5, 'Akşam kararması', 13, TEXT, 600))
    out.append(switch(X0 + IW - 60, yy - 13, True, ORANGE))
    yy += 34
    out.append(t(X0 + 16, yy + 4, 'Başlangıç', 12.5, TEXT, 500) + t(X0 + 16, yy + 20, 'Gün batımı 18:50 + 30 dk', 11, SUB))
    bx = X0 + IW - 16 - 112
    out.append(f'<circle cx="{bx + 14}" cy="{yy + 6}" r="13" fill="{BTN}"/>' + t(bx + 14, yy + 11, '−', 16, TEXT, 500, 'middle'))
    out.append(t(bx + 56, yy + 11, '19:20', 13.5, NIGHTC, 700, 'middle'))
    out.append(f'<circle cx="{bx + 98}" cy="{yy + 6}" r="13" fill="{BTN}"/>' + t(bx + 98, yy + 11, '+', 16, TEXT, 500, 'middle'))
    yy += 40
    out.append(t(X0 + 16, yy + 4, 'Gece parlaklığı', 12.5, TEXT, 500) + t(X0 + IW - 16, yy + 4, '%35', 12.5, NIGHTC, 700, 'end'))
    out.append(r.slider(X0 + 6, yy + 24, IW - 12, 0.35, NIGHTC))
    yy += 46
    out.append(sep(yy))
    yy += 20
    # extra dimming
    out.append(t(X0 + 16, yy + 4, 'Ekstra karartma', 12.5, TEXT, 500) + t(X0 + IW - 16, yy + 4, 'Kapalı', 12.5, SUB, 600, 'end'))
    out.append(r.slider(X0 + 6, yy + 24, IW - 12, 0.0))
    yy += 44
    # screen off buttons
    bw = (IW - 32 - 10) / 2
    out.append(pill_btn(X0 + 16, yy, bw, 'Ekranı kapat', 'off'))
    out.append(pill_btn(X0 + 26 + bw, yy, bw, 'Diğerlerini kapat', 'others'))
    return ''.join(out), h


def r_icon():
    r.r_rows('1_ana_menu', ['sun', 'sun'], '1 · Ana menü',
             'Solda parlaklık simgesi (ayarlardan: simge / numara / kısa ad). Üstüne gelince monitörün adı.',
             ['Ses ayarı ile aynı görünüm',
              'Her monitörün kendi slider’ı.',
              'Üstüne gelince: “LG ULTRAGEAR · %72”',
              'Sağdaki ay → o monitörün menüsü.',
              'Ay turuncu: akşam kararması açık.'])


def r_monitor_menu():
    body = [m.wallpaper(True), m.topbar('qs')]
    y = 44 + 76
    row1, y = r.brightness_rows(y, ['sun'], [0.72], open_idx=0)
    menu, h = monitor_menu(y - 10)
    y = y - 10 + h + 26
    row2, y = r.brightness_rows(y, ['sun'], [0.52])
    tg, y2 = r.toggles(y + 44)
    body.append(r.panel(y2 - 44 + 18))
    body.append(r.header(44 + 16))
    body += [row1, menu, row2, r.volume_row(y), tg]
    body.append(r.note(['Ay simgesi → monitör menüsü',
                        'Akşam kararması: gün batımına göre',
                        'yavaş yavaş iner, sabah geri döner.',
                        '',
                        'Ekstra karartma: monitör en düşükteyken',
                        'yazılımla daha da karartır (varsayılan kapalı).',
                        '',
                        'Ekranı kapat / Diğerlerini kapat:',
                        'siyah ekran ya da en düşük ışık (ayarlardan).',
                        'Fare o ekrana gelince eski haline döner.']))
    body.append(m.caption('2 · Monitör menüsü', 'Her monitörün kendi akşam kararması, ekstra karartması ve kapatma düğmeleri.'))
    m.save('2_monitor_menusu', ''.join(body))


def r_night():
    body = [m.wallpaper(True), m.topbar('qs')]
    y = 44 + 76
    rows, y = r.brightness_rows(y, ['sun', 'sun'], [0.72, 0.52])
    tg_y = y + 44
    tg, _ = r.toggles(tg_y, night_sub='Kırmızı ekran', night_color=RED)
    sy = tg_y + 112
    sh = 196
    sub = [r.submenu(sy, sh), r.sub_header(sy, 'Gece Işığı', '06:48’e kadar açık', RED)]
    yy = sy + 66
    sub.append(t(X0 + 16, yy + 4, 'Sıcaklık', 12.5, TEXT, 500))
    sub.append(r.slider(X0 + 6, yy + 24, IW - 12, 0.38, '#ffa040'))
    yy += 50
    sub.append(sep(yy - 6))
    sub.append(f'<circle cx="{X0 + 24}" cy="{yy + 12}" r="6" fill="{RED}"/>' + t(X0 + 40, yy + 17, 'Kırmızı ekran', 13, TEXT, 600))
    sub.append(switch(X0 + IW - 60, yy - 1, True, RED))
    yy += 40
    sub.append(t(X0 + 16, yy + 4, 'Güç', 12.5, TEXT, 500) + t(X0 + IW - 16, yy + 4, '%80', 12.5, RED, 700, 'end'))
    sub.append(r.slider(X0 + 6, yy + 24, IW - 12, 0.8, RED))
    body.append(r.panel(sy + sh + 16 - 44))
    body.append(r.header(44 + 16))
    body += [rows, r.volume_row(y), tg, ''.join(sub)]
    body.append(r.note(['Gece Işığı’na ok (›) eklenir',
                        '• Sıcaklık (sarı ↔ turuncu)',
                        '• Kırmızı ekran: mavi ve yeşil ışığı keser',
                        '• Güç: ne kadar kırmızı olacağı',
                        '',
                        'Kırmızı ekran varsayılan olarak kapalı gelir.']))
    body.append(m.caption('3 · Gece Işığı menüsü', 'Kırmızı ekran açıkken düğme kırmızı olur ve gücü ayarlanabilir.'))
    m.save('3_gece_isigi', ''.join(body))


r_icon()
r_monitor_menu()
r_night()
