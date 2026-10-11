import sys
from PIL import Image, ImageDraw, ImageFont
OUT = sys.argv[1]
MINT, SAND, BG, INK = '#5eeec8', '#d9b87a', '#0a0f0d', '#edf7f0'
# Cardón: tronco y tres brazos (unidades de 100)
PARTS = [
    ([(50, 82), (50, 16)], 11, MINT),
    ([(50, 60), (65.5, 60), (65.5, 27)], 7.5, MINT),
    ([(50, 68), (34.5, 68), (34.5, 35)], 7.5, MINT),
    ([(50, 77), (21, 77), (21, 53)], 6.5, MINT),
    ([(50, 77), (79, 77), (79, 46)], 6.5, MINT),
    ([(10, 90.5), (90, 90.5)], 3.5, SAND),
]
def paths(mint='currentColor', sand=SAND):
    out = []
    for pts, w, col in PARTS:
        d = 'M' + ' L'.join(f'{x} {y}' for x, y in pts)
        out.append(f'<path d="{d}" stroke="{sand if col == SAND else mint}" stroke-width="{w}"/>')
    return ''.join(out)
G = 'fill="none" stroke-linecap="round" stroke-linejoin="round"'
open(f'{OUT}/logo-mark.svg', 'w').write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" {G}>{paths(MINT)}</svg>\n')
open(f'{OUT}/logo-mark-dark.svg', 'w').write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" {G}>{paths("#0f6b55", "#a8823f")}</svg>\n')
ICON = f'<defs><radialGradient id="g" cx="50%" cy="30%" r="80%"><stop offset="0" stop-color="#17352c"/><stop offset="1" stop-color="{BG}"/></radialGradient></defs><rect width="100" height="100" rx="22" fill="url(#g)"/><g transform="translate(12 10) scale(.76)" {G}>{paths(MINT)}</g>'
open(f'{OUT}/icon.svg', 'w').write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">{ICON}</svg>\n')
open(f'{OUT}/favicon.svg', 'w').write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">{ICON}</svg>\n')
FONT = "font-family=\"'Space Grotesk','Segoe UI',Arial,sans-serif\""
def lockup(ink, mint, sand, sub):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 100"><g {G}>{paths(mint, sand)}</g>'
            f'<text x="112" y="56" {FONT} font-size="44" font-weight="700" fill="{ink}" letter-spacing="-1">Cardón <tspan fill="{mint}">DeFi</tspan></text>'
            f'<text x="114" y="80" font-family="\'JetBrains Mono\',monospace" font-size="10.5" letter-spacing="2.2" fill="{sub}">DECENTRALIZED TRADING AGENT</text></svg>\n')
open(f'{OUT}/logo-lockup.svg', 'w').write(lockup(INK, MINT, SAND, '#8ba095'))
open(f'{OUT}/logo-lockup-light.svg', 'w').write(lockup('#0d1512', '#0f6b55', '#a8823f', '#55665d'))

def rgb(h): return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))
def draw(px, k, ox=0, oy=0, scale=1):
    for pts, w, col in PARTS:
        p = [(ox + x * k * scale, oy + y * k * scale) for x, y in pts]; r = w * k * scale / 2
        for a, b in zip(p, p[1:]): px.line([a, b], fill=rgb(col), width=round(w * k * scale))
        for x, y in p: px.ellipse([x - r, y - r, x + r, y + r], fill=rgb(col))
def gradient(w, h):
    im = Image.new('RGB', (w, h)); px = ImageDraw.Draw(im)
    for y in range(h):
        t = y / h; px.line([(0, y), (w, y)], fill=(int(18 - 8 * t), int(44 - 29 * t), int(36 - 23 * t)))
    return im, px
S = 2048; im, px = gradient(S, S); draw(px, S / 100, S * .12, S * .10, .76)
im.resize((1024, 1024), Image.LANCZOS).save(f'{OUT}/icon-1024.png'); im.resize((192, 192), Image.LANCZOS).save(f'{OUT}/icon-192.png')
# Imagen para compartir (1200×630)
W, H = 2400, 1260; im, px = gradient(W, H); draw(px, 9, 170, 180, 1)
def font(names, size):
    import glob
    for n in names:
        for f in glob.glob(f'/usr/share/fonts/**/{n}', recursive=True): return ImageFont.truetype(f, size)
    return ImageFont.load_default(size)
bold = font(['DejaVuSans-Bold.ttf', 'LiberationSans-Bold.ttf'], 190); mono = font(['DejaVuSansMono.ttf', 'LiberationMono-Regular.ttf'], 54)
px.text((1130, 370), 'Cardón', font=bold, fill=rgb(INK)); px.text((1130, 580), 'DeFi', font=bold, fill=rgb(MINT))
px.text((1136, 840), 'DECENTRALIZED TRADING AGENT', font=mono, fill=rgb(SAND)); px.text((1136, 920), 'AGENTE DE TRADING DESCENTRALIZADO', font=mono, fill=(139, 160, 149))
im.resize((1200, 630), Image.LANCZOS).save(f'{OUT}/og.png')
