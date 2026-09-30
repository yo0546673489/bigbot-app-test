#!/bin/bash
# Runs on the GitHub macOS runner: a real iPhone simulator, Hebrew locale, the BigBot simulator build.
set -x
[ -f "${APP_URL_FILE:-ios/app-url.txt}" ] || { echo "no iOS build yet"; exit 0; }
LOC="${SIM_LOCALE:-he}"
APP_URL=$(cat "${APP_URL_FILE:-ios/app-url.txt}")
curl -sL "$APP_URL" -o app.tar.gz
mkdir app && tar -xzf app.tar.gz -C app
APP=$(find app -maxdepth 3 -name "*.app" | head -1)
DEV=$(xcrun simctl list devices available -j | python3 -c "
import json,sys
d=json.load(sys.stdin)['devices']
c=[(r,x) for r,v in d.items() if 'iOS' in r for x in v]
for want in ('iPhone 16 Plus','iPhone 15 Plus','iPhone 16 Pro Max','iPhone 15 Pro Max'):
    m=[t for t in c if t[1]['name']==want]
    if m: m.sort(key=lambda t:t[0]); print(m[-1][1]['udid']); break
else:
    c=[t for t in c if t[1]['name'].startswith('iPhone')]; c.sort(key=lambda t:t[0]); print(c[-1][1]['udid'])
")
xcrun simctl list devices | grep "$DEV"
xcrun simctl boot "$DEV"; xcrun simctl bootstatus "$DEV" -b
if [ "$LOC" = "he" ]; then
  xcrun simctl spawn "$DEV" defaults write "Apple Global Domain" AppleLanguages -array he-IL en-US
  xcrun simctl spawn "$DEV" defaults write "Apple Global Domain" AppleLocale -string he_IL
  # English keyboard first (the password is Latin), Hebrew second — the UI language stays Hebrew.
  xcrun simctl spawn "$DEV" defaults write "Apple Global Domain" AppleKeyboards -array "en_US@sw=QWERTY;hw=Automatic" "he_IL@sw=Hebrew;hw=Automatic"
  xcrun simctl spawn "$DEV" defaults write com.apple.Preferences KeyboardsCurrentAndNext -array "en_US@sw=QWERTY;hw=Automatic" "he_IL@sw=Hebrew;hw=Automatic"
  xcrun simctl shutdown "$DEV"; xcrun simctl boot "$DEV"; xcrun simctl bootstatus "$DEV" -b
fi
xcrun simctl install "$DEV" "$APP"
curl -Ls "https://get.maestro.mobile.dev" | bash
export PATH="$PATH:$HOME/.maestro/bin"
mkdir -p shots video
xcrun simctl io "$DEV" recordVideo --codec h264 video/run.mp4 & REC=$!
export MAESTRO_DRIVER_STARTUP_TIMEOUT=300000
sleep 20
for try in 1 2; do
  maestro --device "$DEV" test flows/ --config "${FLOW_CONFIG:-flows/config.yaml}" -e DEMO_PASSWORD="$DEMO_PASSWORD" -e DEMO_CODE="$DEMO_CODE" --format junit --output shots/report.xml 2>&1 | tee maestro-out.txt
  grep -q "driver not ready" maestro-out.txt || break
  echo "maestro driver timeout, retry $try"; sleep 15
done
kill -INT $REC; sleep 3
# Maestro writes takeScreenshot files (and its own failure shots) under ~/.maestro/tests
find ~/.maestro/tests -name "*.png" -path "*takeScreenshot*" -exec cp {} shots/ \; 2>/dev/null
for f in $(find ~/.maestro/tests -name "*.png" ! -path "*takeScreenshot*" 2>/dev/null | grep -i -E "fail|screenshot-❌|error" ); do cp "$f" shots/FAIL_$(basename "$f"); done
ls shots | head -200
# shrink: half-size JPEG (the full PNGs made a 430 MB artifact)
for f in shots/*.png; do sips -s format jpeg -s formatOptions 70 -Z 1000 "$f" --out "${f%.png}.jpg" >/dev/null && rm "$f"; done
exit 0
