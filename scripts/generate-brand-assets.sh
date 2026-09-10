#!/usr/bin/env bash
#
# Regenerate the whole SignBridge brand family from the product hero photograph.
#
#   ./scripts/generate-brand-assets.sh
#
# Requires ImageMagick 7 (`magick`), librsvg (`rsvg-convert`) and python3.
#
# The mark is not vector geometry — it is a crop of
# assets/signbridge-hero-source.png (the glowing amber key standing in
# the tower of the Golden Gate Bridge, with the cyan request stream crossing the
# span behind it). So there is nothing to hand-edit: every SVG is a rounded-rect
# clip around one embedded JPEG, and every PNG/ICO is rasterised from the same
# crops. Change the mark by changing this script.
#
# TWO crops, chosen by the size the file is used at:
#
#   WIDE  (360x360+600+280 of the hero) keeps the span, the cables and the cyan
#         stream around the key. Right from ~128 px up, where they are visible.
#   TIGHT (430x430+38+45 of the wide master) is the same key filling the tile.
#         Right at 48 px and below, where the wide framing spends most of its
#         pixels on sky and the key collapses into an orange bar.
#
# Small sizes also get contrast and saturation pushed harder, because the amber
# key and the red tower are close in luminance and merge once the bow is only a
# few pixels across. Every one of those numbers was chosen by rendering the
# result at 16/28/32/48/128 px and reading the image back — never by reasoning
# about the markup. Do the same after changing anything here.
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HERO="$REPO/assets/signbridge-hero-source.png"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

for tool in magick rsvg-convert python3; do
  command -v "$tool" >/dev/null || { echo "missing required tool: $tool" >&2; exit 1; }
done
[ -f "$HERO" ] || { echo "missing hero image: $HERO" >&2; exit 1; }

# ---- masters -----------------------------------------------------------------
magick "$HERO" -crop 360x360+600+280 +repage -filter Lanczos -resize 512x512 \
  -modulate 103,110 "PNG24:$WORK/master_wide.png"
magick "$WORK/master_wide.png" -crop 430x430+38+45 +repage "PNG24:$WORK/master_tight.png"

# The JPEG bodies embedded in the SVGs. 256 px is ample: favicon.svg is only ever
# rendered small, and the logo/wordmark tiles top out around 200 px.
magick "$WORK/master_tight.png" -resize 256x256 -sigmoidal-contrast 4x45% \
  -modulate 104,116 -quality 88 "$WORK/embed_tight.jpg"
magick "$WORK/master_wide.png" -resize 256x256 -quality 88 "$WORK/embed_wide.jpg"

# ---- rounded-corner tiles ----------------------------------------------------
# The corner radius tracks the SVG clip's 116/512, so a PNG and the SVG at the
# same size have the same silhouette.
tile() {
  local src=$1 size=$2 out=$3 rad sharp=()
  rad=$(python3 -c "print(round(116*$size/512))")
  if [ "$size" -le 48 ]; then
    sharp=(-unsharp 0x0.6+1.0+0.02 -sigmoidal-contrast 6x42% -modulate 108,130)
  else
    sharp=(-unsharp 0x0.5+0.35+0.01)
  fi
  magick "$src" -filter Lanczos -resize "${size}x${size}" "${sharp[@]}" \
    \( -size "${size}x${size}" xc:black -fill white \
       -draw "roundrectangle 0,0,$((size - 1)),$((size - 1)),$rad,$rad" -alpha off \) \
    -alpha off -compose CopyOpacity -composite "PNG32:$out"
}

tile "$WORK/master_tight.png" 16  "$REPO/frontend/public/favicon-16.png"
tile "$WORK/master_tight.png" 32  "$REPO/frontend/public/favicon-32.png"
tile "$WORK/master_wide.png"  180 "$REPO/frontend/public/apple-touch-icon.png"

# The .ico is a container: each layer is rasterised at its own size, rather than
# handing the encoder one bitmap and letting it downscale.
tile "$WORK/master_tight.png" 48 "$WORK/ico48.png"
tile "$WORK/master_tight.png" 32 "$WORK/ico32.png"
tile "$WORK/master_tight.png" 16 "$WORK/ico16.png"
magick "$WORK/ico16.png" "$WORK/ico32.png" "$WORK/ico48.png" \
  "$REPO/frontend/public/favicon.ico"

# ---- the four SVGs -----------------------------------------------------------
REPO="$REPO" WORK="$WORK" python3 - <<'PY'
import base64, os, pathlib

repo, work = pathlib.Path(os.environ['REPO']), pathlib.Path(os.environ['WORK'])

def uri(name):
    return 'data:image/jpeg;base64,' + base64.b64encode((work / name).read_bytes()).decode()

TIGHT, WIDE = uri('embed_tight.jpg'), uri('embed_wide.jpg')

PROVENANCE = """  <!--
    The SignBridge mark: a crop of the product hero
    (assets/signbridge-hero-source.png) - the glowing amber key standing
    in the tower of the Golden Gate Bridge, with the cyan request stream crossing
    the span behind it. Because the mark is a photograph there is no vector
    geometry to keep in step, only this one embedded JPEG. Regenerate with
    scripts/generate-brand-assets.sh rather than editing this file.

    {crop}
  -->
"""

