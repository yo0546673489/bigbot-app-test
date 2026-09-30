#!/bin/bash
# Runs inside android-emulator-runner (a real Android 14 emulator), Hebrew locale, the BigBot.apk from the link.
set -x
APK_URL=$(cat android/apk-url.txt)
curl -sL "$APK_URL" -o app.apk; ls -la app.apk
adb root; sleep 3
adb shell "setprop persist.sys.locale he-IL; setprop ctl.restart zygote"
sleep 5; adb wait-for-device
until [ "$(adb shell getprop sys.boot_completed | tr -d '\r')" = "1" ]; do sleep 2; done; sleep 10
adb install -r -g app.apk
adb shell dumpsys package com.bigbotdrivers.app | grep -m2 -E "versionName|versionCode"
curl -Ls "https://get.maestro.mobile.dev" | bash
export PATH="$PATH:$HOME/.maestro/bin"
mkdir -p shots
maestro test flows/00_login.yaml -e DEMO_PASSWORD="$DEMO_PASSWORD" -e DEMO_CODE="$DEMO_CODE"
maestro test flows/ --config flows/config.yaml -e DEMO_PASSWORD="$DEMO_PASSWORD" -e DEMO_CODE="$DEMO_CODE" --format junit --output shots/report.xml
# Maestro writes takeScreenshot files (and its own failure shots) under ~/.maestro/tests
find ~/.maestro/tests -name "*.png" -path "*takeScreenshot*" -exec cp {} shots/ \; 2>/dev/null
for f in $(find ~/.maestro/tests -name "*.png" ! -path "*takeScreenshot*" 2>/dev/null | grep -i -E "fail|screenshot-❌|error" ); do cp "$f" shots/FAIL_$(basename "$f"); done
ls shots | head -200
command -v mogrify >/dev/null || sudo apt-get install -y -qq imagemagick >/dev/null
mogrify -format jpg -quality 70 -resize 1000x1000\> shots/*.png && rm -f shots/*.png
adb logcat -d -b crash > shots/crash-log.txt 2>/dev/null
adb logcat -d | grep -E "AndroidRuntime|FATAL|ANR in" | tail -200 > shots/errors-log.txt
exit 0
