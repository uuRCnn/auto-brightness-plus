#!/usr/bin/env python3
"""Write po/<lang>.po from po/brightness-plus.pot and tools/translations/<lang>.json.
   tools/make-po.py            all languages
   tools/make-po.py --missing  list untranslated strings per language"""
import json
import os
import re
import sys

ROOT = os.path.join(os.path.dirname(__file__), '..')
POT = os.path.join(ROOT, 'po', 'brightness-plus.pot')
SRC = os.path.join(os.path.dirname(__file__), 'translations')

NAMES = {
    'tr': ('Turkish', 'nplurals=2; plural=(n != 1);'),
    'de': ('German', 'nplurals=2; plural=(n != 1);'),
    'es': ('Spanish', 'nplurals=2; plural=(n != 1);'),
    'fr': ('French', 'nplurals=2; plural=(n > 1);'),
    'it': ('Italian', 'nplurals=2; plural=(n != 1);'),
    'pt_BR': ('Brazilian Portuguese', 'nplurals=2; plural=(n > 1);'),
    'ru': ('Russian', 'nplurals=3; plural=(n%10==1 && n%100!=11 ? 0 : n%10>=2 && n%10<=4 && (n%100<10 || n%100>=20) ? 1 : 2);'),
    'uk': ('Ukrainian', 'nplurals=3; plural=(n%10==1 && n%100!=11 ? 0 : n%10>=2 && n%10<=4 && (n%100<10 || n%100>=20) ? 1 : 2);'),
    'pl': ('Polish', 'nplurals=3; plural=(n==1 ? 0 : n%10>=2 && n%10<=4 && (n%100<10 || n%100>=20) ? 1 : 2);'),
    'zh_CN': ('Chinese (simplified)', 'nplurals=1; plural=0;'),
    'zh_TW': ('Chinese (traditional)', 'nplurals=1; plural=0;'),
    'ja': ('Japanese', 'nplurals=1; plural=0;'),
    'ko': ('Korean', 'nplurals=1; plural=0;'),
    'ar': ('Arabic', 'nplurals=6; plural=(n==0 ? 0 : n==1 ? 1 : n==2 ? 2 : n%100>=3 && n%100<=10 ? 3 : n%100>=11 ? 4 : 5);'),
    'fa': ('Persian', 'nplurals=2; plural=(n > 1);'),
    'id': ('Indonesian', 'nplurals=1; plural=0;'),
    'vi': ('Vietnamese', 'nplurals=1; plural=0;'),
    'th': ('Thai', 'nplurals=1; plural=0;'),
}


def unquote(s):
    return json.loads(s)


def quote(s):
    return json.dumps(s, ensure_ascii=False)


def read_pot():
    entries = []
    refs = []
    cur = None
    for line in open(POT, encoding='utf-8'):
        line = line.rstrip('\n')
        if line.startswith('#:'):
            refs.append(line)
        elif line.startswith('msgid '):
            cur = {'refs': refs, 'msgid': unquote(line[6:])}
            refs = []
            field = 'msgid'
        elif line.startswith('msgstr '):
            field = 'msgstr'
        elif line.startswith('"') and cur is not None and field == 'msgid':
            cur['msgid'] += unquote(line)
        elif not line.strip() and cur is not None:
            entries.append(cur)
            cur = None
    if cur:
        entries.append(cur)
    return [e for e in entries if e['msgid']]


def wrap(key, text):
    if '\n' not in text and len(text) < 70:
        return f'{key} {quote(text)}\n'
    parts = re.findall(r'.{1,70}(?:\s+|$)|.+', text)
    return f'{key} ""\n' + ''.join(f'{quote(p)}\n' for p in parts if p)


def main():
    entries = read_pot()
    missing_only = '--missing' in sys.argv
    for fn in sorted(os.listdir(SRC)):
        lang = fn[:-5]
        tr = json.load(open(os.path.join(SRC, fn), encoding='utf-8'))
        missing = [e['msgid'] for e in entries if not tr.get(e['msgid'])]
        if missing_only:
            if missing:
                print(lang, len(missing), missing[:5])
            continue
        name, plural = NAMES.get(lang, (lang, 'nplurals=2; plural=(n != 1);'))
        out = [
            f'# {name} translation for Brightness+.\n',
            '# This file is distributed under the same license as the Brightness+ package.\n',
            'msgid ""\n', 'msgstr ""\n',
            '"Project-Id-Version: Brightness+\\n"\n',
            '"Report-Msgid-Bugs-To: https://github.com/uuRCnn/brightness-plus/issues\\n"\n',
            '"PO-Revision-Date: 2026-10-10 21:00+0300\\n"\n',
            '"Last-Translator: Dukha\\n"\n',
            f'"Language-Team: {name}\\n"\n',
            f'"Language: {lang}\\n"\n',
            '"MIME-Version: 1.0\\n"\n',
            '"Content-Type: text/plain; charset=UTF-8\\n"\n',
            '"Content-Transfer-Encoding: 8bit\\n"\n',
            f'"Plural-Forms: {plural}\\n"\n', '\n',
        ]
        for e in entries:
            out += [r + '\n' for r in e['refs']]
            out.append(wrap('msgid', e['msgid']))
            out.append(wrap('msgstr', tr.get(e['msgid'], '')))
            out.append('\n')
        with open(os.path.join(ROOT, 'po', f'{lang}.po'), 'w', encoding='utf-8') as f:
            f.writelines(out)
        print(f'{lang}: {len(entries) - len(missing)}/{len(entries)}')


main()
