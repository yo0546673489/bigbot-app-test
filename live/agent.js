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
        return json(res, 200, await adb(['install', '-r', '-g', path.join(UP, name)], 300, 'utf8'));
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
        return json(res, 200, await adb(['install', '-r', '-g', '/tmp/build.apk'], 300, 'utf8'));
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
void PKG;
