// Build a standalone, single-file offline version of Blockfield.
//
// It inlines Three.js (UMD) + js/map.js + js/textures.js + js/game.js and
// ports the authoritative server (server.js) into the page, swapping the
// WebSocket transport for an in-page bridge so the unmodified client runs
// against a local room (bots fill both teams). Output: blockfield-offline.html.
//
// Usage:
//   npm i three@0.160.0        # provides node_modules/three/build/three.min.js
//   node scripts/build-offline.mjs
//
// The online multiplayer version stays index.html + server.js; this is only
// for playing/sharing without the realtime server.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rd = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

const threePath = path.join(ROOT, 'node_modules/three/build/three.min.js');
if (!fs.existsSync(threePath)) {
  console.error('Missing node_modules/three/build/three.min.js — run: npm i three@0.160.0');
  process.exit(1);
}
const three = fs.readFileSync(threePath, 'utf8');

// ---- server port: strip Cloudflare Worker plumbing, keep the room logic ----
let srv = rd('server.js');
srv = srv.replace("import { DurableObject } from 'cloudflare:workers';\n", '');
srv = srv.replace('export class GameServer extends DurableObject {', 'class GameServer {');
srv = srv.replace(/  constructor\(ctx, env\) \{\n    super\(ctx, env\);\n/, '  constructor() {\n');
const fetchBlock = `  async fetch(request) {
    if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket')
      return new Response('expected websocket', { status: 426 });
    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    server.accept();
    this.onConnect(server);
    return new Response(null, { status: 101, webSocket: client });
  }

`;
if (!srv.includes(fetchBlock)) { console.error('server.js fetch() block not found — did server.js change?'); process.exit(1); }
srv = srv.replace(fetchBlock, '');

const serverBundle = `(function(){
${srv}
const SERVER = new GameServer();
class ShimWebSocket {
  constructor() {
    this.readyState = 0;
    this.onopen = this.onmessage = this.onclose = this.onerror = null;
    const client = this;
    const serverWs = {
      _l: {},
      addEventListener(t, f) { (this._l[t] = this._l[t] || []).push(f); },
      _emit(t, ev) { (this._l[t] || []).forEach(f => f(ev)); },
      send(str) { if (client.onmessage) client.onmessage({ data: str }); }
    };
    this._serverWs = serverWs;
    setTimeout(() => {
      client.readyState = 1;
      try { SERVER.onConnect(serverWs); } catch (e) { console.error(e); }
      if (client.onopen) client.onopen();
    }, 0);
  }
  send(data) { this._serverWs._emit('message', { data }); }
  close() { try { this._serverWs._emit('close', {}); } catch (e) {} this.readyState = 3; if (this.onclose) this.onclose(); }
}
window.WebSocket = ShimWebSocket;
})();`;

// ---- client bundle: strip ES-module import/export so it runs as a classic script ----
const map = rd('js/map.js').replace(/^export /gm, '').replace(/^import\b[^\n]*\n/gm, '');
const tex = rd('js/textures.js').replace(/^export /gm, '').replace(/^import\b[^\n]*\n/gm, '');
const game = rd('js/game.js').replace(/^import\b[^\n]*\n/gm, '');
const clientBundle = map + '\n' + tex + '\n' + game;

// ---- HTML shell from index.html (drop the importmap + module script) ----
let html = rd('index.html');
html = html.replace(/<script type="importmap">[\s\S]*?<\/script>/, '');
html = html.replace(/<script type="module" src="js\/game\.js"><\/script>/, '');

// break any accidental </script> inside inlined code so the tag can't close early
const esc = t => t.replace(/<\/script/gi, '<\\/script');
const inject = `
<script>${esc(three)}</script>
<script>${esc(serverBundle)}</script>
<script>${esc(clientBundle)}</script>
<script>window.initVoice = function(){}; /* offline build: no voice peers */</script>
`;
// NOTE: replacement is a function so $-sequences in the code aren't treated as
// String.replace specials ($&, $1, ...).
html = html.replace('</body>', () => inject + '\n</body>');

fs.writeFileSync(path.join(ROOT, 'blockfield-offline.html'), html);
console.log('Wrote blockfield-offline.html (' + html.length + ' bytes)');
