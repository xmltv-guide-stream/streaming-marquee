'use strict';

/**
 * Tautulli Marquee
 * ----------------
 * A zero-dependency Node.js server that aggregates "now playing" activity from
 * one or more Tautulli instances and presents it as a good-looking, old-school
 * movie-theater "Now Playing" screen.
 *
 * - Pure Node core modules only (no npm install required). Needs Node >= 18
 *   for the built-in global fetch().
 * - Picks a random high port on first run and persists it, so the URL stays
 *   stable across restarts.
 * - Minimal admin backend to manage Tautulli host/port/api-key entries.
 */

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONFIG_PATH = path.join(ROOT, 'config.json');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = {
  port: null,            // chosen once, then persisted
  theme: 'marquee',      // default theme for the display
  refreshSeconds: 15,    // how often the browser polls for updates
  instances: []          // [{ id, name, host, port, https, apiKey }]
};

function loadConfig() {
  let cfg = { ...DEFAULT_CONFIG };
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      cfg = { ...DEFAULT_CONFIG, ...raw };
      if (!Array.isArray(cfg.instances)) cfg.instances = [];
    }
  } catch (err) {
    console.error('Could not read config.json, starting fresh:', err.message);
    cfg = { ...DEFAULT_CONFIG };
  }
  return cfg;
}

const BACKUP_DIR = path.join(ROOT, '.config-backups');
const MAX_BACKUPS = 15;

// Before overwriting config.json, keep a timestamped copy of the current file so
// an accidental change (or a bad edit) can always be rolled back.
function backupConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return;
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(CONFIG_PATH, path.join(BACKUP_DIR, `config-${stamp}.json`));
    // Prune to the most recent MAX_BACKUPS.
    const files = fs.readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith('config-') && f.endsWith('.json'))
      .sort();
    for (const f of files.slice(0, Math.max(0, files.length - MAX_BACKUPS))) {
      try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch { /* ignore */ }
    }
  } catch (err) {
    console.error('Could not back up config:', err.message);
  }
}

function saveConfig(cfg) {
  backupConfig();
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, CONFIG_PATH);
}

/**
 * Migrate older config files. Instances created before Jellystat support had
 * no `type` field — they were all Tautulli. Backfill that so existing settings
 * carry over untouched.
 */
function migrateConfig(cfg) {
  let changed = false;
  for (const inst of cfg.instances) {
    if (!inst.type) { inst.type = 'tautulli'; changed = true; }
    if (inst.type === 'jellystat' && !inst.port) { inst.port = 3000; changed = true; }
    if (inst.type === 'channels' && !inst.port) { inst.port = 8089; changed = true; }
  }
  return changed;
}

let config = loadConfig();
if (migrateConfig(config)) {
  saveConfig(config);
  console.log('Migrated existing instances to include a "type" (defaulted to Tautulli).');
}

// ---------------------------------------------------------------------------
// Port selection: pick once in a high, unlikely-to-collide range, then persist
// ---------------------------------------------------------------------------

// Range chosen inside the IANA dynamic/ephemeral band but toward the top, away
// from most defaults. 49152-65535 is the ephemeral range; we bias high.
const PORT_MIN = 49200;
const PORT_MAX = 65500;

function randomPort() {
  return PORT_MIN + Math.floor(Math.random() * (PORT_MAX - PORT_MIN));
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const tester = net
      .createServer()
      .once('error', () => resolve(false))
      .once('listening', () => {
        tester.close(() => resolve(true));
      })
      .listen(port, '0.0.0.0');
  });
}

async function pickPort() {
  // If we already chose one and it's still free, keep it (stable URL).
  if (config.port && (await isPortFree(config.port))) {
    return config.port;
  }
  for (let i = 0; i < 100; i++) {
    const p = randomPort();
    if (await isPortFree(p)) return p;
  }
  throw new Error('Could not find a free port after 100 attempts.');
}

// ---------------------------------------------------------------------------
// Tautulli client
// ---------------------------------------------------------------------------

function instanceBaseUrl(inst) {
  const scheme = inst.https ? 'https' : 'http';
  return `${scheme}://${inst.host}:${inst.port}`;
}

