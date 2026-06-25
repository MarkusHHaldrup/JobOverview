// ── State ──────────────────────────────────────────────────────────
let applications  = [];
let rejectedIds   = new Set();   // job IDs dismissed in browse view
let currentFilter = 'all';
let _jobMap       = {};          // id → raw Adzuna job object, for accept handler

const STATUSES = {
  waiting:   'Waiting to Apply',
  applied:   'Applied',
  interview: 'Interview Scheduled',
  offer:     'Offer Received',
  rejected:  'Rejected',
};

// ── Persistence ────────────────────────────────────────────────────
function saveData() {
  localStorage.setItem('jov_apps',     JSON.stringify(applications));
  localStorage.setItem('jov_rejected', JSON.stringify([...rejectedIds]));
}

function loadData() {
  try { applications = JSON.parse(localStorage.getItem('jov_apps') || '[]'); } catch { applications = []; }
  try { rejectedIds  = new Set(JSON.parse(localStorage.getItem('jov_rejected') || '[]')); } catch { rejectedIds = new Set(); }
}

// ── Tabs ───────────────────────────────────────────────────────────
function switchTab(id) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === id));
  document.querySelectorAll('.tab-content').forEach(s => s.classList.toggle('active', s.id === id));
  if (id === 'applications') renderApplications();
}

// ── Badge ──────────────────────────────────────────────────────────
function updateBadge() {
  const el = document.getElementById('app-count');
  const n  = applications.length;
  el.textContent = n;
  el.classList.toggle('hidden', n === 0);
}

