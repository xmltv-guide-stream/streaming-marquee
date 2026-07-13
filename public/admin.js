'use strict';

/* Admin backend UI logic */

const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

function setMsg(el, text, kind) {
  el.textContent = text;
  el.className = 'msg' + (kind ? ' ' + kind : '');
}

function readForm() {
  return {
    type: $('type').value,
    name: $('name').value.trim(),
    host: $('host').value.trim(),
    port: parseInt($('port').value, 10),
    apiKey: $('apiKey').value.trim(),
    https: $('https').checked
  };
}

// Default ports + key hint follow the selected backend.
const DEFAULT_PORTS = { tautulli: 8181, jellystat: 3000, channels: 8089 };
const KEY_HINTS = {
  tautulli: 'Tautulli: Settings → Web Interface → API key.',
  jellystat: 'Jellystat: Settings → API Keys → create a key.',
  channels: 'Channels DVR needs no API key on your LAN — leave this blank.'
};
function applyTypeUI() {
  const t = $('type').value;
  const cur = parseInt($('port').value, 10);
  const defaults = Object.values(DEFAULT_PORTS);
  if (!cur || defaults.includes(cur)) $('port').value = DEFAULT_PORTS[t];
  $('keyHint').textContent = KEY_HINTS[t];
  // Channels DVR has no API key — disable and clear the field.
  const isChannels = t === 'channels';
  $('apiKey').disabled = isChannels;
  $('apiKey').placeholder = isChannels ? 'Not required for Channels DVR' : 'Paste the API key';
  if (isChannels) $('apiKey').value = '';
}
$('type').addEventListener('change', applyTypeUI);

// ---- load + render list --------------------------------------------------

async function loadConfig() {
  const cfg = await (await fetch('/api/config', { cache: 'no-store' })).json();
  $('theme').value = cfg.theme || 'marquee';
  $('refresh').value = cfg.refreshSeconds || 15;
  renderRows(cfg.instances || []);
}

function renderRows(instances) {
  const tbody = $('rows');
  if (!instances.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="4">No instances yet — add one above.</td></tr>';
    return;
  }
  const typeLabel = (t) => (t === 'jellystat' ? 'Jellystat' : t === 'channels' ? 'Channels DVR' : 'Tautulli');
  tbody.innerHTML = instances.map((i) => `
    <tr data-id="${esc(i.id)}">
      <td>${esc(i.name)}<br><span style="font-size:0.72rem;color:#8b98aa;text-transform:uppercase;letter-spacing:0.06em;">${esc(typeLabel(i.type))}</span></td>
      <td>${esc((i.https ? 'https://' : 'http://') + i.host + ':' + i.port)}</td>
      <td class="key">${esc(i.apiKeyMasked)}</td>
      <td style="text-align:right; white-space:nowrap;">
        <span class="status"></span>
        <button class="ghost small test">Test</button>
        <button class="danger small del">Remove</button>
      </td>
    </tr>`).join('');

  tbody.querySelectorAll('.del').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.closest('tr').dataset.id;
      if (!confirm('Remove this instance?')) return;
      await fetch('/api/instances/' + encodeURIComponent(id), { method: 'DELETE' });
      loadConfig();
    });
  });

  tbody.querySelectorAll('.test').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const tr = btn.closest('tr');
      const statusEl = tr.querySelector('.status');
      statusEl.textContent = 'Testing…';
      statusEl.style.color = '#9aa7b8';
      try {
        const r = await (await fetch('/api/instances/' + encodeURIComponent(tr.dataset.id) + '/test', { method: 'POST' })).json();
        if (r.ok) { statusEl.textContent = '✓ ' + (r.serverName || 'Connected'); statusEl.style.color = '#62d09a'; }
        else { statusEl.textContent = '✗ ' + r.error; statusEl.style.color = '#f08b8b'; }
      } catch (e) {
        statusEl.textContent = '✗ ' + e.message; statusEl.style.color = '#f08b8b';
      }
    });
  });
}

// ---- actions -------------------------------------------------------------

function validateForm(data) {
  const needsKey = data.type !== 'channels';
  if (!data.host || !data.port) return 'Fill in host and port first.';
  if (needsKey && !data.apiKey) return 'Fill in host, port and API key first.';
  return null;
}

$('testBtn').addEventListener('click', async () => {
  const data = readForm();
  const err = validateForm(data);
  if (err) return setMsg($('addMsg'), err, 'err');
  setMsg($('addMsg'), 'Testing connection…', '');
  try {
    const r = await (await fetch('/api/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
    })).json();
    if (r.ok) setMsg($('addMsg'), '✓ Connected to ' + (r.serverName || 'server'), 'ok');
    else setMsg($('addMsg'), '✗ ' + r.error, 'err');
  } catch (e) {
    setMsg($('addMsg'), '✗ ' + e.message, 'err');
  }
});

$('addBtn').addEventListener('click', async () => {
  const data = readForm();
  const err = validateForm(data);
  if (err) return setMsg($('addMsg'), err, 'err');
  setMsg($('addMsg'), 'Adding…', '');
  try {
    const r = await (await fetch('/api/instances', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
    })).json();
    if (r.ok) {
      setMsg($('addMsg'), '✓ Added.', 'ok');
      $('name').value = ''; $('host').value = ''; $('apiKey').value = '';
      $('port').value = DEFAULT_PORTS[$('type').value] || 8181;
      $('https').checked = false;
      applyTypeUI();
      loadConfig();
    } else {
      setMsg($('addMsg'), '✗ ' + r.error, 'err');
    }
  } catch (e) {
    setMsg($('addMsg'), '✗ ' + e.message, 'err');
  }
});

$('saveDisplay').addEventListener('click', async () => {
  const theme = $('theme').value;
  const refreshSeconds = parseInt($('refresh').value, 10) || 15;
  try {
    await fetch('/api/theme', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme, refreshSeconds })
    });
    setMsg($('displayMsg'), '✓ Saved.', 'ok');
  } catch (e) {
    setMsg($('displayMsg'), '✗ ' + e.message, 'err');
  }
});

applyTypeUI();
loadConfig();