// Allow self-signed certs for https Tautulli instances on a LAN.
const insecureAgent = new (require('https').Agent)({ rejectUnauthorized: false });

async function tautulliCall(inst, cmd, params = {}, { raw = false } = {}) {
  const base = instanceBaseUrl(inst);
  const u = new URL(base + '/api/v2');
  u.searchParams.set('apikey', inst.apiKey);
  u.searchParams.set('cmd', cmd);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  }

  const opts = { signal: AbortSignal.timeout(10000) };
  if (inst.https) opts.dispatcher = undefined; // node fetch uses undici; agent below
  // undici respects the NODE_TLS_REJECT_UNAUTHORIZED env for self-signed certs.

  const res = await fetch(u, opts);
  if (raw) return res;
  const json = await res.json();
  return json;
}

function computeTautulliItem(inst, s) {
  // Tautulli view_offset & duration are in milliseconds.
  const durationMs = Number(s.duration) || 0;
  const offsetMs = Number(s.view_offset) || 0;
  const remainingMs = Math.max(0, durationMs - offsetMs);
  const state = (s.state || '').toLowerCase();

  // End time is only meaningful while actively playing.
  const endTime = state === 'playing' ? Date.now() + remainingMs : null;

  // Choose the best poster artwork.
  // Movies/shows: `thumb` is the item poster; episodes look best with the
  // show poster (`grandparent_thumb`). Fall back to art if needed.
  let img = s.thumb;
  if (s.media_type === 'episode' && s.grandparent_thumb) img = s.grandparent_thumb;
  if (!img) img = s.art;

  // Build a nice title / subtitle.
  let title = s.title;
  let subtitle = '';
  if (s.media_type === 'episode') {
    title = s.grandparent_title || s.title;
    const se = s.parent_media_index ? `S${s.parent_media_index}` : '';
    const ep = s.media_index ? `E${s.media_index}` : '';
    subtitle = [se + ep, s.title].filter(Boolean).join(' · ');
  } else if (s.media_type === 'movie') {
    title = s.title;
    subtitle = s.year ? String(s.year) : '';
  } else {
    title = s.full_title || s.title;
    subtitle = s.parent_title || '';
  }

  return {
    id: `${inst.id}:${s.session_key}`,
    instance: inst.name,
    title,
    subtitle,
    mediaType: s.media_type,
    user: s.friendly_name || s.user || 'Unknown',
    userThumb: s.user_thumb || '',
    state,
    progressPercent: Number(s.progress_percent) || 0,
    durationMs,
    offsetMs,
    remainingMs,
    endTime,
    player: s.player || '',
    product: s.product || '',
    transcodeDecision: s.transcode_decision || '',
    quality: s.quality_profile || '',
    // token the /img proxy needs to fetch this artwork
    img: img || '',
    ratingKey: s.rating_key || ''
  };
}

// ---------------------------------------------------------------------------
// Jellystat client (stats app for Jellyfin — the Tautulli equivalent)
// ---------------------------------------------------------------------------

// Jellystat exposes an unauthenticated proxy at /proxy/* and authenticated
// routes elsewhere. The API key is sent as an `x-api-token` header. Sessions
// come from GET /proxy/getSessions and are raw Jellyfin session objects.
async function jellystatFetch(inst, pathAndQuery, { raw = false } = {}) {
  const base = instanceBaseUrl(inst);
  const u = new URL(base + pathAndQuery);
  const res = await fetch(u, {
    headers: { 'x-api-token': inst.apiKey || '' },
    signal: AbortSignal.timeout(10000)
  });
  if (raw) return res;
  return res.json();
}

// Jellyfin/Emby express time in "ticks": 10,000,000 ticks = 1 second.
const TICKS_PER_MS = 10000;