// ── Job Search ─────────────────────────────────────────────────────
async function searchJobs() {
  const appId  = localStorage.getItem('jov_api_id');
  const appKey = localStorage.getItem('jov_api_key');
  const query  = document.getElementById('search-query').value.trim();
  const grid   = document.getElementById('job-list');

  if (!appId || !appKey) {
    grid.innerHTML = `
      <div class="setup-prompt">
        <h3>Connect your job feed</h3>
        <p>JobOverview uses the free <a href="https://developer.adzuna.com/" target="_blank" rel="noopener">Adzuna API</a>
           to find real jobs in Copenhagen.<br>
           Register (no credit card) to get your App ID and App Key — 1 000 free calls per month.</p>
        <button onclick="openApiModal()">Set Up API Key</button>
      </div>`;
    return;
  }

  grid.innerHTML = '<div class="loading">Searching jobs in Copenhagen…</div>';
  _jobMap = {};

  try {
    const url = new URL('https://api.adzuna.com/v1/api/jobs/dk/search/1');
    url.searchParams.set('app_id',          appId);
    url.searchParams.set('app_key',         appKey);
    url.searchParams.set('where',           'Copenhagen');
    url.searchParams.set('results_per_page','24');
    url.searchParams.set('sort_by',         'date');
    if (query) url.searchParams.set('what', query);

    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} — check your API credentials.`);
    const data = await res.json();
    renderJobs(data.results || []);
  } catch (err) {
    grid.innerHTML = `<div class="error-banner">⚠ Could not load jobs: ${escHtml(err.message)}</div>`;
  }
}

function renderJobs(jobs) {
  const grid    = document.getElementById('job-list');
  const visible = jobs.filter(j => !rejectedIds.has(String(j.id)));

  if (visible.length === 0) {
    grid.innerHTML = '<div class="empty-state"><h3>No jobs found</h3><p>Try different keywords or clear the search box.</p></div>';
    return;
  }

  grid.innerHTML = visible.map(job => {
    const id      = String(job.id);
    const title   = job.title || 'Untitled';
    const company = job.company?.display_name || 'Unknown company';
    const loc     = job.location?.display_name || 'Copenhagen';
    const snippet = stripHtml(job.description || '').slice(0, 200) + '…';
    const link    = job.redirect_url || '#';
    _jobMap[id]   = { id, title, company, url: link };

    return `
    <div class="job-card" id="jcard-${id}">
      <div class="job-title">${escHtml(title)}</div>
      <div class="job-company">${escHtml(company)}</div>
      <div class="job-loc">📍 ${escHtml(loc)}</div>
      <div class="job-snippet">${escHtml(snippet)}</div>
      <div class="job-footer">
        <a href="${escHtml(link)}" target="_blank" rel="noopener">View posting ↗</a>
        <button class="btn-reject" onclick="rejectJob('${id}')">Reject</button>
        <button class="btn-accept" onclick="acceptJob('${id}')">Accept</button>
      </div>
    </div>`;
  }).join('');
}

// ── Accept / Reject ────────────────────────────────────────────────
function acceptJob(id) {
  const job = _jobMap[id];
  if (!job) return;
  applications.unshift({
    id:        crypto.randomUUID(),
    title:     job.title,
    company:   job.company,
    url:       job.url,
    status:    'waiting',
    addedDate: today(),
  });
  rejectedIds.add(id);  // hide from browse so it doesn't resurface
  saveData();
  updateBadge();
  removeJobCard(id);
  showToast(`"${job.title}" added to My Applications.`);
}

function rejectJob(id) {
  rejectedIds.add(String(id));
  saveData();
  removeJobCard(id);
}

function removeJobCard(id) {
  document.getElementById(`jcard-${id}`)?.remove();
  // show empty state if grid is now empty
  const grid = document.getElementById('job-list');
  if (!grid.querySelector('.job-card')) {
    grid.innerHTML = '<div class="empty-state"><h3>No more jobs</h3><p>Search again with different keywords.</p></div>';
  }
}

// ── Applications list ──────────────────────────────────────────────
function renderApplications() {
  const list     = document.getElementById('app-list');
  const filtered = currentFilter === 'all'
    ? applications
    : applications.filter(a => a.status === currentFilter);

  if (filtered.length === 0) {
    list.innerHTML = `<div class="empty-state">
      <h3>No applications ${currentFilter === 'all' ? 'yet' : 'with this status'}</h3>
      <p>${currentFilter === 'all' ? 'Accept jobs from Browse, or click <strong>+ Add Manually</strong>.' : 'Change the status filter above.'}</p>
    </div>`;
    return;
  }

  list.innerHTML = filtered.map(app => `
    <div class="app-card" data-status="${app.status}" data-id="${app.id}">
      <div class="app-info">
        <div class="app-title">${escHtml(app.title)}</div>
        <div class="app-company">${escHtml(app.company)}</div>
        <div class="app-date">Added ${app.addedDate}</div>
      </div>
      ${app.url ? `<a href="${escHtml(app.url)}" target="_blank" rel="noopener">View ↗</a>` : ''}
      <select class="app-status-select" onchange="updateStatus('${app.id}', this.value)">
        ${Object.entries(STATUSES).map(([val, label]) =>
          `<option value="${val}"${app.status === val ? ' selected' : ''}>${label}</option>`
        ).join('')}
      </select>
      <button class="btn-del" onclick="deleteApp('${app.id}')" title="Remove">✕</button>
    </div>
  `).join('');
}

function updateStatus(id, status) {
  const app = applications.find(a => a.id === id);
  if (!app) return;
  app.status = status;
  saveData();
  // update border colour without full re-render
  const card = document.querySelector(`.app-card[data-id="${id}"]`);
  if (card) card.dataset.status = status;
}

function deleteApp(id) {
  applications = applications.filter(a => a.id !== id);
  saveData();
  updateBadge();
  renderApplications();
}

// ── Manual add modal ───────────────────────────────────────────────
function openManualModal() {
  ['m-title','m-company','m-url'].forEach(i => document.getElementById(i).value = '');
  document.getElementById('m-status').value = 'waiting';
  document.getElementById('manual-modal').classList.remove('hidden');
  document.getElementById('m-title').focus();
}
function closeManualModal() {
  document.getElementById('manual-modal').classList.add('hidden');
}
function saveManual() {
  const title = document.getElementById('m-title').value.trim();
  if (!title) { document.getElementById('m-title').focus(); return; }
  applications.unshift({
    id:        crypto.randomUUID(),
    title,
    company:   document.getElementById('m-company').value.trim() || '—',
    url:       document.getElementById('m-url').value.trim(),
    status:    document.getElementById('m-status').value,
    addedDate: today(),
  });
  saveData();
  updateBadge();
  closeManualModal();
  renderApplications();
}

// ── API key modal ──────────────────────────────────────────────────
function openApiModal() {
  document.getElementById('input-api-id').value  = localStorage.getItem('jov_api_id')  || '';
  document.getElementById('input-api-key').value = localStorage.getItem('jov_api_key') || '';
  document.getElementById('api-modal').classList.remove('hidden');
  document.getElementById('input-api-id').focus();
}
function closeApiModal() {
  document.getElementById('api-modal').classList.add('hidden');
}
function saveApiKey() {
  const id  = document.getElementById('input-api-id').value.trim();
  const key = document.getElementById('input-api-key').value.trim();
  if (id)  localStorage.setItem('jov_api_id',  id);
  if (key) localStorage.setItem('jov_api_key', key);
  closeApiModal();
  searchJobs();
}

// ── Gmail sync ─────────────────────────────────────────────────────
let _gmailAvailable = false;
let _pendingUpdates = []; // proposed changes awaiting user review

function showGmailPane(name) {
  ['disconnected', 'connected', 'unavailable'].forEach(n =>
    document.getElementById(`gmail-status-${n}`).classList.toggle('hidden', n !== name)
  );
}

async function initGmail() {
  try {
    const res  = await fetch('/auth/status', { signal: AbortSignal.timeout(1500) });
    const data = await res.json();
    _gmailAvailable = true;
    showGmailPane(data.authenticated ? 'connected' : 'disconnected');
  } catch {
    _gmailAvailable = false;
    showGmailPane('unavailable');
  }

  // Handle redirect back from OAuth
  const params = new URLSearchParams(location.search);
  if (params.get('gmail_ok')) {
    history.replaceState({}, '', location.pathname);
    showGmailPane('connected');
    showToast('Gmail connected! Click "Sync with Gmail" to check your emails.');
    switchTab('applications');
  } else if (params.get('gmail_error')) {
    history.replaceState({}, '', location.pathname);
    showToast('Gmail authorisation failed — please try again.');
  }
}

function connectGmail() {
  window.location.href = '/auth/google';
}

async function disconnectGmail() {
  try { await fetch('/auth/disconnect'); } catch { /* ignore */ }
  showGmailPane('disconnected');
  showToast('Gmail disconnected.');
}

async function syncGmail() {
  const syncBtn = document.getElementById('gmail-sync-btn');
  syncBtn.textContent = '⏳ Syncing…';
  syncBtn.disabled = true;

  try {
    const res = await fetch('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        applications: applications.map(a => ({ id: a.id, title: a.title, company: a.company })),
      }),
    });

    if (res.status === 401) {
      showGmailPane('disconnected');
      showToast('Gmail session expired — please reconnect.');
      return;
    }
    if (!res.ok) throw new Error(`Server error ${res.status}`);

    const { updates } = await res.json();

    // Filter to only changes that actually differ from current status
    _pendingUpdates = updates.filter(u => {
      const app = applications.find(a => a.id === u.appId);
      return app && app.status !== u.newStatus;
    });

    if (_pendingUpdates.length === 0) {
      showToast('Gmail synced — no new status changes found.');
      return;
    }

    openSyncModal();
  } catch (err) {
    showToast('Sync failed: ' + err.message);
  } finally {
    syncBtn.textContent = '⟳ Sync with Gmail';
    syncBtn.disabled = false;
  }
}

// ── Sync review modal ──────────────────────────────────────────────
function openSyncModal() {
  const n = _pendingUpdates.length;
  document.getElementById('sync-modal-summary').textContent =
    `Found ${n} email update${n > 1 ? 's' : ''} for your applications. Review and apply below.`;

  document.getElementById('sync-review-list').innerHTML = _pendingUpdates.map((u, i) => {
    const app       = applications.find(a => a.id === u.appId);
    const oldLabel  = STATUSES[app.status]  || app.status;
    const newLabel  = STATUSES[u.newStatus] || u.newStatus;
    return `
    <label class="sync-review-item">
      <input type="checkbox" class="sync-check" data-index="${i}" checked>
      <div class="sync-review-info">
        <div class="sync-review-title">${escHtml(app.title)} <span class="sync-review-company">@ ${escHtml(app.company)}</span></div>
        <div class="sync-review-change">
          <span class="status-pill status-${app.status}">${oldLabel}</span>
          <span class="sync-arrow">→</span>
          <span class="status-pill status-${u.newStatus}">${newLabel}</span>
        </div>
        <div class="sync-review-email">📨 ${escHtml(u.emailSubject)}</div>
      </div>
    </label>`;
  }).join('');

  document.getElementById('sync-modal').classList.remove('hidden');
}

function closeSyncModal() {
  document.getElementById('sync-modal').classList.add('hidden');
  _pendingUpdates = [];
}

function applySyncUpdates(selectedOnly) {
  const checks = document.querySelectorAll('.sync-check');
  let applied  = 0;

  _pendingUpdates.forEach((u, i) => {
    if (selectedOnly && !checks[i]?.checked) return;
    const app = applications.find(a => a.id === u.appId);
    if (!app) return;
    app.status        = u.newStatus;
    app.lastEmail     = u.emailSubject;
    app.lastEmailDate = u.emailDate;
    applied++;
  });

  saveData();
  updateBadge();
  renderApplications();
  closeSyncModal();
  showToast(`${applied} application${applied > 1 ? 's' : ''} updated.`);
}

// ── Toast ──────────────────────────────────────────────────────────
let _toastTimer;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.add('hidden'), 3000);
}

// ── Helpers ────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function stripHtml(s) {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
function today() {
  return new Date().toISOString().slice(0, 10);
}

// ── Init ───────────────────────────────────────────────────────────
function init() {
  loadData();
  updateBadge();

  // Tabs
  document.querySelectorAll('.tab').forEach(btn =>
    btn.addEventListener('click', () => switchTab(btn.dataset.tab))
  );

  // Search
  document.getElementById('search-btn').addEventListener('click', searchJobs);
  document.getElementById('search-query').addEventListener('keydown', e => {
    if (e.key === 'Enter') searchJobs();
  });

  // Settings
  document.getElementById('settings-btn').addEventListener('click', openApiModal);
  document.getElementById('btn-save-api').addEventListener('click', saveApiKey);
  document.getElementById('btn-cancel-api').addEventListener('click', closeApiModal);

  // Gmail
  document.getElementById('gmail-connect-btn').addEventListener('click', connectGmail);
  document.getElementById('gmail-sync-btn').addEventListener('click', syncGmail);
  document.getElementById('gmail-disconnect-btn').addEventListener('click', disconnectGmail);
  document.getElementById('btn-sync-apply-all').addEventListener('click', () => applySyncUpdates(false));
  document.getElementById('btn-sync-apply-selected').addEventListener('click', () => applySyncUpdates(true));
  document.getElementById('btn-sync-dismiss').addEventListener('click', closeSyncModal);
  initGmail();

  // Manual add
  document.getElementById('add-btn').addEventListener('click', openManualModal);
  document.getElementById('btn-save-manual').addEventListener('click', saveManual);
  document.getElementById('btn-cancel-manual').addEventListener('click', closeManualModal);

  // Close modals on backdrop click
  document.querySelectorAll('.modal').forEach(m =>
    m.addEventListener('click', e => { if (e.target === m) m.classList.add('hidden'); })
  );

  // Status filters
  document.querySelectorAll('.filter-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.dataset.status;
      renderApplications();
    })
  );

  // Initial browse state
  const hasKey = localStorage.getItem('jov_api_id') && localStorage.getItem('jov_api_key');
  if (hasKey) {
    searchJobs();
  } else {
    document.getElementById('job-list').innerHTML = `
      <div class="setup-prompt">
        <h3>Connect your job feed</h3>
        <p>JobOverview uses the free <a href="https://developer.adzuna.com/" target="_blank" rel="noopener">Adzuna API</a>
           to find real jobs in Copenhagen.<br>
           Register (no credit card) to get your App ID and App Key — 1 000 free calls per month.</p>
        <button onclick="openApiModal()">Set Up API Key</button>
      </div>`;
  }
}

init();
