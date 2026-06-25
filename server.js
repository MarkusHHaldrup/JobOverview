const path     = require('path');
const fs       = require('fs');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express  = require('express');
const { google } = require('googleapis');

const app = express();
app.use(express.json());

// Block server-side files from being served as static assets
const PRIVATE = ['/server.js', '/.env', '/package.json', '/package-lock.json', '/.tokens.json'];
app.use((req, res, next) => {
  if (PRIVATE.some(p => req.path === p)) return res.status(403).end();
  next();
});

app.use(express.static(__dirname));

// ── Google OAuth ─────────────────────────────────────────────────
const REDIRECT_URI = 'http://localhost:3000/auth/callback';
const TOKENS_FILE  = path.join(__dirname, '.tokens.json');
const SCOPES       = ['https://www.googleapis.com/auth/gmail.readonly'];

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  REDIRECT_URI
);

// Persist tokens so user doesn't re-auth on every restart
let storedTokens = null;
if (fs.existsSync(TOKENS_FILE)) {
  try {
    storedTokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
    oauth2Client.setCredentials(storedTokens);
    console.log('✓  Gmail: loaded saved credentials');
  } catch { /* ignore corrupt file */ }
}

oauth2Client.on('tokens', tokens => {
  if (!storedTokens) storedTokens = {};
  if (tokens.refresh_token) storedTokens.refresh_token = tokens.refresh_token;
  storedTokens.access_token = tokens.access_token;
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(storedTokens, null, 2));
});

app.get('/auth/google', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.status(500).send('Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in .env');
  }
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect('/?gmail_error=1');
  try {
    const { tokens } = await oauth2Client.getToken(code);
    storedTokens = tokens;
    oauth2Client.setCredentials(tokens);
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
    console.log('✓  Gmail authorised successfully');
    res.redirect('/?gmail_ok=1');
  } catch (err) {
    console.error('OAuth callback error:', err.message);
    res.redirect('/?gmail_error=1');
  }
});

app.get('/auth/status', (req, res) => {
  res.json({ authenticated: !!storedTokens });
});

app.get('/auth/disconnect', (req, res) => {
  storedTokens = null;
  if (fs.existsSync(TOKENS_FILE)) fs.unlinkSync(TOKENS_FILE);
  res.json({ ok: true });
});

// ── Email analysis ───────────────────────────────────────────────
// Senders to always skip (job boards, marketing)
const SKIP_SENDERS = [
  'linkedin.com', 'indeed.com', 'glassdoor.com', 'jobindex.dk',
  'monster.com', 'stepstone.', 'jobnet.dk', 'careers-page.com',
  'noreply@', 'no-reply@', 'notifications@', 'donotreply@',
  'mailer@', 'newsletter', 'marketing',
];

// Status detection — ordered by priority (most specific first)
const STATUS_RULES = [
  {
    status: 'rejected',
    keywords: [
      'unfortunately', 'regret to inform', 'not moving forward', 'other candidates',
      'not selected', 'we regret', 'not be proceeding', 'decided to move forward with other',
      'not the right fit', 'position has been filled', 'not been successful',
      'vi har valgt', 'desværre', 'ikke går videre', // Danish
    ],
  },
  {
    status: 'offer',
    keywords: [
      'offer of employment', 'pleased to offer', 'job offer', 'we are delighted to offer',
      'formal offer', 'offer letter', 'offer you the position', 'thrilled to offer',
      'we would like to offer you', 'tilbud om ansættelse', // Danish
    ],
  },
  {
    status: 'interview',
    keywords: [
      'interview', 'schedule a call', 'phone screen', 'video call', 'next round',
      'we would like to meet', 'invitation to interview', 'invite you to interview',
      'introductory call', 'next step', 'screening call',
      'til samtale', 'samtaleinvitation', 'vi vil gerne invitere', // Danish
    ],
  },
  {
    status: 'applied',
    keywords: [
      'received your application', 'thank you for applying', 'application received',
      'thank you for your application', 'we have received your application',
      'tak for din ansøgning', 'vi har modtaget', // Danish
    ],
  },
];

function detectStatus(text) {
  const lower = text.toLowerCase();
  for (const { status, keywords } of STATUS_RULES) {
    if (keywords.some(k => lower.includes(k))) return status;
  }
  return null;
}

// Fuzzy-match an email to a stored application by company name
function matchesApp(app, from, subject, snippet) {
  const haystack = (from + ' ' + subject + ' ' + snippet).toLowerCase();
  const company  = (app.company || '').toLowerCase().trim();
  if (!company || company === '—') return false;

  // Split company into meaningful words (>3 chars) and check coverage
  const words   = company.split(/[\s\-&.,/]+/).filter(w => w.length > 3);
  if (words.length === 0) return haystack.includes(company);
  const matched = words.filter(w => haystack.includes(w)).length;
  return matched >= Math.ceil(words.length * 0.7);
}

