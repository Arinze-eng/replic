// bot.js — entry shim.
//
// The Render service's start command is `node bot.js`, but the real app entry
// point is `server.js` (see package.json "main"/"start"). This shim simply
// boots server.js so the service starts correctly regardless of which entry
// command the host uses. Keep both `node bot.js` and `node server.js` working.
require('./server.js');
