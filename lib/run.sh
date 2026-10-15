#!/bin/bash
# SCREENS-LIB runner (GitHub macOS): installs the simulator app, logs in with the demo account (part main),
# switches the phone to Hebrew, then for every lib/t/<part>/<key>.yaml: run the flow, save a screenshot
# and Maestro's view hierarchy (bounds + texts of every element) as out/<key>.png / out/<key>.json.
set -x
PART="${PART:-main}"
cp sim-app.tar.gz app.tar.gz
mkdir app && tar -xzf app.tar.gz -C app
APP=$(find app -maxdepth 3 -name "*.app" | head -1)
DEV=$(xcrun simctl list devices available -j | python3 -c "
import json,sys
d=json.load(sys.stdin)['devices']
c=[(r,x) for r,v in d.items() if 'iOS' in r for x in v]
for want in ('iPhone 16 Plus','iPhone 15 Plus','iPhone 16 Pro Max','iPhone 15 Pro Max'):
    m=[t for t in c if t[1]['name']==want]
    if m: m.sort(key=lambda t:t[0]); print(m[-1][1]['udid']); break
")
xcrun simctl boot "$DEV"; xcrun simctl bootstatus "$DEV" -b
xcrun simctl install "$DEV" "$APP"
curl -Ls "https://get.maestro.mobile.dev" | bash
export PATH="$PATH:$HOME/.maestro/bin"
export MAESTRO_DRIVER_STARTUP_TIMEOUT=300000
mkdir -p out
mrun() { for try in 1 2; do maestro --device "$DEV" test "$@" -e DEMO_PASSWORD="$DEMO_PASSWORD" -e DEMO_CODE="$DEMO_CODE" 2>&1 | tee maestro-out.txt
  grep -q -E "driver not ready|became unreachable" maestro-out.txt || break; sleep 15; done; }
printf '%s' "$DEMO_CODE" | xcrun simctl pbcopy "$DEV"
if [ "$PART" != "solo" ]; then mrun flows/00_login.yaml; fi
xcrun simctl spawn "$DEV" defaults write "Apple Global Domain" AppleLanguages -array he-IL en-US
xcrun simctl spawn "$DEV" defaults write "Apple Global Domain" AppleLocale -string he_IL
xcrun simctl shutdown "$DEV"; xcrun simctl boot "$DEV"; xcrun simctl bootstatus "$DEV" -b
sleep 40
for f in lib/t/$PART/*.yaml; do
  k=$(basename "$f" .yaml)
  if [ -n "$ONLY" ] && ! echo ",$ONLY," | grep -q ",$k,"; then continue; fi
  mrun "$f" > "out/$k.log" 2>&1
  xcrun simctl io "$DEV" screenshot "out/$k.png"
  maestro --device "$DEV" hierarchy > "out/$k.json" 2> "out/$k.hier.err"
  echo "done $k $(stat -f %z "out/$k.png") $(stat -f %z "out/$k.json")"
done
cp lib/t/$PART/_expect.json out/
xcrun simctl io "$DEV" screenshot out/_last.png
exit 0
