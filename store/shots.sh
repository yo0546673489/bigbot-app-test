#!/bin/bash
# Store-listing screenshots: fresh install, Hebrew, clean status bar, full-res adb screencap.
set -x
APK_URL=$(cat android/apk-url.txt)
curl -sL "$APK_URL" -o app.apk
adb root; sleep 3
adb shell "setprop persist.sys.locale he-IL; setprop ctl.restart zygote"
sleep 5; adb wait-for-device
until [ "$(adb shell getprop sys.boot_completed | tr -d '\r')" = "1" ]; do sleep 2; done; sleep 10
adb install -r -g app.apk
# clean status bar (demo mode)
adb shell settings put global sysui_demo_allowed 1
adb shell am broadcast -a com.android.systemui.demo -e command enter
adb shell am broadcast -a com.android.systemui.demo -e command clock -e hhmm 1000
adb shell am broadcast -a com.android.systemui.demo -e command battery -e level 100 -e plugged false
adb shell am broadcast -a com.android.systemui.demo -e command network -e wifi show -e level 4
adb shell am broadcast -a com.android.systemui.demo -e command network -e mobile show -e datatype none -e level 4
adb shell am broadcast -a com.android.systemui.demo -e command notifications -e visible false
curl -Ls "https://get.maestro.mobile.dev" | bash
export PATH="$PATH:$HOME/.maestro/bin"
mkdir -p shots
maestro test store/welcome.yaml
sleep 3
adb exec-out screencap -p > shots/welcome.png
maestro test store/to_register.yaml
sleep 3
adb exec-out screencap -p > shots/register.png
adb shell input tap 540 700
sleep 2
adb exec-out screencap -p > shots/register-focus.png
adb shell wm size > shots/size.txt
exit 0
