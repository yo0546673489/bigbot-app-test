// A live iPhone simulator for one person: a page that shows the screen every second and passes
// taps, swipes and typed text to the simulator. Every request needs the random token that only
// the sealed connection file holds. Typed text is never printed or written anywhere.
const http = require('http');
const { execFile } = require('child_process');
const fs = require('fs');

const TOKEN = process.env.LIVE_TOKEN;
const UDID = process.env.SIM_UDID;
const MAX_MS = Number(process.env.LIVE_MAX_MIN || 90) * 60000;
const started = Date.now();
let pts = { w: 0, h: 0 };
let useIdb = true;

const run = (cmd, args, timeout = 20000) =>
  new Promise((res) => execFile(cmd, args, { timeout, maxBuffer: 20 << 20 }, (e, out, err) => res({ ok: !e, out: String(out || ''), err: String(err || '') })));

async function points() {
  if (pts.w) return pts;
  const r = await run('idb', ['describe', '--udid', UDID, '--json']);
  try {
    const d = JSON.parse(r.out).screen_dimensions;
    pts = { w: d.width_points, h: d.height_points };
  } catch {
    useIdb = false;
    pts = { w: 428, h: 926 };
  }
  return pts;
}

async function maestro(yaml) {
  const f = `/tmp/live-step-${Date.now()}.yaml`;
  fs.writeFileSync(f, `appId: com.bigbotdrivers.app\n---\n${yaml}\n`);
  const r = await run('maestro', ['--device', UDID, 'test', f], 60000);
  fs.unlinkSync(f);
  return r.ok;
}

async function tap(fx, fy, long) {
  const p = await points();
  const x = Math.round(fx * p.w), y = Math.round(fy * p.h);
  if (useIdb) {
    const r = await run('idb', ['ui', 'tap', '--udid', UDID, ...(long ? ['--duration', '1.2'] : []), String(x), String(y)]);
    if (r.ok) return true;
  }
  return maestro(`- ${long ? 'longPressOn' : 'tapOn'}:\n    point: "${Math.round(fx * 100)}%,${Math.round(fy * 100)}%"`);
}

async function swipe(dir) {
  const p = await points();
  const cx = Math.round(p.w / 2);
  const [y1, y2] = dir === 'up' ? [p.h * 0.7, p.h * 0.3] : [p.h * 0.3, p.h * 0.7];
  if (useIdb) {
    const r = await run('idb', ['ui', 'swipe', '--udid', UDID, String(cx), String(Math.round(y1)), String(cx), String(Math.round(y2))]);
    if (r.ok) return true;
  }
  return maestro(`- swipe:\n    direction: ${dir === 'up' ? 'UP' : 'DOWN'}`);
}

async function type(text) {
  if (useIdb) {
    const r = await run('idb', ['ui', 'text', '--udid', UDID, text]);
    if (r.ok) return true;
  }
  return maestro(`- inputText: ${JSON.stringify(text)}`);
}

async function key(name) {
  if (name === 'home') return run('idb', ['ui', 'button', '--udid', UDID, 'HOME']).then((r) => r.ok || maestro('- pressKey: home'));
  if (name === 'enter') return run('idb', ['ui', 'key', '--udid', UDID, '40']).then((r) => r.ok || maestro('- pressKey: enter'));
  if (name === 'back') return maestro('- back');
  if (name === 'delete') return run('idb', ['ui', 'key', '--udid', UDID, '42']).then((r) => r.ok || maestro('- eraseText: 1'));
  return false;
}

