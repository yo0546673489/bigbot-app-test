// Opens a file sealed by seal-file.js: iv + tag + data.
const c = require('crypto');
const fs = require('fs');
const [from, to] = process.argv.slice(2);
const k = c.createHash('sha256').update(process.env.EMU_LIVE_KEY).digest();
const box = fs.readFileSync(from);
const d = c.createDecipheriv('aes-256-gcm', k, box.subarray(0, 12));
d.setAuthTag(box.subarray(12, 28));
fs.writeFileSync(to, Buffer.concat([d.update(box.subarray(28)), d.final()]));