CROP_TIGHT = """This file uses the TIGHT crop, because it is only ever rendered
    small: the browser tab (16-32 px) and the 28 px navbar brand in App.jsx. In
    the wide framing most of those pixels go to sky and the key collapses into an
    orange bar. The 16 px raster cannot hold the bow's hole whatever the crop -
    the key is ~4.6:1, so it is 3-4 px wide in a 16 px tile - but the tight crop
    is what makes it read as a key from 28 px up."""

CROP_WIDE = """This file uses the WIDE crop, which keeps the span, the cables and
    the cyan request stream around the key. That is the right framing from ~128 px
    up, where those elements are visible; frontend/public/favicon.svg uses a
    tighter crop of the same photograph for small sizes."""

TILE_SVG = """<svg xmlns="http://www.w3.org/2000/svg" \
xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 512 512" \
role="img" aria-label="SignBridge">
  <title>SignBridge</title>
{provenance}  <defs>
    <clipPath id="{p}TileClip">
      <rect width="512" height="512" rx="116"/>
    </clipPath>
  </defs>

  <g clip-path="url(#{p}TileClip)">
    <image width="512" height="512" preserveAspectRatio="xMidYMid slice"
           xlink:href="{uri}"/>
  </g>
</svg>
"""

WORDMARK_SVG = """<svg xmlns="http://www.w3.org/2000/svg" \
xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1060 240" \
role="img" aria-label="SignBridge">
  <title>SignBridge</title>
  <!--
    {mode}-background wordmark. The tile is the wide hero crop, the same one in
    assets/signbridge-logo.svg, embedded as a data URI and scaled into 20..220.
    Regenerate with scripts/generate-brand-assets.sh.
  -->
  <defs>
    <clipPath id="wmTileClip">
      <rect width="512" height="512" rx="116"/>
    </clipPath>
    <linearGradient id="wmText" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="{g0}"/>
      <stop offset="0.6" stop-color="{g1}"/>
      <stop offset="1" stop-color="#22d3ee"/>
    </linearGradient>
  </defs>

  <!-- ===== Icon tile (matches assets/signbridge-logo.svg) ===== -->
  <g transform="translate(20,20) scale(0.390625)">
    <g clip-path="url(#wmTileClip)">
      <image width="512" height="512" preserveAspectRatio="xMidYMid slice"
             xlink:href="{uri}"/>
    </g>
  </g>

  <!-- ===== Wordmark ===== -->
  <text x="268" y="128"
        font-family="'Segoe UI', 'Helvetica Neue', Arial, sans-serif"
        font-size="96" font-weight="700" letter-spacing="-1">
    <tspan fill="url(#wmText)">Sign</tspan><tspan fill="{bridge}">Bridge</tspan>
  </text>

  <!-- ===== Tagline ===== -->
  <text x="270" y="178"
        font-family="'Segoe UI', 'Helvetica Neue', Arial, sans-serif"
        font-size="30" font-weight="500" letter-spacing="0.5" fill="{tagline}">
    Presign URLs. Invoke APIs. Bridge IAM &amp; SSO roles.
  </text>
</svg>
"""

writes = {
    repo / 'frontend/public/favicon.svg': TILE_SVG.format(
        provenance=PROVENANCE.format(crop=CROP_TIGHT), p='sb', uri=TIGHT),
    # The wide crop, and a different id prefix so the mark can be inlined beside
    # the wordmarks in one document without an id collision.
    repo / 'assets/signbridge-logo.svg': TILE_SVG.format(
        provenance=PROVENANCE.format(crop=CROP_WIDE), p='gg', uri=WIDE),
    repo / 'assets/signbridge-wordmark.svg': WORDMARK_SVG.format(
        mode='Light', uri=WIDE, g0='#6366f1', g1='#3b82f6',
        bridge='#94a3b8', tagline='#64748b'),
    repo / 'assets/signbridge-wordmark-dark.svg': WORDMARK_SVG.format(
        mode='Dark', uri=WIDE, g0='#818cf8', g1='#60a5fa',
        bridge='#e6edf3', tagline='#8b949e'),
}

for path, body in writes.items():
    path.write_text(body)
    print('%7d  %s' % (len(body), path.relative_to(repo)))
PY

# ---- wordmark PNGs, rasterised from the SVGs so type and tile stay in step ----
for variant in '' '-dark'; do
  rsvg-convert -w 1060 -h 240 "$REPO/assets/signbridge-wordmark${variant}.svg" \
    -o "$REPO/assets/signbridge-wordmark${variant}.png"
done

# ---- the product hero, shipped as a JPEG in two places ------------------------
# The README embeds assets/signbridge-hero.jpg; the About page serves
# frontend/public/signbridge-hero.jpg through Vite's base. Generating both here is
# what keeps them in step - they used to be two hand-made copies of one image.
magick "$HERO" -resize 1640x -quality 82 -strip "$REPO/assets/signbridge-hero.jpg"
cp "$REPO/assets/signbridge-hero.jpg" "$REPO/frontend/public/signbridge-hero.jpg"

magick identify \
  "$REPO/frontend/public/favicon-16.png" \
  "$REPO/frontend/public/favicon-32.png" \
  "$REPO/frontend/public/apple-touch-icon.png" \
  "$REPO/frontend/public/favicon.ico" \
  "$REPO/assets/signbridge-wordmark.png" \
  "$REPO/assets/signbridge-wordmark-dark.png" \
  "$REPO/assets/signbridge-hero.jpg"
