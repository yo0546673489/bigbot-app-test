#!/usr/bin/env node
// SCREENS-LIB: lib/targets.json -> lib/t/<part>/<key>.yaml (one Maestro flow per screen).
// Run: node lib/gen.js   (commit the generated files; the runner only executes them)
const fs = require('fs'), path = require('path');
const T = JSON.parse(fs.readFileSync(path.join(__dirname, 'targets.json'), 'utf8'));
const q = (s) => JSON.stringify(s);
// Maestro matches the WHOLE text: a row "שם מלא, לא צוין" is not found by "שם מלא". Plain text -> .*text.*
const tapRe = (t) => (/[.*()|[\]]/.test(t) ? t : '.*' + t.replace(/[?+^${}\\]/g, '\\$&') + '.*');
for (const part of Object.keys(T).filter((k) => !k.startsWith('_'))) {
  const dir = path.join(__dirname, 't', part);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  for (const t of T[part]) {
    const y = ['appId: com.bigbotdrivers.app', `name: lib ${part} ${t.key}`, '---',
      '- launchApp:', '    stopApp: true', '    permissions:', '      all: allow',
      '- waitForAnimationToEnd:', '    timeout: 8000',
      '- tapOn:', '    text: "דלג"', '    optional: true',
      '- runFlow:', '    when:', '      visible: "ביגבוט בוואטסאפ"', '    commands:', '      - tapOn: "המשך"',
      '- tapOn:', '    text: "אחר כך"', '    optional: true'];
    for (const s of t.steps) {
      if (s.link) {
        y.push(`- openLink: ${q('bigbot://' + s.link)}`, '- tapOn:', '    text: "(פתיחה|Open|פתח)"', '    optional: true', '- waitForAnimationToEnd:', '    timeout: 8000');
      } else if (s.tap) {
        const re = tapRe(s.tap);
        y.push('- scrollUntilVisible:', '    element:', `      text: ${q(re)}`, '    direction: DOWN', '    timeout: 6000', '    optional: true',
          '- tapOn:', `    text: ${q(re)}`, '    optional: true', '- waitForAnimationToEnd:', '    timeout: 6000');
      } else if (s.point) {
        y.push('- tapOn:', `    point: ${q(s.point)}`, '- waitForAnimationToEnd:', '    timeout: 6000');
      } else if (s.scroll) {
        y.push('- scroll');
      } else if (s.back) {
        y.push('- tapOn:', '    text: "(חזרה|סגור)"', '    optional: true');
      }
    }
    y.push('- extendedWaitUntil:', '    visible: "__settle__"', '    timeout: 2500', '    optional: true');
    fs.writeFileSync(path.join(dir, `${t.key}.yaml`), y.join('\n') + '\n');
  }
  fs.writeFileSync(path.join(dir, '_expect.json'), JSON.stringify(Object.fromEntries(T[part].map((t) => [t.key, t.expect || '.'])), null, 1));
  console.log(part, T[part].length);
}
