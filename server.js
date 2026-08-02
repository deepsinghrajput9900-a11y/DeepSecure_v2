/**
 * DeepSecure backend (v2 — bug-fixed)
 * --------------------------------------------------------------------------
 * Fixes vs the first build:
 *  1. No native-compile dependency (dropped better-sqlite3 -> plain JSON
 *     file store). This was the cause of the Render build failure.
 *  2. The server no longer needs PUBLIC_BASE_URL set manually. It detects
 *     its own public address from the incoming request's headers
 *     (req.protocol + req.get('host')), which is what actually caused the
 *     "localhost" links bug — a forgotten/misconfigured env var. You can
 *     still set PUBLIC_BASE_URL to override this if you ever need to.
 *  3. A GET /api/config endpoint reports whether the server is fully
 *     configured (sender key set, etc.) — the frontend shows this as a
 *     banner instead of a confusing generic error.
 *
 * What this app does NOT do, on purpose: block screenshots/screen
 * recording, lock the viewer behind touch-and-hold, or wipe on app-switch.
 * None of that can be reliably enforced from a web app anyway. Real
 * protection here is server-enforced expiry + view limits + an audit trail
 * — if a file leaks, you know exactly which link and access it came from.
 * --------------------------------------------------------------------------
 */

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { nanoid } = require('nanoid');
const webpush = require('web-push');

const PORT = process.env.PORT || 3000;
const SENDER_API_KEY = process.env.SENDER_API_KEY || null;
// Optional manual override. Leave unset and the server will detect its own
// public URL from each request instead — this is the recommended path.
const PUBLIC_BASE_URL_OVERRIDE = process.env.PUBLIC_BASE_URL || null;

const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');
[DATA_DIR, UPLOAD_DIR].forEach((d) => fs.mkdirSync(d, { recursive: true }));

/* ---------------------------------------------------------------------- */
/* Tiny JSON-file database                                                 */
/* ---------------------------------------------------------------------- */

function loadDb() {
  if (!fs.existsSync(DB_FILE)) {
    return { links: {}, audit: [], pushSubscriptions: {}, nextAuditId: 1 };
  }
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (err) {
    console.error('Failed to read db.json, starting fresh:', err.message);
    return { links: {}, audit: [], pushSubscriptions: {}, nextAuditId: 1 };
  }
}
let db = loadDb();
function saveDb() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}
function insertLink(record) { db.links[record.token] = record; saveDb(); }
function getLink(token) { return db.links[token] || null; }
function listLinks() { return Object.values(db.links).sort((a, b) => b.created_at - a.created_at).slice(0, 200); }
function bumpView(token) { if (db.links[token]) db.links[token].view_count += 1; saveDb(); }
function setStatus(token, status) { if (db.links[token]) db.links[token].status = status; saveDb(); }
function insertAudit(token, actor, action, createdAt) {
  db.audit.push({ id: db.nextAuditId++, token, actor, action, created_at: createdAt });
  saveDb();
}
function listAudit() { return [...db.audit].sort((a, b) => b.created_at - a.created_at).slice(0, 100); }
function upsertSub(endpoint, subscriptionJson, createdAt) {
  db.pushSubscriptions[endpoint] = { endpoint, subscription_json: subscriptionJson, created_at: createdAt };
  saveDb();
}
function listSubs() { return Object.values(db.pushSubscriptions); }
function deleteSub(endpoint) { delete db.pushSubscriptions[endpoint]; saveDb(); }

/* ---------------------------------------------------------------------- */
/* Web Push (optional)                                                     */
/* ---------------------------------------------------------------------- */