function computeJellystatItem(inst, s) {
  const npi = s.NowPlayingItem || {};
  const play = s.PlayState || {};

  const durationMs = Number(npi.RunTimeTicks || 0) / TICKS_PER_MS;
  const offsetMs = Number(play.PositionTicks || 0) / TICKS_PER_MS;
  const remainingMs = Math.max(0, durationMs - offsetMs);
  const state = play.IsPaused ? 'paused' : 'playing';
  const endTime = state === 'playing' && durationMs > 0 ? Date.now() + remainingMs : null;

  const type = npi.Type || '';
  let mediaType, title = npi.Name || 'Unknown', subtitle = '';
  let imageId = npi.Id;

  if (type === 'Episode') {
    mediaType = 'episode';
    title = npi.SeriesName || npi.Name;
    const se = npi.ParentIndexNumber != null ? `S${npi.ParentIndexNumber}` : '';
    const ep = npi.IndexNumber != null ? `E${npi.IndexNumber}` : '';
    subtitle = [se + ep, npi.Name].filter(Boolean).join(' · ');
    imageId = npi.SeriesId || npi.Id;   // prefer the show poster
  } else if (type === 'Movie') {
    mediaType = 'movie';
    subtitle = npi.ProductionYear ? String(npi.ProductionYear) : '';
  } else if (type === 'Audio') {
    mediaType = 'track';
    subtitle = (Array.isArray(npi.Artists) && npi.Artists.join(', ')) || npi.AlbumArtist || npi.Album || '';
    imageId = npi.AlbumId || npi.Id;
  } else if (type === 'TvChannel') {
    mediaType = 'live';
    subtitle = 'Live TV';
  } else {
    mediaType = type.toLowerCase();
  }

  const progressPercent = durationMs > 0 ? (offsetMs / durationMs) * 100 : 0;

  return {
    id: `${inst.id}:${s.Id || s.SessionKey || imageId}`,
    instance: inst.name,
    title,
    subtitle,
    mediaType,
    user: s.UserName || 'Unknown',
    userThumb: '',
    state,
    progressPercent,
    durationMs,
    offsetMs,
    remainingMs,
    endTime,
    player: s.DeviceName || s.Client || '',
    product: s.Client || '',
    transcodeDecision: s.TranscodingInfo ? 'transcode' : 'direct play',
    quality: '',
    // Jellyfin item id the /img proxy uses to fetch the primary image
    jf: imageId || '',
    img: '',
    ratingKey: ''
  };
}

// ---------------------------------------------------------------------------
// Channels DVR client (live TV — the /dvr endpoint, no auth on LAN)
// ---------------------------------------------------------------------------

// Channels DVR exposes GET /dvr returning JSON with an `activity` map whose
// values are human-readable strings. Live viewing shows up as "Watching …".
async function channelsFetch(inst, pathAndQuery, { raw = false } = {}) {
  const base = instanceBaseUrl(inst);
  const u = new URL(base + pathAndQuery);
  const res = await fetch(u, { signal: AbortSignal.timeout(10000) });
  if (raw) return res;
  return res.json();
}

// Cache of channel-number -> current program, per instance. The guide changes
// slowly, so we only refresh it every 30s regardless of the display poll rate.
const channelsGuideCache = new Map();
const GUIDE_TTL_MS = 30000;

// Merge one /devices/<id>/guide/now payload into a channel-number map.
// Field names are matched defensively because the server guide shape isn't
// formally documented.
function mergeGuideNow(map, guide) {
  const arr = Array.isArray(guide) ? guide : (guide && (guide.Channels || guide.channels)) || [];
  for (const c of arr) {
    const chObj = c.Channel || c.channel || c;
    const num = String(
      c.Number ?? c.number ?? chObj.Number ?? chObj.number ?? c.GuideNumber ?? ''
    ).trim();
    if (!num) continue;

    let airings = c.Airings || c.airings || c.Airing || c.airing || [];
    if (!Array.isArray(airings)) airings = [airings];
    const a = airings[0];
    if (!a) continue;

    const title = a.Title || a.title || a.Name || a.name || '';
    const episodeTitle = a.EpisodeTitle || a.episode_title || '';
    const image = a.Image || a.image || a.image_url || a.ImageURL || a.Poster || a.poster || '';
    const channelName = chObj.Name || chObj.name || c.Name || c.name || '';

    if (!map[num]) map[num] = { title, episodeTitle, image, channelName };
  }
}

