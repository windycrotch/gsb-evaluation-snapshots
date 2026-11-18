"""Builds index.html from src/index.tpl.html, src/data.json and src/game.js."""
import os
HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, '..', 'src')
tpl = open(os.path.join(SRC, 'index.tpl.html'), encoding='utf-8').read()
data = open(os.path.join(SRC, 'data.json'), encoding='utf-8').read()
game = open(os.path.join(SRC, 'game.js'), encoding='utf-8').read()
out = tpl.replace('/*__DATA__*/', data).replace('/*__GAME__*/', game)
open(os.path.join(HERE, '..', 'index.html'), 'w', encoding='utf-8').write(out)
print('index.html written,', len(out), 'characters')
