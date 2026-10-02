#!/bin/bash
# Records the Play Console foreground-service (specialUse) demo video:
# login -> driver switches to 'available' -> live ride offers -> the ongoing BigBot
# notification (the foreground service) stays while the app is in the background and the screen is off.
set -x
APK_URL=$(cat android/apk-url.txt)
curl -sL "$APK_URL" -o app.apk
adb root; sleep 3
adb shell "setprop persist.sys.locale he-IL; setprop ctl.restart zygote"
sleep 5; adb wait-for-device
until [ "$(adb shell getprop sys.boot_completed | tr -d '\r')" = "1" ]; do sleep 2; done; sleep 10
adb install -r -g app.apk
adb shell dumpsys package com.bigbotdrivers.app | grep -m2 -E "versionName|versionCode"
adb shell settings put system screen_off_timeout 600000
curl -Ls "https://get.maestro.mobile.dev" | bash
export PATH="$PATH:$HOME/.maestro/bin"
mkdir -p shots
maestro test flows/00_login.yaml -e DEMO_PASSWORD="$DEMO_PASSWORD" -e DEMO_CODE="$DEMO_CODE"
adb shell rm -f /sdcard/fgs.mp4
adb shell screenrecord --bit-rate 6000000 --time-limit 175 /sdcard/fgs.mp4 &
REC=$!
sleep 2
maestro test fgs/show.yaml
adb exec-out screencap -p > shots/1_available.png
# the ongoing notification of the foreground service
adb shell cmd statusbar expand-notifications; sleep 6
adb exec-out screencap -p > shots/2_notification.png
adb shell cmd statusbar collapse; sleep 2
# app to the background: the service keeps the live connection
adb shell input keyevent KEYCODE_HOME; sleep 5
adb shell cmd statusbar expand-notifications; sleep 6
adb exec-out screencap -p > shots/3_background_notification.png
adb shell cmd statusbar collapse; sleep 2
adb shell dumpsys activity services com.bigbotdrivers.app | grep -iE "RideForegroundService|isForeground|foregroundServiceType|types=" | head -10 > shots/fgs-dumpsys.txt
# back to the app: still connected, rides keep coming
adb shell monkey -p com.bigbotdrivers.app -c android.intent.category.LAUNCHER 1; sleep 8
adb exec-out screencap -p > shots/4_back_in_app.png
sleep 2
kill -INT $REC; sleep 4
adb pull /sdcard/fgs.mp4 shots/fgs.mp4
ls -la shots
exit 0
