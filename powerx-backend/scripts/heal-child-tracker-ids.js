#!/usr/bin/env node
/**
 * One-time heal for Child Tracker clientId corruption.
 *
 * Older server builds keyed device records / claim codes by whatever raw id the
 * XploitSPY socket client sent — sometimes JSON-quoted ("fe7cc…"). That split a
 * single phone across `ct:dev:fe7cc…` (data + live socket) and
 * `ct:dev:"fe7cc…"` (the claimed/owned record) so pairing "did nothing" and
 * real-time tracking stayed empty.
 *
 * This script canonicalises everything in place (idempotent, safe to re-run):
 *   • ct:claim:<code>  → store the UNQUOTED clientId
 *   • ct:dev:"<id>"    → merge ownerUserId/nickname into ct:dev:<id>, delete dup
 *   • ct:index:devices → dedupe to canonical ids
 *
 * Uses ONLY the Supabase service key + REST (no new deps). Reads creds from env
 * (SUPABASE_URL / SUPABASE_SERVICE_KEY) with CLI fallback args.
 */
const SUPABASE_URL = process.env.SUPABASE_URL || process.argv[2];
const SVC = process.env.SUPABASE_SERVICE_KEY || process.argv[3];
if (!SUPABASE_URL || !SVC) { console.error('Need SUPABASE_URL + SUPABASE_SERVICE_KEY'); process.exit(1); }

const { normId } = require('../services/childTracker');
const H = { apikey: SVC, Authorization: 'Bearer ' + SVC, 'Content-Type': 'application/json' };
const REST = SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/app_settings';

async function getAll(prefix) {
  const url = `${REST}?key=like.${encodeURIComponent(prefix + '*')}&select=key,value`;
  const r = await fetch(url, { headers: H });
  return r.ok ? r.json() : [];
}
async function put(key, value) {
  const r = await fetch(REST + '?on_conflict=key', {
    method: 'POST',
    headers: { ...H, Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ key, value: String(value), updated_at: new Date().toISOString() }),
  });
  if (!r.ok) console.warn('put fail', key, await r.text());
}
async function del(key) {
  const r = await fetch(`${REST}?key=eq.${encodeURIComponent(key)}`, { method: 'DELETE', headers: H });
  if (!r.ok) console.warn('del fail', key, await r.text());
}

(async () => {
  let fixedClaims = 0, mergedDevs = 0, deletedDupes = 0;

  // 1) Canonicalise claim reverse-maps.
  for (const row of await getAll('ct:claim:')) {
    const clean = normId(row.value);
    if (clean && clean !== row.value) { await put(row.key, clean); fixedClaims++; }
  }

  // 2) Merge quoted device records into their canonical unquoted twin.
  const devs = await getAll('ct:dev:');
  const byCanon = {}; // canonId -> [{key,parsed}]
  for (const row of devs) {
    const idPart = row.key.slice('ct:dev:'.length);
    const canon = normId(idPart);
    let parsed = null; try { parsed = JSON.parse(row.value); } catch (_) {}
    (byCanon[canon] = byCanon[canon] || []).push({ key: row.key, rawIdPart: idPart, parsed });
  }
  for (const canon of Object.keys(byCanon)) {
    const group = byCanon[canon];
    const canonKey = 'ct:dev:' + canon;
    // Merge all variants: any owner/nickname wins, keep earliest firstSeen / latest lastSeen.
    const merged = {};
    for (const g of group) {
      const p = g.parsed || {};
      for (const k of Object.keys(p)) {
        if (p[k] != null && merged[k] == null) merged[k] = p[k];
      }
      if (p.ownerUserId) merged.ownerUserId = p.ownerUserId;
      if (p.nickname) merged.nickname = p.nickname;
      if (p.claimCode) merged.claimCode = p.claimCode;
      if (p.model) merged.model = p.model;
      if (p.manufacturer) merged.manufacturer = p.manufacturer;
      if (p.osVersion) merged.osVersion = p.osVersion;
    }
    merged.clientId = canon;
    merged.deregistered = false; // if an owner claimed it, keep it visible
    await put(canonKey, JSON.stringify(merged));
    // ensure claim reverse-map points to canonical
    if (merged.claimCode) { await put('ct:claim:' + merged.claimCode, canon); }
    // delete the non-canonical duplicates
    for (const g of group) {
      if (g.key !== canonKey) { await del(g.key); deletedDupes++; }
    }
    mergedDevs++;
  }

  // 3) Rebuild the device index with canonical, de-duped ids.
  const idxRow = (await getAll('ct:index:devices'))[0];
  let idx = [];
  try { idx = JSON.parse(idxRow ? idxRow.value : '[]') || []; } catch (_) {}
  const canonIdx = [...new Set(idx.map(normId).filter(Boolean))];
  await put('ct:index:devices', JSON.stringify(canonIdx));

  console.log(`✅ heal done: claims fixed=${fixedClaims}, devices canonicalised=${mergedDevs}, dupes deleted=${deletedDupes}, index=${canonIdx.length} ids`);
})().catch(e => { console.error('heal error', e); process.exit(1); });
