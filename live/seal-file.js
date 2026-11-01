// Seals a file with EMU_LIVE_KEY before it goes to a public artifact: iv + tag + data.
const c = require('crypto');
const fs = require('fs');
const [from, to] = process.argv.slice(2);
const k = c.createHash('sha256').update(process.env.EMU_LIVE_KEY).digest();
const iv = c.randomBytes(12);
const a = c.createCipheriv('aes-256-gcm', k, iv);
const ct = Buffer.concat([a.update(fs.readFileSync(from)), a.final()]);
fs.writeFileSync(to, Buffer.concat([iv, a.getAuthTag(), ct]));