const pushEnabled = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
if (pushEnabled) {
  webpush.setVapidDetails(
    process.env.VAPID_CONTACT_EMAIL || 'mailto:admin@example.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}
async function notifySender(title, body, data = {}) {
  if (!pushEnabled) return;
  const payload = JSON.stringify({ title, body, data });
  for (const sub of listSubs()) {
    try {
      await webpush.sendNotification(JSON.parse(sub.subscription_json), payload);
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) deleteSub(sub.endpoint);
      else console.error('Push send failed:', err.message);
    }
  }
}

/* ---------------------------------------------------------------------- */
/* App setup                                                               */
/* ---------------------------------------------------------------------- */

const app = express();
app.set('trust proxy', true); // needed so req.protocol reflects the real https scheme behind Render's proxy
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const viewLimiter = rateLimit({ windowMs: 60 * 1000, max: 30 });
const uploadLimiter = rateLimit({ windowMs: 60 * 1000, max: 20 });

function requireSender(req, res, next) {
  if (!SENDER_API_KEY) {
    return res.status(500).json({ error: 'Server not configured: set SENDER_API_KEY in your host\'s environment variables' });
  }
  if (req.get('x-sender-key') !== SENDER_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function fingerprint(req) {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const ua = req.headers['user-agent'] || 'unknown';
  return crypto.createHash('sha256').update(ip + '|' + ua).digest('hex').slice(0, 16);
}

// The actual fix for the "localhost" links bug: derive the base URL from
// the request itself, unless the operator explicitly overrides it.
function baseUrlFromRequest(req) {
  if (PUBLIC_BASE_URL_OVERRIDE) return PUBLIC_BASE_URL_OVERRIDE.replace(/\/$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${nanoid(24)}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

/* ---------------------------------------------------------------------- */
/* Diagnostics — lets the frontend show a clear banner instead of a        */
/* confusing generic error when something's misconfigured.                 */
/* ---------------------------------------------------------------------- */

app.get('/api/config', (req, res) => {
  res.json({
    senderKeyConfigured: !!SENDER_API_KEY,
    pushConfigured: pushEnabled,
    detectedBaseUrl: baseUrlFromRequest(req),
    usingManualOverride: !!PUBLIC_BASE_URL_OVERRIDE,
  });
});

/* ---------------------------------------------------------------------- */
/* Sender endpoints (require SENDER_API_KEY)                               */
/* ---------------------------------------------------------------------- */

app.post('/api/links', requireSender, uploadLimiter, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const expiryMinutes = Number(req.body.expiryMinutes || 5);
  const maxViews = Number(req.body.maxViews || 3);
  const requiresApproval = req.body.requiresApproval === 'true';

  const token = nanoid(22);
  const now = Date.now();
  const expiresAt = now + expiryMinutes * 60 * 1000;

  insertLink({
    token,
    original_name: req.file.originalname,
    stored_name: req.file.filename,
    mime_type: req.file.mimetype,
    size_bytes: req.file.size,
    created_at: now,
    expires_at: expiresAt,
    max_views: maxViews,
    view_count: 0,
    status: 'active',
    requires_approval: requiresApproval ? 1 : 0,
  });
  insertAudit(token, 'sender', 'created', now);

  res.json({
    token,
    url: `${baseUrlFromRequest(req)}/view/${token}`,
    expiresAt,
    maxViews,
  });
});

app.get('/api/links', requireSender, (req, res) => {
  res.json(listLinks().map(sweepExpiry));
});

app.post('/api/links/:token/revoke', requireSender, (req, res) => {
  const link = getLink(req.params.token);
  if (!link) return res.status(404).json({ error: 'Not found' });
  setStatus(link.token, 'revoked');
  insertAudit(link.token, 'sender', 'revoked', Date.now());
  res.json({ ok: true });
});

app.post('/api/links/:token/approve', requireSender, (req, res) => {
  const link = getLink(req.params.token);
  if (!link) return res.status(404).json({ error: 'Not found' });
  setStatus(link.token, 'active');
  insertAudit(link.token, 'sender', 'approved', Date.now());
  res.json({ ok: true });
});

app.post('/api/links/:token/deny', requireSender, (req, res) => {
  const link = getLink(req.params.token);
  if (!link) return res.status(404).json({ error: 'Not found' });
  setStatus(link.token, 'revoked');
  insertAudit(link.token, 'sender', 'denied', Date.now());
  res.json({ ok: true });
});

app.get('/api/audit', requireSender, (req, res) => {
  res.json(listAudit());
});

app.post('/api/push/subscribe', requireSender, (req, res) => {
  if (!pushEnabled) return res.status(400).json({ error: 'Push not configured on server' });
  upsertSub(req.body.endpoint, JSON.stringify(req.body), Date.now());
  res.json({ ok: true });
});

app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY || null });
});

/* ---------------------------------------------------------------------- */
/* Receiver endpoints (public, token-gated)                                */
/* ---------------------------------------------------------------------- */

function sweepExpiry(link) {
  if (!link) return link;
  if (link.status === 'active' && (Date.now() > link.expires_at || (link.max_views > 0 && link.view_count >= link.max_views))) {
    setStatus(link.token, 'expired');
    link.status = 'expired';
  }
  return link;
}

app.get('/api/view/:token/meta', viewLimiter, (req, res) => {
  let link = getLink(req.params.token);
  if (!link) return res.status(404).json({ error: 'Link not found' });
  link = sweepExpiry(link);
  res.json({
    name: link.original_name,
    mimeType: link.mime_type,
    status: link.status,
    viewCount: link.view_count,
    maxViews: link.max_views,
    expiresAt: link.expires_at,
    requiresApproval: !!link.requires_approval,
  });
});

app.post('/api/view/:token/request-access', viewLimiter, async (req, res) => {
  let link = getLink(req.params.token);
  if (!link) return res.status(404).json({ error: 'Link not found' });
  link = sweepExpiry(link);
  if (link.status !== 'pending' && !link.requires_approval) {
    return res.status(400).json({ error: 'This link does not require approval' });
  }
  setStatus(link.token, 'pending');
  const actor = fingerprint(req);
  insertAudit(link.token, actor, 'requested', Date.now());
  await notifySender('DeepSecure Access Request', `A receiver requested access to ${link.original_name}`, { token: link.token });
  res.json({ ok: true, status: 'pending' });
});

app.get('/api/view/:token/file', viewLimiter, (req, res) => {
  let link = getLink(req.params.token);
  if (!link) return res.status(404).json({ error: 'Link not found' });
  link = sweepExpiry(link);

  if (link.status !== 'active') {
    return res.status(410).json({ error: `Link is ${link.status}` });
  }

  const actor = fingerprint(req);
  bumpView(link.token);
  insertAudit(link.token, actor, 'viewed', Date.now());
  sweepExpiry(getLink(link.token));

  const filePath = path.join(UPLOAD_DIR, link.stored_name);
  res.setHeader('Content-Type', link.mime_type);
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(filePath);
});

/* ---------------------------------------------------------------------- */
/* Frontend routes                                                         */
/* ---------------------------------------------------------------------- */

app.get('/view/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`DeepSecure listening on port ${PORT}`);
  if (!SENDER_API_KEY) {
    console.warn('WARNING: SENDER_API_KEY is not set — sender endpoints will refuse all requests until you set it.');
  }
  if (!pushEnabled) {
    console.warn('Push notifications disabled — set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY to enable them.');
  }
});