async function getChannelsGuide(inst) {
  const cached = channelsGuideCache.get(inst.id);
  if (cached && Date.now() - cached.ts < GUIDE_TTL_MS) return cached.map;

  const map = {};
  let deviceIds = [];
  try {
    const devices = await channelsFetch(inst, '/devices');
    if (Array.isArray(devices)) {
      deviceIds = devices.map((d) => d.DeviceID || d.ID || d.device_id || d.Name).filter(Boolean);
    }
  } catch { /* fall back to ANY below */ }

  const ids = deviceIds.length ? deviceIds : ['ANY'];
  for (const id of ids) {
    try {
      const guide = await channelsFetch(inst, `/devices/${encodeURIComponent(id)}/guide/now`);
      mergeGuideNow(map, guide);
    } catch { /* skip this device */ }
  }

  channelsGuideCache.set(inst.id, { ts: Date.now(), map });
  return map;
}

// Turn one Channels DVR activity entry into a clean live item.
//
// Real-world examples of the (undocumented) string format:
//   "Watching ch3 Bob's Burgers from Master Bedroom: buf=0% drop=0% timeouts=2 ..."
//   "Watching ch4.1 NBC from Living Room"
//   "<Client> is watching ch6 ABC"
//
// We: keep only "watching" entries, strip any prefix up to "watching", cut the
// trailing "key=value" telemetry, split off the "from <device>" client name, and
// peel a leading "chNN" channel number off the program title.
function parseChannelsActivity(inst, key, value) {
  if (typeof value !== 'string') return null;
  if (!/watching/i.test(value)) return null;

  // Everything after the word "watching".
  let s = value.replace(/^.*?\bwatching\s+/i, '').trim();

  // Drop trailing streaming diagnostics: cut from the first "word=value" token
  // (and any leading colon) to the end. e.g. ": buf=0% drop=0% timeouts=2".
  s = s.replace(/\s*:?\s*\b[\w-]+=\S+.*$/, '').trim();

  // Pull out the client/location after "from".
  let device = '';
  const fromMatch = s.match(/^(.*?)\s+from\s+(.+)$/i);
  if (fromMatch) {
    s = fromMatch[1].trim();
    device = fromMatch[2].trim();
  }

  // Peel a leading channel token: "ch3", "ch4.1", "channel 12".
  let channelNo = '';
  const chMatch = s.match(/^ch(?:annel)?\s*([0-9]+(?:\.[0-9]+)?)\b\s*(.*)$/i);
  if (chMatch) {
    channelNo = chMatch[1];
    if (chMatch[2].trim()) s = chMatch[2].trim();
  }

  const title = s || value;
  const subtitle = channelNo ? `Ch ${channelNo} · Live TV` : 'Live TV';

  return {
    id: `${inst.id}:ch:${key}`,
    instance: inst.name,
    title,
    subtitle,
    mediaType: 'live',
    user: device || 'Live TV',
    userThumb: '',
    state: 'live',
    progressPercent: 0,
    durationMs: 0,
    offsetMs: 0,
    remainingMs: 0,
    endTime: null,
    player: device || '',
    product: '',
    transcodeDecision: '',
    quality: '',
    channelNo,
    live: true,
    raw: value,
    chImg: '',
    jf: '',
    img: '',
    ratingKey: ''
  };
}

function computeChannelsItems(inst, dvrJson, guideMap = {}) {
  const activity = (dvrJson && dvrJson.activity) || {};
  const items = [];
  for (const [key, value] of Object.entries(activity)) {
    const item = parseChannelsActivity(inst, key, value);
    if (!item) continue;

    // Enrich with the channel's current program + poster from the guide.
    const g = item.channelNo && guideMap[item.channelNo];
    if (g) {
      const channelName = g.channelName || item.title;
      if (g.title) item.title = g.title;            // prefer the program name
      const subParts = [];
      if (item.channelNo) subParts.push(`Ch ${item.channelNo}`);
      if (channelName && channelName !== item.title) subParts.push(channelName);
      subParts.push('Live TV');
      item.subtitle = subParts.join(' · ');
      if (g.image) item.chImg = g.image;            // absolute poster URL
    }
    items.push(item);
  }
  return items;
}

