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

  // Gate the admin UI behind login when a password is set.
  if (cfg.authRequired && !cfg.authed) {
    $('loginView').style.display = '';
    $('adminView').style.display = 'none';
    return;
  }
  $('loginView').style.display = 'none';
  $('adminView').style.display = '';

  $('theme').value = cfg.theme || 'marquee';
  $('refresh').value = cfg.refreshSeconds || 15;
  $('scrollDir').value = cfg.scrollDirection || 'vertical';
  renderRows(cfg.instances || []);

  // Security card: toggle reflects whether protection is on; the password box is
  // always available to set or change it.
  $('pwToggle').checked = !!cfg.authRequired;
  $('pwLabel').textContent = cfg.authRequired ? 'Change password' : 'Set password';
  $('pwInput').placeholder = cfg.authRequired ? 'Enter a new password' : 'At least 4 characters';
  $('logoutBtn').style.display = (cfg.authRequired && cfg.authed) ? '' : 'none';
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
      <td><span class="nametext">${esc(i.name)}</span><br><span style="font-size:0.72rem;color:#8b98aa;text-transform:uppercase;letter-spacing:0.06em;">${esc(typeLabel(i.type))}</span></td>
      <td>${esc((i.https ? 'https://' : 'http://') + i.host + ':' + i.port)}</td>
      <td class="key">${esc(i.apiKeyMasked)}</td>
      <td style="text-align:right; white-space:nowrap;">
        <span class="status"></span>
        <button class="ghost small rename">Rename</button>
        <button class="ghost small test">Test</button>
        <button class="danger small del">Remove</button>
      </td>
    </tr>`).join('');

  tbody.querySelectorAll('.rename').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const tr = btn.closest('tr');
      const id = tr.dataset.id;
      const current = tr.querySelector('.nametext')?.textContent || '';
      const name = prompt('New name for this instance:', current);
      if (name === null) return;            // cancelled
      if (!name.trim()) return alert('Name cannot be empty.');
      const r = await (await fetch('/api/instances/' + encodeURIComponent(id), {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() })
      })).json();
      if (r.ok) loadConfig();
      else alert(r.error || 'Rename failed.');
    });
  });

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
  const scrollDirection = $('scrollDir').value;
  try {
    await fetch('/api/theme', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme, refreshSeconds, scrollDirection })
    });
    setMsg($('displayMsg'), '✓ Saved.', 'ok');
  } catch (e) {
    setMsg($('displayMsg'), '✗ ' + e.message, 'err');
  }
});

// ---- auth ----------------------------------------------------------------

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  let data = {};
  try { data = await res.json(); } catch { /* ignore */ }
  return { ok: res.ok && data.ok !== false, data };
}

async function doLogin() {
  const { ok, data } = await postJson('/api/auth/login', { password: $('loginPw').value });
  if (ok) { $('loginPw').value = ''; setMsg($('loginMsg'), '', ''); loadConfig(); }
  else setMsg($('loginMsg'), '✗ ' + (data.error || 'Login failed'), 'err');
}
$('loginBtn').addEventListener('click', doLogin);
$('loginPw').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

// Toggle enables/disables password protection.
$('pwToggle').addEventListener('change', async () => {
  if ($('pwToggle').checked) {
    // Turning ON: prompt for a password (protection activates on Save).
    setMsg($('secMsg'), 'Enter a password below and click Save to enable protection.', '');
    $('pwInput').focus();
  } else {
    // Turning OFF: remove the password.
    if (!confirm('Disable the admin password? The admin page will be open to anyone on your network.')) {
      $('pwToggle').checked = true;
      return;
    }
    const { ok, data } = await postJson('/api/auth/disable-password', {});
    if (ok) { setMsg($('secMsg'), '✓ Password protection disabled.', 'ok'); loadConfig(); }
    else { $('pwToggle').checked = true; setMsg($('secMsg'), '✗ ' + (data.error || 'Failed'), 'err'); }
  }
});

// Save sets or changes the password (works whether or not one exists yet).
async function savePassword() {
  const pw = $('pwInput').value.trim();
  if (pw.length < 4) return setMsg($('secMsg'), '✗ Password must be at least 4 characters.', 'err');
  const { ok, data } = await postJson('/api/auth/set-password', { newPassword: pw });
  if (ok) { $('pwInput').value = ''; setMsg($('secMsg'), '✓ Password saved. Admin login is now required.', 'ok'); loadConfig(); }
  else setMsg($('secMsg'), '✗ ' + (data.error || 'Failed'), 'err');
}
$('savePwBtn').addEventListener('click', savePassword);
$('pwInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') savePassword(); });

$('logoutBtn').addEventListener('click', async () => {
  await postJson('/api/auth/logout', {});
  loadConfig();
});

applyTypeUI();
loadConfig();
