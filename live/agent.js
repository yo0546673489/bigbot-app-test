// Runs next to one emulator on a GitHub runner: answers signed requests from the tool on the PC.
// Only talks to the emulator through adb, never runs anything else on the runner for a caller.
// Waits unclaimed for POOL_TTL_MIN, then belongs to one session and exits when that session stops using it.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFile, spawnSync } = require('child_process');

const KEY = process.env.EMU_LIVE_KEY;
const POOL_TTL = Number(process.env.POOL_TTL_MIN || 40) * 60000;
const SERIAL = 'emulator-5554';
const ADB = path.join(process.env.ANDROID_HOME, 'platform-tools', 'adb');
const STATE = '/tmp/emu-state';
const UP = '/tmp/up';
const PKG = 'com.bigbotdrivers.app';
const REPO = process.env.GITHUB_REPOSITORY;
// The demo account the store reviewers also use. The code stays in this process: it is never
// answered back, printed or written anywhere a caller can read, and nothing started from here inherits it.
const DEMO_CODE = /^\d{6}$/.test(process.env.DEMO_CODE || '') ? process.env.DEMO_CODE : '';
delete process.env.DEMO_CODE;
const DEMO_PHONE = '0500000000';
const UI_FILE = '/data/local/tmp/ui.xml';
const login = { running: false, result: null, sends: 0 };
const started = Date.now();
let readyAt = 0;
let claimedBy = '';
let claimedAt = 0;
let idle = 20 * 60000;
let max = 180 * 60000;
let lastUse = Date.now();
fs.mkdirSync(UP, { recursive: true });

const state = () => {
  try {
    return fs.readFileSync(STATE, 'utf8').trim();
  } catch {
    return 'starting';
  }
};

function okSig(req) {
  const ts = Number(req.headers['x-ts']);
  if (!ts || Math.abs(Date.now() - ts) > 180000) return false;
  const want = crypto.createHmac('sha256', KEY).update(`${ts}\n${req.method}\n${req.url}`).digest();
  const got = Buffer.from(String(req.headers['x-sig'] || ''), 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

const adb = (args, timeoutSec, encoding) =>
  new Promise((resolve) => {
    execFile(ADB, ['-s', SERIAL, ...args], { timeout: timeoutSec * 1000, maxBuffer: 128 * 1024 * 1024, encoding }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr: stderr || (err ? String(err.message) : '') }),
    );
  });

const body = (req) =>
  new Promise((resolve, reject) => {
    const parts = [];
    req.on('data', (d) => parts.push(d));
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });

const json = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
};

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

