// Flabber: tennis matches ("!tennis @sam" / "let's play a game of tennis against Sam").
// A member's agent calls the `tennis` tool with an opponent; Flabber makes a room, DMs the opponent a join link and returns the host's link. Both open the page
// (/tennis?t=<token>), which loads the game (the tennis42 widget, host + guest roles) and connects a WebSocket (/tennis/ws?t=<token>) to this relay. The relay
// only passes small JSON messages between the two sides of one room; the host's browser runs the game, nothing about the game lives here.
// The game bundle and its picture are NOT part of this repository: put your own build in public/ (tennis42.js, gandalf-amber.png).
// A token names ONE room and ONE side and expires: it is the only credential the page needs (the pair's own credentials never reach the browser page).
import crypto from 'node:crypto';
import fs from 'node:fs';
import { WebSocketServer } from 'ws';

const TTL_MS = 45 * 60 * 1000;        // an invite is good for 45 minutes
const MAX_MSG = 2048;                 // bytes per message (a state message is ~150)
const MAX_PER_SEC = 120;              // messages per second per socket (the host sends ~30)
const rooms = new Map();              // room id -> { host, guest, names, created, exp }

export function tennisSetup({ app, server, secretHex, bundleFile, gandalfFile, allowedHosts, log = console }) {
  const key = crypto.createHmac('sha256', Buffer.from(secretHex, 'hex')).update('flabber-tennis-v1').digest();
  const mac = (s) => crypto.createHmac('sha256', key).update(s).digest('base64url').slice(0, 24);
  const token = (room, side, exp) => { const body = `${room}.${side}.${exp}`; return `${body}.${mac(body)}`; };
  const parse = (t) => {
    const p = String(t || '').split('.');
    if (p.length !== 4 || !/^[a-z0-9]{10}$/.test(p[0]) || (p[1] !== 'host' && p[1] !== 'guest')) return null;
    const exp = Number(p[2]); if (!Number.isFinite(exp) || exp < Date.now()) return null;
    const good = mac(`${p[0]}.${p[1]}.${p[2]}`), a = Buffer.from(good), b = Buffer.from(p[3]);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    return { room: p[0], side: p[1], exp };
  };

  // called by the `tennis` tool: a room + one link per side
  function newMatch(base, hostName, guestName) {
    const room = crypto.randomBytes(8).toString('hex').slice(0, 10).replace(/[^a-z0-9]/g, 'a');
    const exp = Date.now() + TTL_MS;
    rooms.set(room, { host: null, guest: null, names: { host: hostName, guest: guestName }, created: Date.now(), exp });
    return { room, hostUrl: `${base}/tennis?t=${token(room, 'host', exp)}`, guestUrl: `${base}/tennis?t=${token(room, 'guest', exp)}`, expires: new Date(exp).toISOString() };
  }

  // the page + the game script (plain GET, no credentials: without a valid token the page only says so)
  app.get('/tennis/game.js', (req, res) => { try { res.type('application/javascript').set('Cache-Control', 'no-cache').send(fs.readFileSync(bundleFile)); } catch { res.status(404).end(); } });
  app.get('/tennis/gandalf-amber.png', (req, res) => { try { res.type('image/png').set('Cache-Control', 'public, max-age=86400').send(fs.readFileSync(gandalfFile)); } catch { res.status(404).end(); } });
  app.get('/tennis', (req, res) => {
    res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex' });
    res.send(PAGE);
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MSG });
  server.on('upgrade', (req, socket, head) => {
    let u; try { u = new URL(req.url, 'http://x'); } catch { return socket.destroy(); }
    if (u.pathname !== '/tennis/ws') return;   // other upgrades are not ours (there are none today)
    const origin = String(req.headers.origin || ''), okOrigin = !origin || allowedHosts.some((h) => origin === `https://${h}`);
    const t = parse(u.searchParams.get('t')), r = t && rooms.get(t.room);
    if (!okOrigin || !t || !r) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return socket.destroy(); }
    wss.handleUpgrade(req, socket, head, (ws) => join(ws, t, r, origin || ('https://' + String(req.headers.host || ''))));
  });

  function join(ws, t, r, base) {
    const side = t.side, other = side === 'host' ? 'guest' : 'host';
    // the guest link is an OPEN SEAT (first come, nobody else can take it while it is occupied); the host's own window may replace itself (a reload)
    if (side === 'guest' && r.guest && r.guest.readyState === 1 && r.guest.isAlive !== false) { try { ws.close(4001, 'seat taken'); } catch {} return; }
    if (r[side] && r[side] !== ws) { try { r[side].close(4000, 'replaced'); } catch {} }
    r[side] = ws; ws._n = 0; ws._t0 = Date.now(); ws.isAlive = true;
    const send = (sock, obj) => { try { if (sock && sock.readyState === 1) sock.send(JSON.stringify(obj)); } catch {} };
    send(ws, { t: 'hello', side, you: r.names[side], opponent: r.names[other], peer: !!(r[other] && r[other].readyState === 1), ...(side === 'host' ? { seat: `${base}/tennis?t=${token(t.room, 'guest', r.exp)}` } : {}) });
    send(r[other], { t: 'peer', up: true, name: r.names[side] });
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      if (Date.now() - ws._t0 > 1000) { ws._t0 = Date.now(); ws._n = 0; }
      if (++ws._n > MAX_PER_SEC) return;
      const s = data.toString();
      if (s.length > MAX_MSG) return;
      const o = r[other]; if (o && o.readyState === 1) o.send(s);   // opaque: the game on the other side decides what it means
    });
    ws.on('close', () => { if (r[side] === ws) { r[side] = null; send(r[other], { t: 'peer', up: false, name: r.names[side] }); } });
  }

  setInterval(() => {   // heartbeat + room sweep
    const now = Date.now();
    for (const [id, r] of rooms) {
      for (const side of ['host', 'guest']) { const ws = r[side]; if (!ws) continue; if (!ws.isAlive) { try { ws.terminate(); } catch {} r[side] = null; continue; } ws.isAlive = false; try { ws.ping(); } catch {} }
      if (now > r.exp + 10 * 60 * 1000 || (!r.host && !r.guest && now > r.exp)) { for (const side of ['host', 'guest']) { try { r[side]?.close(); } catch {} } rooms.delete(id); }
    }
  }, 20000).unref();

  log.log('[tennis] relay ready');
  return { newMatch, rooms };
}