// ── RSS helper ───────────────────────────────────────────────────
function decodeEntities(str) {
  return str
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g,           (_, d) => String.fromCharCode(parseInt(d)))
    .replace(/&amp;/g,  '&').replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

function parseRSS(xml) {
  const items  = [];
  const itemRx = /<item>([\s\S]*?)<\/item>/g;
  const tagRx  = tag => new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))<\\/${tag}>`, 'i');
  const get    = (b, tag) => { const m = b.match(tagRx(tag)); return m ? (m[1] ?? m[2] ?? '').trim() : ''; };
  let m;
  while ((m = itemRx.exec(xml)) !== null) {
    const b    = m[1];
    const rawDesc = get(b, 'description');
    const html    = decodeEntities(rawDesc);
    const locM    = html.match(/class="jix_robotjob--area"[^>]*>([^<]+)</i);
    const loc     = locM ? locM[1].trim() : '';
    const text    = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 220);
    const rawTitle = decodeEntities(get(b, 'title'));
    const comma   = rawTitle.lastIndexOf(', ');
    const title   = comma > 0 ? rawTitle.slice(0, comma).trim() : rawTitle;
    const company = comma > 0 ? rawTitle.slice(comma + 2).trim() : (decodeEntities(get(b, 'author')) || '—');
    const link    = get(b, 'link').replace(/\s/g, '');
    items.push({
      title,
      link,
      description: text,
      company,
      location: loc,
      pubDate:  get(b, 'pubDate'),
    });
  }
  return items;
}

// ── Location & type post-filters ────────────────────────────────
const LOCATION_KEYWORDS = {
  Copenhagen: ['københavn', 'copenhagen', 'kbh', 'storkøbenhavn', 'frederiksberg',
               'hellerup', 'gentofte', 'lyngby', 'gladsaxe', 'brøndby', 'hvidovre',
               'rødovre', 'ballerup', 'herlev', 'søborg', 'charlottenlund', 'vanløse',
               'valby', 'amager', 'østerbro', 'nørrebro', 'vesterbro', 'indre by',
               'taastrup', 'albertslund', 'ishøj', 'greve', 'solrød', 'dragør'],
  Aarhus:     ['aarhus', 'århus', 'midtjylland', 'brabrand', 'viby', 'skejby', 'risskov'],
  Odense:     ['odense', 'fyn', 'funen', 'svendborg', 'nyborg', 'kerteminde'],
};

const STUDENT_KEYWORDS  = ['studiejob', 'studentermedhjælper', 'student assistant',
                            'studentjob', 'studentermedhjælp'];
const PARTTIME_KEYWORDS = ['deltid', 'part-time', 'part time', 'delstilling'];

function matchesLocation(jobLoc, requested) {
  if (!requested || requested === 'all') return true;
  if (!jobLoc) return false;   // unknown location — exclude when a filter is active
  const loc  = jobLoc.toLowerCase();
  const keys = LOCATION_KEYWORDS[requested];
  if (!keys) return true;
  return keys.some(k => loc.includes(k));
}

function matchesType(job, type) {
  if (!type || type === 'any' || type === 'fulltime') return true;
  const text = (job.title + ' ' + job.snippet).toLowerCase();
  if (type === 'student')  return STUDENT_KEYWORDS.some(k => text.includes(k));
  if (type === 'parttime') return PARTTIME_KEYWORDS.some(k => text.includes(k));
  return true;
}

// ── Multi-source job search ──────────────────────────────────────
app.post('/api/jobs', async (req, res) => {
  const { keywords = '', location = 'Copenhagen', type = '', apiId = '', apiKey = '' } = req.body;
  const results = [];
  const sources = [];

  const loc    = (location === 'all' || location === '') ? '' : location;
  const azWhere = { Copenhagen: 'Copenhagen', Aarhus: 'Aarhus', Odense: 'Odense', '': '' }[loc] ?? loc;
  const azType  = { fulltime: 'permanent', parttime: 'part_time', student: '', any: '' }[type] || '';

  // Jobindex ignores jobtypes= in RSS — inject type terms into keyword search instead
  const TYPE_EXTRA = {
    student:  'studiejob studentermedhjælper',
    parttime: 'deltid',
    fulltime: 'fuldtid',
  };
  const typeExtra = TYPE_EXTRA[type] || '';
  const jiQ  = [keywords, typeExtra].filter(Boolean).join(' ');
  const azQ  = [keywords, type === 'student' ? 'student studiejob' : ''].filter(Boolean).join(' ');

  // ── Source 1: Jobindex.dk RSS ───────────────────────────────────
  try {
    const url = new URL('https://www.jobindex.dk/jobsoegning.xml');
    if (jiQ) url.searchParams.set('q', jiQ);

    const r    = await fetch(url.toString(), {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JobOverview/1.0)' },
    });
    // Jobindex RSS is ISO-8859-1 — decode correctly
    const buf  = await r.arrayBuffer();
    const xml  = new TextDecoder('iso-8859-1').decode(buf);
    const items = parseRSS(xml);
    for (const j of items) {
      const id = 'ji_' + (j.link.match(/\/([a-z0-9]+)$/i)?.[1] || Buffer.from(j.link).toString('base64').slice(-12));
      results.push({
        id,
        title:    j.title,
        company:  j.company,
        location: j.location || '',
        snippet:  j.description,
        url:      j.link,
        source:   'Jobindex.dk',
        date:     j.pubDate,
      });
    }
    if (items.length) sources.push('Jobindex.dk');
  } catch (e) { console.error('Jobindex:', e.message); }

  // ── Source 2: Adzuna ────────────────────────────────────────────
  if (apiId && apiKey) {
    try {
      const url = new URL('https://api.adzuna.com/v1/api/jobs/dk/search/1');
      url.searchParams.set('app_id',           apiId);
      url.searchParams.set('app_key',          apiKey);
      url.searchParams.set('results_per_page', '15');
      url.searchParams.set('sort_by',          'relevance');
      if (azQ)     url.searchParams.set('what',  azQ);
      if (azWhere) url.searchParams.set('where',         azWhere);
      if (azType)  url.searchParams.set('contract_type', azType);

      const r    = await fetch(url.toString());
      const data = await r.json();
      for (const j of data.results || []) {
        results.push({
          id:       'az_' + j.id,
          title:    j.title || '',
          company:  j.company?.display_name || '—',
          location: j.location?.display_name || azWhere || '',
          snippet:  (j.description || '').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0, 220),
          url:      j.redirect_url || '',
          source:   'Adzuna',
          date:     j.created || '',
        });
      }
      if (data.results?.length) sources.push('Adzuna');
    } catch (e) { console.error('Adzuna:', e.message); }
  }

  // ── Source 3: TheHub.io ─────────────────────────────────────────
  try {
    const url = new URL('https://thehub.io/api/jobs');
    url.searchParams.set('countryCode', 'DK');
    url.searchParams.set('limit',       '20');
    if (jiQ) url.searchParams.set('q', jiQ);

    const r    = await fetch(url.toString(), {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JobOverview/1.0)' },
    });
    const data = await r.json();
    for (const j of data.docs || []) {
      const jobLoc = (j.location?.locality || '').toLowerCase();
      results.push({
        id:       'th_' + j.id,
        title:    (j.title || '').trim(),
        company:  j.company?.name || '—',
        location: j.location?.locality || 'Denmark',
        snippet:  (j.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 220),
        url:      j.absoluteJobUrl || '',
        source:   'TheHub.io',
        date:     (j.publishedAt || j.createdAt || '').slice(0, 10),
      });
    }
    if (data.docs?.length) sources.push('TheHub.io');
  } catch (e) { console.error('TheHub:', e.message); }

  // ── Source 4: Jobsearch.dk RSS ──────────────────────────────────
  try {
    const JS_CITY = { Copenhagen: '9', Aarhus: '11', Odense: '10' };
    const cityId  = loc ? JS_CITY[loc] : '';
    const feedUrl = cityId
      ? `https://jobsearch.dk/feed/job-annoncer/${cityId}`
      : 'https://jobsearch.dk/feed/job-annoncer';

    const r   = await fetch(feedUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JobOverview/1.0)' },
    });
    const xml = await r.text();
    const itemRx = /<item>([\s\S]*?)<\/item>/g;
    const tagRx  = tag => new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
    const get    = (b, t) => { const m = b.match(tagRx(t)); return m ? m[1].trim() : ''; };
    let m;
    while ((m = itemRx.exec(xml)) !== null) {
      const b       = m[1];
      const rawTitle = decodeEntities(get(b, 'title'));  // "Category i City"
      const category = rawTitle.replace(/\s+i\b.*$/, '').trim() || rawTitle.trim();
      const city     = (rawTitle.match(/\s+i\s+(.+)/) || [])[1]?.trim() || '';
      const link     = get(b, 'link').replace(/\s/g, '');
      const snippet  = decodeEntities(get(b, 'description')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 220);
      const jobId    = 'js_' + (link.match(/\/(\d+)$/)?.[1] || link.slice(-10));
      results.push({
        id:       jobId,
        title:    category,
        company:  '—',
        location: city || (loc ? { Copenhagen: 'Copenhagen', Aarhus: 'Aarhus', Odense: 'Odense' }[loc] : 'Denmark'),
        snippet,
        url:      link,
        source:   'Jobsearch.dk',
        date:     '',
      });
    }
    const jsCount = results.filter(j => j.source === 'Jobsearch.dk').length;
    if (jsCount) sources.push('Jobsearch.dk');
  } catch (e) { console.error('Jobsearch:', e.message); }

  // Post-filter by location and job type, then deduplicate, keep top 20
  const seen   = new Set();
  const unique = results
    .filter(j => matchesLocation(j.location, location) && matchesType(j, type))
    .filter(j => {
      const key = (j.title + j.company).toLowerCase().replace(/\s+/g, '');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 20);

  res.json({ jobs: unique, sources });
});

