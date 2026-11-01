#!/bin/bash
# Runs on the GitHub macOS runner: a real iPhone simulator + the BigBot simulator build.
# Phase 1 logs in with the phone in English (the password is Latin; a Hebrew keyboard mistypes it).
# Phase 2 switches the phone to Hebrew (like a real Israeli iPhone), reboots, and sweeps every screen.
set -x
LOC="${SIM_LOCALE:-he}"
if [ "$APP_URL_FILE" = "built" ]; then cp sim-app.tar.gz app.tar.gz   # built by the build job
else APP_URL=$(cat "${APP_URL_FILE:-ios/app-url.txt}"); curl -sL "$APP_URL" -o app.tar.gz; fi
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
xcrun simctl boot "$DEV"; xcrun simctl bootstatus "$DEV" -b
xcrun simctl install "$DEV" "$APP"
curl -Ls "https://get.maestro.mobile.dev" | bash
export PATH="$PATH:$HOME/.maestro/bin"
export MAESTRO_DRIVER_STARTUP_TIMEOUT=300000
mkdir -p shots video
mrun() { # retry when the XCTest driver is slow to start or drops mid-run (it can appear only in the report)
  for try in 1 2 3; do
    rm -f shots/report.xml
    maestro --device "$DEV" test "$@" -e DEMO_PASSWORD="$DEMO_PASSWORD" -e DEMO_CODE="$DEMO_CODE" 2>&1 | tee maestro-out.txt
    MRC=${PIPESTATUS[0]}
    grep -q -i -E "driver not ready|unreachable" maestro-out.txt shots/report.xml 2>/dev/null || break
    xcrun simctl terminate "$DEV" dev.mobile.maestro-driver-iosUITests.xctrunner 2>/dev/null || true
    pkill -f xcodebuild 2>/dev/null || true
    sleep 30
  done
}
# the login code on the simulator clipboard: the app's "הדבק קוד מוואטסאפ" button pastes it
printf '%s' "$DEMO_CODE" | xcrun simctl pbcopy "$DEV"
# A login that did not finish must not pass silently: every later screen would just show the login form.
LOGIN_RC=skipped
if [ "${DO_LOGIN:-1}" = "1" ]; then
  for attempt in 1 2 3; do
    mrun flows/00_login.yaml
    LOGIN_RC=$MRC
    [ "$LOGIN_RC" = "0" ] && break
    sleep 15
  done
  # Close the "want a tour?" offer once, so it does not cover the screens. The onboard part tests that offer.
  case "${FLOW_CONFIG:-}" in
    *onboard*) ;;
    *) mrun flows/sub_dismiss_offer.yaml ;;
  esac
fi
if [ "$LOC" = "he" ]; then
  xcrun simctl spawn "$DEV" defaults write "Apple Global Domain" AppleLanguages -array he-IL en-US
  xcrun simctl spawn "$DEV" defaults write "Apple Global Domain" AppleLocale -string he_IL
  xcrun simctl shutdown "$DEV"; xcrun simctl boot "$DEV"; xcrun simctl bootstatus "$DEV" -b
  sleep 45
fi
mrun flows/ --config "${FLOW_CONFIG:-flows/config.yaml}" --format junit --output shots/report.xml
echo "login=$LOGIN_RC flows=$MRC" > shots/run-summary.txt
# onboard-light: why the app closes - the JS exception / native crash from the simulator log
xcrun simctl spawn "$DEV" log show --last 40m --style compact --predicate 'eventMessage CONTAINS[c] "exception" OR eventMessage CONTAINS[c] "RCTFatal" OR eventMessage CONTAINS[c] "TypeError" OR eventMessage CONTAINS[c] "ReferenceError" OR eventMessage CONTAINS[c] "Invariant" OR eventMessage CONTAINS[c] "Maximum update"' 2>&1 | grep -v -i "maestro" | tail -300 > shots/applog.txt || true
cp ~/Library/Logs/DiagnosticReports/*BigBot* shots/ 2>/dev/null || true
exit 0
