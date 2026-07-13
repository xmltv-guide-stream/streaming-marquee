'use strict';

/* Tautulli Marquee — front-end for the Now Playing screen */

const grid = document.getElementById('grid');
const emptyEl = document.getElementById('empty');
const errbar = document.getElementById('errbar');
const clockEl = document.getElementById('clock');
const themebar = document.getElementById('themebar');

let refreshSeconds = 15;
let pollTimer = null;
let serverOffset = 0; // (serverTime - clientTime), to render end times consistently

// ---- theme handling ------------------------------------------------------

function applyTheme(theme) {
  document.body.setAttribute('data-theme', theme);
  for (const btn of themebar.querySelectorAll('button')) {
    btn.classList.toggle('active', btn.dataset.theme === theme);
  }
}

themebar.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const theme = btn.dataset.theme;
  applyTheme(theme);
  // Persist as the default server-side so all screens agree.
  fetch('/api/theme', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ theme })
  }).catch(() => {});
});

// ---- formatting helpers --------------------------------------------------

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function fmtRemaining(ms) {
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 1) return 'moments';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

// ---- rendering -----------------------------------------------------------

function posterUrl(item) {
  const instId = item.id.split(':')[0];
  const params = new URLSearchParams({ i: instId });
  if (item.chImg) params.set('u', item.chImg);         // Channels DVR guide art (absolute URL)
  else if (item.jf) params.set('jf', item.jf);         // Jellystat/Jellyfin item id
  else if (item.img) params.set('img', item.img);      // Tautulli image path
  else if (item.ratingKey) params.set('rating_key', item.ratingKey);
  else return null;
  return '/img?' + params.toString();
}

function cardHtml(item) {
  const pu = posterUrl(item);
  // Live TV with a guide poster shows the poster; without one it falls back to a
  // distinct "broadcast" tile.
  const liveTile = `<div class="livetile">
         <div class="livetile-glyph">📡</div>
         <div class="livetile-channel">${esc(item.title)}</div>
       </div>`;
  const poster = (item.live && !pu)
    ? liveTile
    : (pu
      ? `<img src="${esc(pu)}" alt="" loading="lazy"
             onerror="this.style.display='none';this.parentNode.querySelector('.noart').style.display='flex';" />
         <div class="noart" style="display:none;">${esc(item.title)}</div>`
      : `<div class="noart">${esc(item.title)}</div>`);

  const cornerFlag = item.live
    ? '<div class="liveflag">● Live</div>'
    : (item.state === 'paused' ? '<div class="pausedflag">Paused</div>' : '');

  let statusRow;
  if (item.live) {
    statusRow = '<div class="row"><span class="label">Status</span><span class="value ends">● LIVE</span></div>';
  } else if (item.state === 'playing' && item.endTime) {
    statusRow = `<div class="row"><span class="label">Ends</span>
         <span class="value ends">${esc(fmtTime(item.endTime + serverOffset))}
         <small>(${esc(fmtRemaining(item.remainingMs))} left)</small></span></div>`;
  } else {
    statusRow = '<div class="row"><span class="label">Status</span><span class="value">Paused</span></div>';
  }

  const badges = [];
  if (item.transcodeDecision) {
    const t = item.transcodeDecision === 'transcode' ? 'Transcode'
      : item.transcodeDecision === 'copy' ? 'Direct Stream' : 'Direct Play';
    badges.push(`<span class="badge">${esc(t)}</span>`);
  }

  const subtitle = item.subtitle
    ? `<div class="subtitle">${esc(item.subtitle)}</div>` : '';

  const instanceTag = item.instance
    ? `<div class="instance-tag">${esc(item.instance)}</div>` : '';

  // Live items have no meaningful progress bar.
  const progress = item.live
    ? ''
    : `<div class="progress"><span style="width:${Math.max(0, Math.min(100, item.progressPercent))}%"></span></div>`;

  const watcherLabel = item.live ? 'Now on' : 'Now watching';

  return `
    <article class="card${item.live ? ' card-live' : ''}">
      <div class="poster">
        ${poster}
        ${instanceTag}
        ${cornerFlag}
        ${progress}
      </div>
      <div class="info">
        <div class="title">${esc(item.title)}</div>
        ${subtitle}
        <div class="meta">
          <div class="row"><span class="label">${watcherLabel}</span><span class="value">${esc(item.user)}</span></div>
          ${statusRow}
          ${(!item.live && item.player) ? `<div class="row"><span class="label">On</span><span class="value">${esc(item.player)}</span></div>` : ''}
          ${badges.length ? `<div class="row"><span class="label">Stream</span><span class="value">${badges.join(' ')}</span></div>` : ''}
        </div>
      </div>
    </article>`;
}

function render(data) {
  serverOffset = 0; // endTime already computed with server clock; local clock is close enough
  const items = data.items || [];

  if (items.length === 0) {
    grid.innerHTML = '';
    grid.style.display = 'none';
    emptyEl.style.display = 'flex';
  } else {
    emptyEl.style.display = 'none';
    grid.style.display = 'grid';
    grid.innerHTML = items.map(cardHtml).join('');
  }

  if (data.errors && data.errors.length) {
    errbar.textContent = '⚠ ' + data.errors
      .map((e) => `${e.instance}: ${e.error}`).join('  •  ');
  } else {
    errbar.textContent = '';
  }
}

// ---- polling -------------------------------------------------------------

async function poll() {
  try {
    const res = await fetch('/api/nowplaying', { cache: 'no-store' });
    const data = await res.json();
    render(data);
  } catch (err) {
    errbar.textContent = '⚠ Could not reach the server.';
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  poll();
  pollTimer = setInterval(poll, refreshSeconds * 1000);
}

// ---- clock ---------------------------------------------------------------

function tickClock() {
  const now = new Date();
  clockEl.textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    + '  ·  ' + now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
}
setInterval(tickClock, 1000);
tickClock();

// ---- init ----------------------------------------------------------------

async function init() {
  try {
    const cfg = await (await fetch('/api/config', { cache: 'no-store' })).json();
    if (cfg.theme) applyTheme(cfg.theme);
    if (cfg.refreshSeconds) refreshSeconds = cfg.refreshSeconds;
  } catch {
    applyTheme('marquee');
  }
  startPolling();
}

init();
