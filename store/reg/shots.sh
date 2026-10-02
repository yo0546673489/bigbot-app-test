#!/bin/bash
# Store-listing screenshots of the driver REGISTRATION flow (fake phone 0500000077).
set -x
APK_URL=$(cat android/apk-url.txt)
curl -sL "$APK_URL" -o app.apk
adb root; sleep 3
adb shell "setprop persist.sys.locale he-IL; setprop ctl.restart zygote"
sleep 5; adb wait-for-device
until [ "$(adb shell getprop sys.boot_completed | tr -d '\r')" = "1" ]; do sleep 2; done; sleep 10
adb install -r -g app.apk
adb shell dumpsys deviceidle whitelist +com.bigbotdrivers.app
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
maestro test --debug-output dbg store/reg/register.yaml
rc=$?
adb exec-out screencap -p > shots/zz_final.png
adb shell wm size > shots/size.txt
echo "rc=$rc" > shots/rc.txt
mkdir -p shots/dbg; find dbg ~/.maestro/tests -type f ( -name "*.png" -o -name "*.json" -o -name "*.log" ) 2>/dev/null | head -80 | while read f; do cp "$f" "shots/dbg/$(echo $f | tr / _ | tail -c 90)"; done; find . -maxdepth 4 -name "0*_*.png" -o -maxdepth 4 -name "x*_*.png" | head -40 > shots/found.txt; find store -name "*.png" -exec cp {} shots/ ; 2>/dev/null
exit 0
