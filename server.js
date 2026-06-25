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