const PAGE = `<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>אייפון בענן</title><style>
body{margin:0;font-family:system-ui,Arial;background:#f3f6f4;color:#1f2a22;display:flex;flex-direction:column;align-items:center;gap:10px;padding:12px}
#s{max-height:78vh;max-width:96vw;border-radius:22px;box-shadow:0 4px 20px #0003;cursor:pointer;touch-action:manipulation}
.row{display:flex;gap:8px;flex-wrap:wrap;justify-content:center}
button{font-size:16px;padding:10px 14px;border-radius:12px;border:0;background:#1F7A47;color:#fff}
button.g{background:#e3ebe6;color:#1f2a22}
input{font-size:18px;padding:10px;border-radius:12px;border:1px solid #9bb;width:220px;direction:ltr}
#m{font-size:14px;min-height:18px}
</style></head><body>
<div>לחיצה על התמונה = לחיצה על המסך. לחיצה ארוכה: החזק את העכבר שנייה.</div>
<img id="s" alt="מסך האייפון">
<div class="row"><input id="t" type="password" autocomplete="off" placeholder="מה להקליד"><button id="send">הקלד</button><button class="g" id="show">הצג/הסתר</button></div>
<div class="row"><button class="g" data-k="enter">אנטר</button><button class="g" data-k="delete">מחק תו</button><button class="g" data-sw="up">גלול למטה</button><button class="g" data-sw="down">גלול למעלה</button><button class="g" data-k="home">מסך הבית</button></div>
<div id="m"></div>
<script>
const T=new URLSearchParams(location.search).get('t');const img=document.getElementById('s');const m=document.getElementById('m');
let busy=false;function load(){if(busy)return;busy=true;const n=new Image();n.onload=()=>{img.src=n.src;busy=false};n.onerror=()=>{busy=false};n.src='shot?t='+T+'&_='+Date.now()}
setInterval(load,900);load();
let down=0;img.addEventListener('mousedown',()=>down=Date.now());
img.addEventListener('click',e=>{const r=img.getBoundingClientRect();const fx=(e.clientX-r.left)/r.width,fy=(e.clientY-r.top)/r.height;const long=Date.now()-down>700;
m.textContent=long?'לחיצה ארוכה...':'לוחץ...';fetch('tap?t='+T,{method:'POST',body:JSON.stringify({fx,fy,long})}).then(r=>m.textContent=r.ok?'':'הלחיצה לא עברה')});
document.getElementById('send').onclick=()=>{const i=document.getElementById('t');const v=i.value;if(!v)return;m.textContent='מקליד...';
fetch('type?t='+T,{method:'POST',body:JSON.stringify({text:v})}).then(r=>{m.textContent=r.ok?'הוקלד':'לא הוקלד';i.value=''})};
document.getElementById('show').onclick=()=>{const i=document.getElementById('t');i.type=i.type==='password'?'text':'password'};
document.querySelectorAll('[data-k]').forEach(b=>b.onclick=()=>fetch('key?t='+T,{method:'POST',body:JSON.stringify({k:b.dataset.k})}));
document.querySelectorAll('[data-sw]').forEach(b=>b.onclick=()=>fetch('swipe?t='+T,{method:'POST',body:JSON.stringify({d:b.dataset.sw})}));
</script></body></html>`;

function body(req) {
  return new Promise((res) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 1e5) req.destroy(); });
    req.on('end', () => { try { res(JSON.parse(s || '{}')); } catch { res({}); } });
  });
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (!TOKEN || u.searchParams.get('t') !== TOKEN) { res.writeHead(404); return res.end(); }
  try {
    if (u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(PAGE); }
    if (u.pathname === '/shot') {
      const f = '/tmp/live-shot.jpg';
      await run('xcrun', ['simctl', 'io', UDID, 'screenshot', '--type=jpeg', f]);
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' });
      return res.end(fs.readFileSync(f));
    }
    if (u.pathname === '/info') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ pts: await points(), useIdb, upMin: Math.round((Date.now() - started) / 60000) })); }
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    const b = await body(req);
    let ok = false;
    if (u.pathname === '/tap') ok = await tap(Math.min(1, Math.max(0, +b.fx)), Math.min(1, Math.max(0, +b.fy)), !!b.long);
    else if (u.pathname === '/type' && typeof b.text === 'string') ok = await type(b.text.slice(0, 200));
    else if (u.pathname === '/key') ok = await key(String(b.k));
    else if (u.pathname === '/swipe') ok = await swipe(b.d === 'up' ? 'up' : 'down');
    else if (u.pathname === '/stop') { fs.writeFileSync('/tmp/live-stop', '1'); ok = true; }
    res.writeHead(ok ? 200 : 500); res.end();
  } catch { res.writeHead(500); res.end(); }
}).listen(8788, '127.0.0.1');

setInterval(() => { if (Date.now() - started > MAX_MS) fs.writeFileSync('/tmp/live-stop', '1'); }, 30000);