// The picture itself is taken raw and packed here: much faster than PNG inside the emulator.
function toPng(raw, step) {
  const w = raw.readUInt32LE(0);
  const h = raw.readUInt32LE(4);
  const offset = raw.length - w * h * 4;
  const W = Math.floor(w / step);
  const H = Math.floor(h / step);
  const rows = Buffer.alloc((W * 3 + 1) * H);
  let o = 0;
  for (let y = 0; y < H; y++) {
    rows[o++] = 0;
    let p = offset + y * step * w * 4;
    for (let x = 0; x < W; x++) {
      rows[o++] = raw[p];
      rows[o++] = raw[p + 1];
      rows[o++] = raw[p + 2];
      p += step * 4;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(rows, { level: 1 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function rawShot() {
  const r = await adb(['exec-out', 'screencap'], 30, 'buffer');
  if (r.code !== 0 || r.stdout.length < 100) throw new Error(`screencap: ${r.stderr}`);
  return r.stdout;
}

const hash = (raw) => crypto.createHash('md5').update(raw.subarray(raw.length - raw.readUInt32LE(0) * (raw.readUInt32LE(4) - 120) * 4)).digest('hex'); // without the status bar and its clock

// Returns as soon as the picture stopped changing, right here next to the emulator.
async function settle(quietMs = 1200, timeoutMs = 25000) {
  const until = Date.now() + timeoutMs;
  let prev = '';
  let since = Date.now();
  for (;;) {
    const h = hash(await rawShot());
    if (h !== prev) {
      prev = h;
      since = Date.now();
    } else if (Date.now() - since >= quietMs) {
      return true;
    }
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, 150));
  }
}

// The emulator holds only test data, so an app that refuses to replace the one there (older version, other key) replaces it anyway.
async function installApk(file) {
  const r = await adb(['install', '-r', '-g', file], 300, 'utf8');
  if (r.code === 0) return r;
  await adb(['uninstall', PKG], 60, 'utf8');
  return adb(['install', '-g', file], 300, 'utf8');
}

// Several actions in one request, so one network trip instead of many.
async function runSteps(steps) {
  const out = [];
  for (const s of steps) {
    const t = Date.now();
    let r = {};
    if (s.sh !== undefined) r = await adb(['shell', s.sh], Math.min(Number(s.timeoutSec) || 60, 600), 'utf8');
    else if (s.tap) r = await adb(['shell', `input tap ${s.tap.map(Number).join(' ')}`], 30, 'utf8');
    else if (s.swipe) r = await adb(['shell', `input swipe ${s.swipe.map(Number).join(' ')}`], 30, 'utf8');
    else if (s.text !== undefined) r = await adb(['shell', `input text '${String(s.text).replace(/'/g, `'\\''`).replace(/ /g, '%s')}'`], 30, 'utf8');
    else if (s.key) r = await adb(['shell', `input keyevent ${String(s.key).replace(/\W/g, '')}`], 30, 'utf8');
    else if (s.wait) await new Promise((res) => setTimeout(res, Math.min(Number(s.wait), 60000)));
    else if (s.settle) r = { settled: await settle(Number(s.settle.quietMs) || 1200, Number(s.settle.timeoutMs) || 25000) };
    else if (s.shot) {
      const png = toPng(await rawShot(), s.shot.half ? 2 : 1);
      r = { png: png.toString('base64'), name: s.shot.name };
    }
    out.push({ ...r, ms: Date.now() - t });
    if (r.code) break;
  }
  return out;
}

async function readScreen() {
  await adb(['shell', `uiautomator dump ${UI_FILE}`], 30, 'utf8');
  const r = await adb(['exec-out', 'cat', UI_FILE], 20, 'utf8');
  await adb(['shell', `rm -f ${UI_FILE}`], 10, 'utf8');
  const nodes = [];
  for (const m of String(r.stdout).matchAll(/<node\b[^>]*>/g)) {
    const attr = (k) => (m[0].match(new RegExp(`\\b${k}="([^"]*)"`)) || [])[1] || '';
    const b = attr('bounds').match(/\d+/g);
    if (!b) continue;
    nodes.push({ text: attr('text'), edit: /EditText/.test(attr('class')), x: (Number(b[0]) + Number(b[2])) >> 1, y: (Number(b[1]) + Number(b[3])) >> 1 });
  }
  return nodes;
}

// What the screen says, for the session to understand a failure. Only digits (a typed code) are left out.
const labels = (nodes) =>
  nodes
    .map((n) => n.text.split(DEMO_CODE || '\0').join('***'))
    .filter((t) => t && !/^\d{1,6}$/.test(t))
    .slice(0, 20);

// Follows flows/00_login.yaml. Asks for a code once and types it once, never again by itself:
// the server allows 8 requests an hour for this account, and the store reviewers need them too.
async function signIn() {
  const tap = (n) => adb(['shell', `input tap ${n.x} ${n.y}`], 30, 'utf8');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let sent = 0;
  let typed = 0;
  let verified = false;
  let phoneTyped = false;
  let doneReads = 0;
  const end = async (o, nodes = []) => {
    if (!o.ok) await adb(['shell', `am force-stop ${PKG}`], 30, 'utf8'); // a typed code must not stay on the screen
    await adb(['shell', 'logcat -c'], 20, 'utf8');
    return { ...o, sent: !!sent, screen: labels(nodes) };
  };
  if (!DEMO_CODE) return end({ ok: false, reason: 'no code on this machine' });
  const opened = Date.now();
  const until = opened + 170000;
  await adb(['shell', `am start -W -n $(cmd package resolve-activity --brief ${PKG} | tail -1)`], 60, 'utf8');
  while (Date.now() < until) {
    const nodes = await readScreen();
    const find = (t) => nodes.find((n) => n.text === t);
    const field = nodes.find((n) => n.edit);
    const form = find('שלחו לי קוד');
    const codeScreen = find('אמת והמשך') || (sent && !typed && !form && nodes.some((n) => /קוד/.test(n.text)));
    const home = nodes.some((n) => /פנוי/.test(n.text)); // "signed in" only when the home screen is really there
    if (find('יש אישור')) {
      await tap(find('יש אישור')); // Android asking about notifications, after the app's data was cleared
    } else if (find('דלג')) {
      await tap(find('דלג'));
    } else if (form && !sent) {
      if (!field) return end({ ok: false, reason: 'no phone field' }, nodes);
      if (field.text.replace(/\D/g, '') !== DEMO_PHONE) { // the app shows it with dashes
        if (phoneTyped) return end({ ok: false, reason: 'phone was not typed' }, nodes);
        await tap(field);
        await adb(['shell', `input text ${DEMO_PHONE}`], 30, 'utf8');
        phoneTyped = true;
      } else {
        if (login.sends >= 2) return end({ ok: false, reason: 'this machine already asked twice' }, nodes);
        login.sends++;
        sent = Date.now();
        await tap(form);
      }
    } else if (form) {
      if (Date.now() - sent > 25000) return end({ ok: false, reason: 'server did not move on to the code screen' }, nodes);
    } else if (!sent && find('התחברות') && find('הרשמה')) {
      await tap(find('התחברות'));
    } else if (!sent) {
      if (home) return end({ ok: true, already: true }, nodes);
      if (Date.now() - opened > 40000) return end({ ok: false, reason: 'unknown screen' }, nodes);
    } else if (!typed) {
      if (codeScreen) {
        await tap(field || { x: 540, y: 864 });
        await adb(['shell', `input text ${DEMO_CODE}`], 30, 'utf8');
        typed = Date.now();
      } else if (Date.now() - sent > 25000) {
        return end({ ok: false, reason: 'code screen did not open' }, nodes);
      }
    } else if (codeScreen) {
      if (find('אמת והמשך') && !verified && Date.now() - typed > 1500) {
        verified = true;
        await tap(find('אמת והמשך'));
      }
      if (Date.now() - typed > 30000) return end({ ok: false, reason: 'code was not accepted' }, nodes);
    } else if (home && ++doneReads >= 2) {
      return end({ ok: true }, nodes);
    }
    await wait(1200);
  }
  return end({ ok: false, reason: 'took too long' }, await readScreen());
}

function startLogin() {
  if (login.running || (login.result && login.result.ok)) return;
  login.running = true;
  login.result = null;
  signIn()
    .catch(() => ({ ok: false, reason: 'unexpected failure', sent: login.sends > 0, screen: [] }))
    .then((r) => {
      login.result = r;
      login.running = false;
    });
}

http
  .createServer(async (req, res) => {
    try {
      if (!okSig(req)) return json(res, 403, { error: 'signature' });
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/status') {
        return json(res, 200, {
          state: state(),
          claimedBy,
          upMin: Math.round((Date.now() - started) / 60000),
          idleLeftMin: claimedBy ? Math.round((idle - (Date.now() - lastUse)) / 60000) : null,
          maxLeftMin: claimedBy ? Math.round((max - (Date.now() - claimedAt)) / 60000) : null,
        });
      }
      if (url.pathname === '/claim') {
        const { session, idleMin, maxMin } = JSON.parse((await body(req)).toString('utf8'));
        if (claimedBy && claimedBy !== session) return json(res, 409, { error: 'taken' });
        if (state() !== 'ready') return json(res, 425, { state: state() });
        if (!claimedBy) {
          claimedBy = session;
          claimedAt = Date.now();
          idle = Math.min(Number(idleMin) || 20, 120) * 60000;
          max = Math.min(Number(maxMin) || 180, 300) * 60000;
        }
        lastUse = Date.now();
        return json(res, 200, { ok: true, state: state(), upMin: Math.round((Date.now() - started) / 60000) });
      }
      lastUse = Date.now();
      if (url.pathname === '/stop') {
        json(res, 200, { stopping: true });
        return setTimeout(() => process.exit(0), 300);
      }
      if (state() !== 'ready') return json(res, 409, { error: 'not ready', state: state() });
      // A long request would die in the tunnel, so the PC starts this and then asks how it went.
      if (url.pathname === '/login') {
        startLogin();
        return json(res, 200, { running: login.running, result: login.result });
      }
      if (url.pathname === '/login-state') return json(res, 200, { running: login.running, result: login.result });
      // Nothing can see the screen while the code is on it.
      if (login.running) return json(res, 423, { error: 'signing in' });
      if (url.pathname === '/batch') {
        const { steps } = JSON.parse((await body(req)).toString('utf8'));
        return json(res, 200, { results: await runSteps(steps) });
      }
      if (url.pathname === '/shell') {
        const { cmd, timeoutSec } = JSON.parse((await body(req)).toString('utf8'));
        return json(res, 200, await adb(['shell', cmd], Math.min(Number(timeoutSec) || 60, 600), 'utf8'));
      }
      if (url.pathname === '/shot') {
        const png = toPng(await rawShot(), url.searchParams.get('half') ? 2 : 1);
        res.writeHead(200, { 'content-type': 'image/png' });
        return res.end(png);
      }
      if (url.pathname === '/pull') {
        const r = await adb(['exec-out', 'cat', url.searchParams.get('path')], 120, 'buffer');
        res.writeHead(r.code === 0 ? 200 : 500);
        return res.end(r.stdout);
      }
      if (url.pathname === '/upload') {
        const name = path.basename(url.searchParams.get('name'));
        const data = await body(req);
        if (url.searchParams.get('part') === '0') fs.writeFileSync(path.join(UP, name), data);
        else fs.appendFileSync(path.join(UP, name), data);
        return json(res, 200, { bytes: fs.statSync(path.join(UP, name)).size });
      }
      if (url.pathname === '/install') {
        const name = path.basename(url.searchParams.get('name'));
        return json(res, 200, await installApk(path.join(UP, name)));
      }
      if (url.pathname === '/push') {
        const name = path.basename(url.searchParams.get('name'));
        return json(res, 200, await adb(['push', path.join(UP, name), url.searchParams.get('to')], 300, 'utf8'));
      }
      // A build made by emu-build.yml goes straight from GitHub to the emulator, never through the PC.
      if (url.pathname === '/install-run') {
        const run = String(Number(url.searchParams.get('run')));
        const dir = `/tmp/build-${run}`;
        const d = spawnSync('gh', ['run', 'download', run, '-R', REPO, '-n', 'apk', '-D', dir], { encoding: 'utf8' });
        if (d.status !== 0) return json(res, 500, { code: 1, stderr: d.stderr });
        const box = fs.readFileSync(path.join(dir, 'app.bin'));
        const k = crypto.createHash('sha256').update(KEY).digest();
        const dec = crypto.createDecipheriv('aes-256-gcm', k, box.subarray(0, 12));
        dec.setAuthTag(box.subarray(12, 28));
        fs.writeFileSync('/tmp/build.apk', Buffer.concat([dec.update(box.subarray(28)), dec.final()]));
        return json(res, 200, await installApk('/tmp/build.apk'));
      }
      return json(res, 404, { error: 'unknown' });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  })
  .listen(8787, '127.0.0.1');

setInterval(() => {
  const s = state();
  if (s === 'ready' && !readyAt) readyAt = Date.now();
  if (s === 'failed') process.exit(1);
  if (!claimedBy) {
    if (readyAt && Date.now() - readyAt > POOL_TTL) process.exit(0);
    if (Date.now() - started > POOL_TTL + 20 * 60000) process.exit(0);
    return;
  }
  if (Date.now() - claimedAt > max || Date.now() - lastUse > idle) process.exit(0);
}, 10000);