const PAGE = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tennis · Flabber</title>
<link rel="icon" href="/favicon-32.png"><style>
html,body{margin:0;height:100%;background:#161513;color:#ec9068;font:14px/1.4 ui-monospace,Menlo,Consolas,monospace}
#wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px}
#bar{letter-spacing:.12em;text-transform:uppercase;font-size:12px;opacity:.85;min-height:18px;text-align:center}
#box{position:relative;width:min(94vw,calc((100vh - 90px) * 1.6));aspect-ratio:16/10;border-radius:14px;overflow:hidden;background:#0a0a0a}
#share{font-size:12px;letter-spacing:.06em;opacity:.9;display:flex;gap:10px;align-items:center}#share button{all:unset;cursor:pointer;border:1px solid #ec9068;border-radius:999px;padding:3px 12px;color:#ec9068}
#msg{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;pointer-events:none;letter-spacing:.1em}
</style></head><body><div id="wrap"><div id="bar">tennis</div><div id="box"><div id="msg">connecting…</div></div><div id="share" style="display:none"></div></div>
<script src="/tennis/game.js"></script>
<script>
(function () {
  var q = new URLSearchParams(location.search), t = q.get('t') || '', bar = document.getElementById('bar'), msg = document.getElementById('msg'), box = document.getElementById('box');
  var side = (t.split('.')[1] || ''), game = null, ws = null, opp = '', you = '', seat = '', share = document.getElementById('share');
  function showSeat() { if (side !== 'host' || !seat) return; share.style.display = 'block'; share.innerHTML = ''; var up = opp !== 'the computer'; var span = document.createElement('span'); span.textContent = up ? 'playing ' + opp : 'playing the computer. Give this link to someone to take its place:'; share.appendChild(span); if (!up) { var b = document.createElement('button'); b.textContent = 'copy link'; b.onclick = function () { navigator.clipboard.writeText(seat).then(function () { b.textContent = 'copied'; setTimeout(function () { b.textContent = 'copy link'; }, 1500); }); }; share.appendChild(b); } }
  function say(s) { msg.textContent = s || ''; msg.style.display = s ? 'flex' : 'none'; }
  if (side !== 'host' && side !== 'guest') { say('This link is not valid. Ask for a new invite.'); bar.textContent = ''; return; }
  function title() { bar.textContent = (you || 'you') + ' vs ' + (opp || '…'); }
  function connect() {
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/tennis/ws?t=' + encodeURIComponent(t));
    ws.onopen = function () { say('waiting for the other player…'); };
    ws.onclose = function (e) { say(e.code === 4001 ? 'Somebody is already sitting in this seat. Ask for a new link.' : e.code === 4000 ? 'This match was opened in another window.' : 'disconnected. Reload this page to reconnect (the invite lasts 45 minutes).'); if (game) game.pause(); };
    ws.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.t === 'hello') { you = m.you; opp = m.opponent; if (m.seat) seat = m.seat; if (!game) start(); if (side === 'host') { opp = m.peer ? m.opponent : 'the computer'; game.setPeer(!!m.peer); say(''); showSeat(); } else if (m.peer) say(''); else game.pause(); title(); }
      else if (m.t === 'peer') { if (side === 'host') { opp = m.up ? (m.name || 'opponent') : 'the computer'; game.setPeer(!!m.up); title(); showSeat(); } else { if (m.name) opp = m.name; title(); say(m.up ? '' : 'the other player left. Waiting…'); if (game) { m.up ? game.resume() : game.pause(); } } }
      else if (game) game.receive(m);
    };
  }
  function start() {
    game = window.__game = window.Tennis42.mount(box, { net: { role: side, send: function (m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); } }, colors: { primary: '#ec9068', background: '#161513' }, gandalf: { amber: '/tennis/gandalf-amber.png' } });
  }
  connect();
})();
</script></body></html>`;
