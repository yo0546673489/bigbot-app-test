#!/bin/bash
# First time only: builds the emulator once in a good state and saves that state, so the next ones just resume it.
set +e
AVD="$ANDROID_AVD_HOME/e1.avd"
if [ -d "$AVD/snapshots/ready" ]; then
  echo resumed from cache
  exit 0
fi
OPTS="-no-window -gpu swiftshader_indirect -no-audio -no-boot-anim -camera-back none -camera-front none -no-metrics"
S=$ANDROID_HOME/cmdline-tools/latest/bin
yes | $S/sdkmanager --licenses >/dev/null
$S/sdkmanager --install "platform-tools" "emulator" "system-images;android-34;google_apis;x86_64" >/dev/null || exit 1
rm -rf "$AVD"
mkdir -p "$ANDROID_AVD_HOME"
echo no | $S/avdmanager create avd -n e1 -k "system-images;android-34;google_apis;x86_64" -d pixel_6 -p "$AVD" >/dev/null
printf 'hw.ramSize=3072\nvm.heapSize=256\nhw.cpu.ncore=3\ndisk.dataPartition.size=6G\n' >> "$AVD/config.ini"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
nohup emulator -avd e1 -port 5554 $OPTS > /tmp/emulator-first.log 2>&1 &
wait_boot() {
  local until=$(( $(date +%s) + 300 ))
  while [ "$(adb -s emulator-5554 shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" != "1" ]; do
    [ "$(date +%s)" -gt "$until" ] && return 1
    sleep 2
  done
}
wait_boot || exit 1
adb -s emulator-5554 root >/dev/null; sleep 3; wait_boot || exit 1
adb -s emulator-5554 shell "setprop persist.sys.locale he-IL; setprop ctl.restart zygote"
sleep 8; wait_boot || exit 1
adb -s emulator-5554 root >/dev/null; sleep 2
adb -s emulator-5554 shell "settings put system screen_off_timeout 1800000; settings put global window_animation_scale 0; settings put global transition_animation_scale 0; settings put global animator_duration_scale 0; svc power stayon true"
sleep 25 # let the first-run work calm down, so the saved state is a quiet one
# whatever is only a copy of the disk does not need to be in the saved memory: a smaller file means a faster start for all
adb -s emulator-5554 shell "sync; echo 3 > /proc/sys/vm/drop_caches; fstrim /data"
sleep 2
adb -s emulator-5554 emu avd snapshot save ready
sleep 3
adb -s emulator-5554 emu kill
for i in $(seq 1 30); do pgrep -f qemu-system >/dev/null || break; sleep 1; done
rm -f "$AVD"/*.lock "$AVD"/*/*.lock
echo "new=true" >> "$GITHUB_OUTPUT"
