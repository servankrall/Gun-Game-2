// Cloudflare Workers entry for Blockfield online multiplayer.
//
// Static files (index.html, js/*) are served by the Assets binding; the single
// realtime endpoint /ws is upgraded to a WebSocket handled by one global
// GameServer Durable Object (which itself partitions players into rooms).
//
// Deploy:  npm install  &&  npx wrangler deploy
// (wrangler opens a browser to sign in to your own Cloudflare account — no
//  tokens are pasted anywhere. The live URL is printed when the deploy finishes.)

import { GameServer } from './server.js';

export { GameServer };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/ws') {
      // One DO instance hosts every room, so all players share the same world.
      const id = env.GAME_SERVER.idFromName('global');
      return env.GAME_SERVER.get(id).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
