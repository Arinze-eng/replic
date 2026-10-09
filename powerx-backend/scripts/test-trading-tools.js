// scripts/test-trading-tools.js — verify the AGENT TOOLS (manusTools) wire into
// the trading engine with a chat ctx, exactly as the WormGPT agent calls them.
'use strict';
const path = require('path');
const _store = new Map();
const dbMock = { getSetting: async k => _store.has(k)?_store.get(k):null, setSetting: async (k,v)=>{_store.set(k,v);return true;}, nowISO:()=>new Date().toISOString() };
require.cache[path.resolve(__dirname,'../db.js')] = { id:'db', filename:'db', loaded:true, exports:dbMock };

const manus = require('../services/manusTools');
const ctx = { chatId: '12345', userId: 'u1' }; // like a Telegram chat
let pass=0, fail=0; const ok=(n,c,e='')=>{ if(c){pass++;console.log('  ✅',n);}else{fail++;console.log('  ❌',n,e);} };

(async () => {
  console.log('── agent tool: open_trade (PAPER, live price) ──');
  const open = await manus.toolOpenTrade({ exchange:'binance', symbol:'BTC/USDT', side:'buy', amount:0.01, sl:40000, tp:100000, mode:'PAPER' }, ctx);
  console.log('   ', open.split('\n')[0]);
  ok('open_trade returns opened', /Opened/i.test(open) && /TRADE OPENED/.test(open), open.slice(0,80));

  console.log('── agent tool: list_trades ──');
  const list = await manus.toolListTrades({}, ctx);
  ok('list_trades shows the open trade', /BTC\/USDT/.test(list) && /LONG/.test(list), list.slice(0,120));

  console.log('── agent tool: trade_stats ──');
  const stats = await manus.toolTradeStats({}, ctx);
  ok('trade_stats returns a scoreboard', /trading stats|Open:/i.test(stats), stats.slice(0,80));

  console.log('── agent tool: close_trade (all) ──');
  const close = await manus.toolCloseTrade({ all:true }, ctx);
  ok('close_trade closes', /Closed/i.test(close), close.slice(0,120));

  console.log('── agent tool: connect / disconnect exchange ──');
  const conn = await manus.toolConnectExchange({ exchange:'binance', apiKey:'k12345678', secret:'s12345678' }, ctx);
  ok('connect_exchange saves keys', /saved/i.test(conn), conn.slice(0,80));
  const disc = await manus.toolDisconnectExchange({ exchange:'binance' }, ctx);
  ok('disconnect_exchange removes keys', /Removed/i.test(disc), disc.slice(0,80));

  console.log('── guard: no chat ctx (web-only safety) ──');
  const noChat = await manus.toolOpenTrade({ exchange:'binance', symbol:'BTC/USDT', side:'buy', amount:0.01, tp:100000 }, {});
  ok('open_trade requires a chat', /only works from|only available/i.test(noChat), noChat.slice(0,80));

  console.log('\n──────────────────────────');
  console.log(`TOOLS RESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
})().catch(e=>{ console.error('CRASH:', e); process.exit(1); });