async function getAllNowPlaying() {
  const results = [];
  const errors = [];

  await Promise.all(
    config.instances.map(async (inst) => {
      try {
        if (inst.type === 'jellystat') {
          const sessions = await jellystatFetch(inst, '/proxy/getSessions');
          const arr = Array.isArray(sessions) ? sessions : [];
          for (const s of arr) {
            if (s && s.NowPlayingItem) results.push(computeJellystatItem(inst, s));
          }
        } else if (inst.type === 'channels') {
          const [dvr, guide] = await Promise.all([
            channelsFetch(inst, '/dvr'),
            getChannelsGuide(inst).catch(() => ({}))
          ]);
          for (const item of computeChannelsItems(inst, dvr, guide)) results.push(item);
        } else {
          const json = await tautulliCall(inst, 'get_activity');
          const sessions = (json && json.response && json.response.data && json.response.data.sessions) || [];
          for (const s of sessions) results.push(computeTautulliItem(inst, s));
        }
      } catch (err) {
        errors.push({ instance: inst.name, error: err.message });
      }
    })
  );

  // Sort: active (playing or live) first, then by time remaining.
  const isActive = (s) => s === 'playing' || s === 'live';
  results.sort((a, b) => {
    if (isActive(a.state) && !isActive(b.state)) return -1;
    if (isActive(b.state) && !isActive(a.state)) return 1;
    return (a.remainingMs || 0) - (b.remainingMs || 0);
  });

  return { items: results, errors, serverTime: Date.now() };
}

async function testInstance(inst) {
  if (inst.type === 'channels') {
    const res = await channelsFetch(inst, '/dvr', { raw: true });
    if (res.ok) {
      let watching = 0;
      try {
        const j = await res.json();
        watching = computeChannelsItems(inst, j).length;
      } catch { /* ignore */ }
      return { ok: true, serverName: `Channels DVR — ${watching} watching live` };
    }
    return { ok: false, error: `Channels DVR returned HTTP ${res.status}` };
  }

  if (inst.type === 'jellystat') {
    const res = await jellystatFetch(inst, '/proxy/getSessions', { raw: true });
    if (res.ok) {
      let count = 0;
      try {
        const j = await res.json();
        if (Array.isArray(j)) count = j.filter((x) => x && x.NowPlayingItem).length;
      } catch { /* ignore parse issues */ }
      return { ok: true, serverName: `Jellystat — ${count} now playing` };
    }
    return { ok: false, error: `Jellystat returned HTTP ${res.status}` };
  }

  const json = await tautulliCall(inst, 'get_server_info');
  if (json && json.response && json.response.result === 'success') {
    const d = json.response.data || {};
    return { ok: true, serverName: d.pms_name || d.server_name || 'Tautulli' };
  }
  const msg = (json && json.response && json.response.message) || 'Unknown response';
  return { ok: false, error: msg };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1e6) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8'
};

function serveStatic(res, relPath) {
  // Prevent path traversal.
  const safe = path.normalize(relPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safe);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// Public (safe) view of config for the admin UI (never leak full api keys)
// ---------------------------------------------------------------------------

function maskKey(key) {
  if (!key) return '';
  if (key.length <= 6) return '•'.repeat(key.length);
  return key.slice(0, 3) + '•'.repeat(Math.max(4, key.length - 6)) + key.slice(-3);
}

function publicInstances() {
  return config.instances.map((i) => ({
    id: i.id,
    name: i.name,
    type: i.type || 'tautulli',
    host: i.host,
    port: i.port,
    https: !!i.https,
    apiKeyMasked: maskKey(i.apiKey)
  }));
}

// ---------------------------------------------------------------------------
// Admin authentication (optional). If config.adminAuth is unset, the admin page
// is open and simply offers to set a password. Once set, admin actions require
// a login session. The password is stored salted+hashed, never in plain text.
// ---------------------------------------------------------------------------

const activeSessions = new Set(); // in-memory session tokens (cleared on restart)
const SESSION_COOKIE = 'sm_session';

function hasAdminPassword() {
  return !!(config.adminAuth && config.adminAuth.hash && config.adminAuth.salt);
}

function setAdminPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  config.adminAuth = { salt, hash };
  saveConfig(config); // only adds adminAuth; all existing config is preserved
}