// ── Gmail sync endpoint ──────────────────────────────────────────
app.post('/api/sync', async (req, res) => {
  if (!storedTokens) {
    return res.status(401).json({ error: 'not_authenticated' });
  }

  oauth2Client.setCredentials(storedTokens);
  const gmail        = google.gmail({ version: 'v1', auth: oauth2Client });
  const applications = req.body.applications || [];
  const updates      = [];
  const seen         = new Set(); // one update per application max

  // Broad search query — job-related keywords, exclude known job boards
  const QUERY = [
    '(interview OR "your application" OR "job offer" OR "offer of employment"',
    'OR unfortunately OR "regret to inform" OR "next steps" OR "phone screen"',
    'OR "til samtale" OR "tak for din ansøgning" OR "vi har valgt" OR desværre)',
    '-from:linkedin.com -from:indeed.com -from:glassdoor.com',
    '-from:jobindex.dk -from:monster.com -from:stepstone.',
    'newer_than:90d',
  ].join(' ');

  try {
    const listRes = await gmail.users.messages.list({
      userId: 'me',
      q: QUERY,
      maxResults: 75,
    });

    const messages = listRes.data.messages || [];
    console.log(`Gmail sync: ${messages.length} candidate emails found`);

    for (const msg of messages) {
      const msgRes = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'metadata',
        metadataHeaders: ['Subject', 'From', 'Date'],
      });

      const headers = msgRes.data.payload?.headers || [];
      const subject = headers.find(h => h.name === 'Subject')?.value || '';
      const from    = headers.find(h => h.name === 'From')?.value || '';
      const date    = headers.find(h => h.name === 'Date')?.value || '';
      const snippet = msgRes.data.snippet || '';

      // Skip marketing / job-board emails
      const fromLower = from.toLowerCase();
      if (SKIP_SENDERS.some(s => fromLower.includes(s))) continue;

      const newStatus = detectStatus(subject + ' ' + snippet);
      if (!newStatus) continue;

      // Find the first unmatched application whose company name matches
      const matched = applications.find(a => !seen.has(a.id) && matchesApp(a, from, subject, snippet));
      if (matched) {
        seen.add(matched.id);
        updates.push({ appId: matched.id, newStatus, emailSubject: subject, emailFrom: from, emailDate: date });
        console.log(`  → "${matched.company}" (${matched.title}): ${matched.status} → ${newStatus}`);
      }
    }
  } catch (err) {
    console.error('Gmail sync error:', err.message);
    return res.status(500).json({ error: err.message });
  }

  console.log(`Sync done: ${updates.length} application(s) updated`);
  res.json({ updates });
});

// ── One-time seed route ──────────────────────────────────────────
app.get('/seed', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>
<script>
const apps = JSON.parse(localStorage.getItem('jov_apps') || '[]');
const t = Date.now();
apps.push(
  { id: String(t),   company: 'STADA Nordic', title: 'Master Data Studiejob', url: '', status: 'applied', date: '2026-06-20' },
  { id: String(t+1), company: 'FDM', title: 'Studentermedhjælper til analyse, forretningsudvikling og porteføljestyring', url: '', status: 'applied', date: '2026-06-21' },
  { id: String(t+2), company: 'Molio', title: 'Studentermedhjælper til IT og projektledelse', url: '', status: 'applied', date: '2026-06-19' }
);
localStorage.setItem('jov_apps', JSON.stringify(apps));
window.location.href = '/';
</script>
</body></html>`);
});

// ── Start ────────────────────────────────────────────────────────
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`\nJobOverview  →  http://localhost:${PORT}\n`);
  if (!process.env.GOOGLE_CLIENT_ID) {
    console.log('⚠  Gmail sync disabled — add credentials to .env (see .env.example)');
  } else if (!storedTokens) {
    console.log(`📧 Gmail not yet connected. Visit http://localhost:${PORT}/auth/google to authorise.`);
  }
});
