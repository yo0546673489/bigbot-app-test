#!/bin/bash
# Maestro writes takeScreenshot files under ~/.maestro/tests — copy them and shrink to half-size JPEG.
mkdir -p shots
find ~/.maestro/tests -name "*.png" -path "*takeScreenshot*" -exec cp {} shots/ \; 2>/dev/null
for f in shots/*.png; do [ -f "$f" ] && sips -s format jpeg -s formatOptions 70 -Z 1000 "$f" --out "${f%.png}.jpg" >/dev/null && rm "$f"; done
ls shots | wc -l