function verifyAdminPassword(pw) {
  if (!hasAdminPassword()) return false;
  const { salt, hash } = config.adminAuth;
  const test = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  const a = Buffer.from(test, 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function newSession(res) {
  const token = crypto.randomBytes(32).toString('hex');
  activeSessions.add(token);
  // 30-day cookie; HttpOnly so page scripts can't read it; Lax is fine for a LAN app.
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`);
}

function clearSession(req, res) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) activeSessions.delete(token);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

// True if the request may perform admin actions.
function isAuthed(req) {
  if (!hasAdminPassword()) return true; // no protection configured yet
  const token = parseCookies(req)[SESSION_COOKIE];
  return !!token && activeSessions.has(token);
}

// ---------------------------------------------------------------------------
// Image proxy: browser -> our server -> Tautulli (hides api key, avoids CORS
// and mixed-content problems).
// ---------------------------------------------------------------------------

// SSRF guard for the Channels image proxy: allow the instance host itself and
// any public host, but block loopback/private/link-local addresses so the proxy
// can't be pointed at other machines on the LAN.
function isBlockedImageHost(hostname, inst) {
  if (hostname === inst.host) return false; // the DVR itself is always fine
  const h = hostname.toLowerCase();
  return (
    h === 'localhost' ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^169\.254\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    h === '::1' ||
    /^fc00:/i.test(h) ||
    /^fe80:/i.test(h) ||
    h === '0.0.0.0'
  );
}

async function handleImageProxy(req, res, urlObj) {
  const instanceId = urlObj.searchParams.get('i');
  const img = urlObj.searchParams.get('img');
  const ratingKey = urlObj.searchParams.get('rating_key');
  const jf = urlObj.searchParams.get('jf');
  const width = urlObj.searchParams.get('w') || '450';
  const height = urlObj.searchParams.get('h') || '675';

  const inst = config.instances.find((x) => x.id === instanceId);
  if (!inst) {
    res.writeHead(404);
    res.end('No image');
    return;
  }

  try {
    let upstream;
    if (inst.type === 'channels') {
      // Channels DVR guide art comes through as ?u= — may be a full URL, a
      // scheme-less host/path, or a path relative to the DVR itself.
      let u = urlObj.searchParams.get('u');
      if (!u) { res.writeHead(404); res.end('No image'); return; }

      // Scheme-less but host-like (e.g. "tmsimg.fancybits.co/…") -> assume https.
      if (!/^https?:\/\//i.test(u) && !u.startsWith('/') && /^[\w.-]+\.[a-z]{2,}\//i.test(u)) {
        u = 'https://' + u;
      }

      let target;
      // Relative paths ("/dvr/…") resolve against the DVR base URL.
      try { target = new URL(u, instanceBaseUrl(inst)); } catch { res.writeHead(400); res.end('Bad url'); return; }

      if (!/^https?:$/.test(target.protocol) || isBlockedImageHost(target.hostname, inst)) {
        res.writeHead(403); res.end('Blocked'); return;
      }
      upstream = await fetch(target, { redirect: 'follow', signal: AbortSignal.timeout(10000) });
    } else if (inst.type === 'jellystat') {
      if (!jf) { res.writeHead(404); res.end('No image'); return; }
      upstream = await jellystatFetch(
        inst,
        `/proxy/Items/Images/Primary/?id=${encodeURIComponent(jf)}&fillWidth=${encodeURIComponent(width)}&quality=90`,
        { raw: true }
      );
    } else {
      if (!img && !ratingKey) { res.writeHead(404); res.end('No image'); return; }
      const params = { width, height, fallback: 'poster' };
      if (img) params.img = img;
      if (ratingKey) params.rating_key = ratingKey;
      upstream = await tautulliCall(inst, 'pms_image_proxy', params, { raw: true });
    }

    if (!upstream.ok) {
      res.writeHead(502);
      res.end('Upstream image error');
      return;
    }
    const ct = upstream.headers.get('content-type') || 'image/jpeg';
    res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'public, max-age=120' });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.end(buf);
  } catch (err) {
    res.writeHead(502);
    res.end('Image fetch failed');
  }
}

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

async function handleApi(req, res, urlObj) {
  const p = urlObj.pathname;

  // --- Auth routes (always reachable) ---
  if (p === '/api/auth/login' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    if (verifyAdminPassword(body.password || '')) {
      newSession(res);
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 401, { ok: false, error: 'Incorrect password.' });
  }

  if (p === '/api/auth/logout' && req.method === 'POST') {
    clearSession(req, res);
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/auth/set-password' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const newPassword = (body.newPassword || '').trim();
    if (newPassword.length < 4) {
      return sendJson(res, 400, { ok: false, error: 'Password must be at least 4 characters.' });
    }
    // If a password already exists, changing it requires an active session or
    // the current password.
    if (hasAdminPassword() && !isAuthed(req) && !verifyAdminPassword(body.currentPassword || '')) {
      return sendJson(res, 401, { ok: false, error: 'Current password is required.' });
    }
    setAdminPassword(newPassword);
    newSession(res); // log in immediately after setting/changing
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/auth/disable-password' && req.method === 'POST') {
    // Turning protection off. If a password is currently set, you must be logged
    // in (or supply it) to remove it.
    if (hasAdminPassword()) {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (!isAuthed(req) && !verifyAdminPassword(body.currentPassword || '')) {
        return sendJson(res, 401, { ok: false, error: 'Log in first to disable the password.' });
      }
    }
    delete config.adminAuth;
    saveConfig(config);
    activeSessions.clear();
    clearSession(req, res);
    return sendJson(res, 200, { ok: true });
  }

  // --- Gate sensitive admin endpoints behind the password (if one is set) ---
  const isProtected =
    (req.method === 'POST' && (p === '/api/instances' || p === '/api/test')) ||
    (req.method === 'DELETE' && /^\/api\/instances\/[^/]+$/.test(p)) ||
    (req.method === 'POST' && /^\/api\/instances\/[^/]+\/test$/.test(p)) ||
    (req.method === 'GET' && p === '/api/debug');
  if (isProtected && !isAuthed(req)) {
    return sendJson(res, 401, { ok: false, error: 'Admin login required.' });
  }

  if (p === '/api/nowplaying' && req.method === 'GET') {
    const data = await getAllNowPlaying();
    return sendJson(res, 200, data);
  }

  // Debug helper: dump the raw upstream payload for one instance so parsing can
  // be verified/tuned. Handy for Channels DVR whose activity strings vary.
  if (p === '/api/debug' && req.method === 'GET') {
    const inst = config.instances.find((i) => i.id === urlObj.searchParams.get('i'));
    if (!inst) return sendJson(res, 404, { ok: false, error: 'Unknown instance id' });
    try {
      if (inst.type === 'channels') {
        channelsGuideCache.delete(inst.id); // force a fresh guide fetch
        const [dvr, guide] = await Promise.all([
          channelsFetch(inst, '/dvr'),
          getChannelsGuide(inst).catch((e) => ({ _error: e.message }))
        ]);
        let devicesRaw = null;
        try { devicesRaw = await channelsFetch(inst, '/devices'); } catch (e) { devicesRaw = { _error: e.message }; }
        return sendJson(res, 200, {
          type: 'channels',
          activity: dvr.activity || {},
          devices: devicesRaw,
          guideMap: guide,
          parsed: computeChannelsItems(inst, dvr, guide)
        });
      }
      if (inst.type === 'jellystat') {
        return sendJson(res, 200, { type: 'jellystat', sessions: await jellystatFetch(inst, '/proxy/getSessions') });
      }
      const json = await tautulliCall(inst, 'get_activity');
      return sendJson(res, 200, { type: 'tautulli', sessions: (json.response && json.response.data && json.response.data.sessions) || [] });
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: err.message });
    }
  }

  if (p === '/api/config' && req.method === 'GET') {
    const authed = isAuthed(req);
    return sendJson(res, 200, {
      theme: config.theme,
      refreshSeconds: config.refreshSeconds,
      authRequired: hasAdminPassword(),
      authed,
      // Only expose the instance list (hosts + masked keys) to an authed admin.
      instances: authed ? publicInstances() : []
    });
  }

  if (p === '/api/theme' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    if (typeof body.theme === 'string') {
      config.theme = body.theme;
      saveConfig(config);
    }
    if (typeof body.refreshSeconds === 'number' && body.refreshSeconds >= 3) {
      config.refreshSeconds = Math.round(body.refreshSeconds);
      saveConfig(config);
    }
    return sendJson(res, 200, { ok: true, theme: config.theme, refreshSeconds: config.refreshSeconds });
  }

  if (p === '/api/instances' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const type = ['jellystat', 'channels'].includes(body.type) ? body.type : 'tautulli';
    const name = (body.name || '').trim();
    const host = (body.host || '').trim();
    const port = parseInt(body.port, 10);
    const apiKey = (body.apiKey || '').trim();
    const https = !!body.https;
    const needsKey = type !== 'channels'; // Channels DVR needs no key on the LAN
    if (!host || !port || (needsKey && !apiKey)) {
      return sendJson(res, 400, {
        ok: false,
        error: needsKey ? 'host, port and apiKey are required.' : 'host and port are required.'
      });
    }
    const inst = {
      id: crypto.randomUUID(),
      name: name || `${host}:${port}`,
      type,
      host,
      port,
      https,
      apiKey: needsKey ? apiKey : ''
    };
    config.instances.push(inst);
    saveConfig(config);
    return sendJson(res, 200, { ok: true, instance: { ...inst, apiKey: undefined, apiKeyMasked: maskKey(apiKey) } });
  }

  // /api/instances/:id  (DELETE)
  const delMatch = p.match(/^\/api\/instances\/([^/]+)$/);
  if (delMatch && req.method === 'DELETE') {
    const id = delMatch[1];
    const before = config.instances.length;
    config.instances = config.instances.filter((i) => i.id !== id);
    if (config.instances.length === before) {
      return sendJson(res, 404, { ok: false, error: 'Not found' });
    }
    saveConfig(config);
    return sendJson(res, 200, { ok: true });
  }

  // /api/instances/:id/test  (POST) OR test unsaved details in the body
  const testMatch = p.match(/^\/api\/instances\/([^/]+)\/test$/);
  if (testMatch && req.method === 'POST') {
    const inst = config.instances.find((i) => i.id === testMatch[1]);
    if (!inst) return sendJson(res, 404, { ok: false, error: 'Not found' });
    try {
      const r = await testInstance(inst);
      return sendJson(res, 200, r);
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: err.message });
    }
  }

  if (p === '/api/test' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const inst = {
      type: ['jellystat', 'channels'].includes(body.type) ? body.type : 'tautulli',
      host: (body.host || '').trim(),
      port: parseInt(body.port, 10),
      apiKey: (body.apiKey || '').trim(),
      https: !!body.https
    };
    const testNeedsKey = inst.type !== 'channels';
    if (!inst.host || !inst.port || (testNeedsKey && !inst.apiKey)) {
      return sendJson(res, 400, { ok: false, error: 'host, port and apiKey are required.' });
    }
    try {
      const r = await testInstance(inst);
      return sendJson(res, 200, r);
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: err.message });
    }
  }

  return sendJson(res, 404, { ok: false, error: 'Unknown API route' });
}

// ---------------------------------------------------------------------------
// Request dispatcher
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  let urlObj;
  try {
    urlObj = new URL(req.url, 'http://localhost');
  } catch {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }
  const p = urlObj.pathname;

  try {
    if (p === '/img') return await handleImageProxy(req, res, urlObj);
    if (p.startsWith('/api/')) return await handleApi(req, res, urlObj);

    if (p === '/' || p === '/index.html') return serveStatic(res, 'index.html');
    if (p === '/admin' || p === '/admin.html') return serveStatic(res, 'admin.html');

    // static assets
    return serveStatic(res, p.replace(/^\/+/, ''));
  } catch (err) {
    console.error('Request error:', err);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: err.message });
    else res.end();
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

(async function main() {
  // Let undici accept self-signed certs from LAN Tautulli boxes.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = process.env.NODE_TLS_REJECT_UNAUTHORIZED || '0';

  const port = await pickPort();
  config.port = port;
  saveConfig(config);

  server.listen(port, '0.0.0.0', () => {
    const line = '='.repeat(58);
    console.log('\n' + line);
    console.log('  🎬  Tautulli Marquee is now showing');
    console.log(line);
    console.log(`  Now Playing screen : http://localhost:${port}/`);
    console.log(`  Admin backend      : http://localhost:${port}/admin`);
    console.log(`  (also reachable on your LAN IP at the same port)`);
    console.log(line + '\n');
    if (config.instances.length === 0) {
      console.log('  No Tautulli instances configured yet.');
      console.log('  Open the Admin page above to add your first one.\n');
    }
  });
})().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
