// Blockfield — authoritative realtime server for the Higgsfield apps-engine.
// One DurableObject instance backs the single /ws endpoint = one Red vs Blue arena.
// Protocol matches the Blockfield client (js/game.js) exactly.
import { DurableObject } from 'cloudflare:workers';

function spawnFor(team) {
  const z = Math.random() * 16 - 8;
  return team === 'red' ? { x: -28, y: 1.6, z } : { x: 28, y: 1.6, z };
}
function ryFor(team) { return team === 'red' ? -Math.PI / 2 : Math.PI / 2; }

export class GameServer extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.clients = new Map();      // id -> { ws, player }
    this.nextId = 1;
    this.scores = { red: 0, blue: 0 };
    this.placed = new Map();       // "x,y,z" -> { x, y, z, team }
    this.destroyed = new Map();    // "x,y,z" -> { x, y, z }
    this.tick = null;
  }

  async fetch(request) {
    if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket')
      return new Response('expected websocket', { status: 426 });
    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    server.accept();
    this.onConnect(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  onConnect(ws) {
    let id = null;
    ws.addEventListener('message', ev => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === 'join') { if (id === null) id = this.handleJoin(ws, m); return; }
      if (id === null) return;
      this.handleMsg(id, m);
    });
    const bye = () => { if (id !== null) { this.handleLeave(id); id = null; } };
    ws.addEventListener('close', bye);
    ws.addEventListener('error', bye);
  }

  pickTeam() {
    let r = 0, b = 0;
    for (const c of this.clients.values()) (c.player.team === 'red' ? r++ : b++);
    return r <= b ? 'red' : 'blue';
  }

  pub(p) {
    return { id: p.id, name: p.name, team: p.team, pos: p.pos, ry: p.ry, rx: p.rx,
             anim: p.anim, alive: p.alive, hp: p.hp, kills: p.kills, deaths: p.deaths };
  }

  handleJoin(ws, m) {
    const id = this.nextId++;
    const team = this.pickTeam();
    const name = String(m.name || 'Player').slice(0, 16) || 'Player';
    const pos = spawnFor(team);
    const player = { id, name, team, pos, ry: ryFor(team), rx: 0, anim: 0,
                     hp: 100, alive: true, kills: 0, deaths: 0 };
    this.clients.set(id, { ws, player });

    this.send(ws, {
      t: 'welcome', id, team, pos, ry: player.ry, scores: this.scores,
      players: [...this.clients.values()].filter(c => c.player.id !== id).map(c => this.pub(c.player)),
      placed: [...this.placed.values()],
      destroyed: [...this.destroyed.values()],
    });
    this.broadcastExcept(id, { t: 'join', p: this.pub(player) });
    this.ensureTick();
    return id;
  }

  handleMsg(id, m) {
    const c = this.clients.get(id);
    if (!c) return;
    const p = c.player;
    switch (m.t) {
      case 'state':
        if (m.pos) p.pos = { x: +m.pos.x, y: +m.pos.y, z: +m.pos.z };
        p.ry = +m.ry; p.rx = +m.rx; p.anim = +m.anim || 0;
        break;

      case 'shoot':
        this.broadcastExcept(id, { t: 'shoot', id, from: m.from, dir: m.dir, w: m.w });
        break;

      case 'hit': {
        const tc = this.clients.get(m.target);
        if (!tc || !tc.player.alive || tc.player.team === p.team) break;
        const tp = tc.player;
        const dmg = Math.max(0, Math.min(300, m.dmg | 0));
        tp.hp -= dmg;
        this.send(c.ws, { t: 'hitconfirm', head: !!m.head });
        if (tp.hp <= 0) {
          tp.hp = 0; tp.alive = false; tp.deaths++;
          p.kills++;
          this.scores[p.team] = (this.scores[p.team] || 0) + 1;
          this.broadcast({ t: 'death', victim: tp.id, killer: p.id, head: !!m.head });
          this.broadcast({ t: 'scores', scores: this.scores });
        } else {
          this.send(tc.ws, { t: 'hp', hp: tp.hp });
        }
        break;
      }

      case 'place': {
        const key = `${m.x},${m.y},${m.z}`;
        this.destroyed.delete(key);
        this.placed.set(key, { x: m.x, y: m.y, z: m.z, team: p.team });
        this.broadcastExcept(id, { t: 'place', x: m.x, y: m.y, z: m.z, team: p.team });
        break;
      }

      case 'destroy': {
        const key = `${m.x},${m.y},${m.z}`;
        if (this.placed.has(key)) this.placed.delete(key);
        else this.destroyed.set(key, { x: m.x, y: m.y, z: m.z });
        this.broadcastExcept(id, { t: 'destroy', x: m.x, y: m.y, z: m.z });
        break;
      }

      case 'respawn': {
        p.alive = true; p.hp = 100; p.pos = spawnFor(p.team); p.ry = ryFor(p.team); p.rx = 0;
        this.broadcast({ t: 'respawn', id: p.id, pos: p.pos });
        break;
      }

      case 'rtc': {
        const tc = this.clients.get(m.to);
        if (tc) this.send(tc.ws, { t: 'rtc', from: id, data: m.data });
        break;
      }

      case 'chat': {
        const text = String(m.text || '').slice(0, 120);
        if (text) this.broadcast({ t: 'chat', name: p.name, team: p.team, text });
        break;
      }

      case 'ping':
        this.send(c.ws, { t: 'pong', ts: m.ts });
        break;
    }
  }

  handleLeave(id) {
    if (!this.clients.has(id)) return;
    this.clients.delete(id);
    this.broadcast({ t: 'leave', id });
    if (this.clients.size === 0 && this.tick) { clearInterval(this.tick); this.tick = null; }
  }

  ensureTick() {
    if (this.tick) return;
    this.tick = setInterval(() => {
      if (this.clients.size === 0) { clearInterval(this.tick); this.tick = null; return; }
      const states = [];
      for (const c of this.clients.values()) {
        const p = c.player;
        if (!p.alive) continue;
        states.push({ id: p.id, pos: p.pos, ry: p.ry, rx: p.rx, anim: p.anim, hp: p.hp });
      }
      if (states.length) this.broadcast({ t: 'states', states });
    }, 50);
  }

  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }
  broadcast(obj) {
    const s = JSON.stringify(obj);
    for (const c of this.clients.values()) { try { c.ws.send(s); } catch {} }
  }
  broadcastExcept(id, obj) {
    const s = JSON.stringify(obj);
    for (const [cid, c] of this.clients) { if (cid === id) continue; try { c.ws.send(s); } catch {} }
  }
}
