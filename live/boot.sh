#!/bin/bash
# Resumes the saved emulator, puts the latest app on it, and only then says it is ready.
# No "set -e": commands answer with errors for a moment around a restart, and that is not a failure.
set +e
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
A="adb -s emulator-5554"
OPTS="-no-window -gpu swiftshader_indirect -no-audio -no-boot-anim -camera-back none -camera-front none -no-metrics -timezone Asia/Jerusalem"
fail() { echo failed > /tmp/emu-state; exit 1; }
wait_boot() {
  local until=$(( $(date +%s) + $1 ))
  while [ "$($A shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" != "1" ]; do
    [ "$(date +%s)" -gt "$until" ] && return 1
    sleep 1
  done
}
retry() { for i in 1 2 3 4 5; do "$@" && return 0; sleep 3; done; return 1; }
echo booting > /tmp/emu-state
s=$(date +%s)
nohup emulator -avd e1 -port 5554 $OPTS -snapshot ready -no-snapshot-save > /tmp/emulator.log 2>&1 &
if ! wait_boot 120; then
  # the saved state did not fit this machine: a normal start from zero
  pkill -f qemu-system; sleep 3
  nohup emulator -avd e1 -port 5554 $OPTS -no-snapshot-load -no-snapshot-save > /tmp/emulator.log 2>&1 &
  wait_boot 300 || fail
fi
echo "emulator up after $(( $(date +%s)-s )) s"
retry $A root >/dev/null
sleep 1
wait_boot 60 || fail
$A shell "cmd alarm set-timezone Asia/Jerusalem" >/dev/null
$A shell "date -u $(date -u +%m%d%H%M%Y.%S)" >/dev/null
echo installing > /tmp/emu-state
curl -sL "$APK_URL" -o /tmp/app.apk
retry $A install -r -g /tmp/app.apk >/dev/null || fail
rm -f /tmp/app.apk
$A shell pm path com.bigbotdrivers.app >/dev/null || fail
echo "ready after $(( $(date +%s)-s )) s"
echo ready > /tmp/emu-state
