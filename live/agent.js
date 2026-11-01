// Runs next to one emulator on a GitHub runner: answers signed requests from the tool on the PC.
// Only talks to the emulator through adb, never runs anything on the runner itself.
// Exits when nobody used it for IDLE_MIN minutes or after MAX_MIN minutes, and the job ends with it.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const KEY = process.env.EMU_LIVE_KEY;
const IDLE = Number(process.env.IDLE_MIN || 20) * 60000;
const MAX = Number(process.env.MAX_MIN || 180) * 60000;
const SERIAL = 'emulator-5554';
const ADB = path.join(process.env.ANDROID_HOME, 'platform-tools', 'adb');
const STATE = '/tmp/emu-state';
const UP = '/tmp/up';
const started = Date.now();
let lastUse = Date.now();
let readyAt = 0;
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
    execFile(ADB, ['-s', SERIAL, ...args], { timeout: timeoutSec * 1000, maxBuffer: 64 * 1024 * 1024, encoding }, (err, stdout, stderr) =>
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

http
  .createServer(async (req, res) => {
    try {
      if (!okSig(req)) return json(res, 403, { error: 'signature' });
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/status') {
        return json(res, 200, {
          state: state(),
          upMin: Math.round((Date.now() - started) / 60000),
          idleLeftMin: Math.round((IDLE - (Date.now() - lastUse)) / 60000),
          maxLeftMin: Math.round((MAX - (Date.now() - started)) / 60000),
        });
      }
      lastUse = Date.now();
      if (url.pathname === '/stop') {
        json(res, 200, { stopping: true });
        return setTimeout(() => process.exit(0), 500);
      }
      if (state() !== 'ready' && url.pathname !== '/upload') return json(res, 409, { error: 'not ready', state: state() });
      if (url.pathname === '/shell') {
        const { cmd, timeoutSec } = JSON.parse((await body(req)).toString('utf8'));
        const r = await adb(['shell', cmd], Math.min(Number(timeoutSec) || 60, 600), 'utf8');
        return json(res, 200, r);
      }
      if (url.pathname === '/shot') {
        const r = await adb(['exec-out', 'screencap', '-p'], 30, 'buffer');
        if (r.code !== 0 || !r.stdout.length) return json(res, 500, { error: String(r.stderr) });
        res.writeHead(200, { 'content-type': 'image/png' });
        return res.end(r.stdout);
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
        const r = await adb(['install', '-r', '-g', path.join(UP, name)], 300, 'utf8');
        return json(res, 200, r);
      }
      if (url.pathname === '/push') {
        const name = path.basename(url.searchParams.get('name'));
        const r = await adb(['push', path.join(UP, name), url.searchParams.get('to')], 300, 'utf8');
        return json(res, 200, r);
      }
      return json(res, 404, { error: 'unknown' });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  })
  .listen(8787, '127.0.0.1');

setInterval(() => {
  if (state() === 'ready' && !readyAt) {
    readyAt = Date.now();
    lastUse = Date.now(); // the idle clock starts only when the emulator is usable
  }
  if (state() === 'failed') process.exit(1);
  if (Date.now() - started > MAX) process.exit(0);
  if (readyAt && Date.now() - lastUse > IDLE) process.exit(0);
}, 15000);
