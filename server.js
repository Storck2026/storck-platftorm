'use strict';
const express  = require('express');
const session  = require('express-session');
const multer   = require('multer');
const bcrypt   = require('bcryptjs');
const { v4: uuid } = require('uuid');
const fs       = require('fs');
const path     = require('path');
const https      = require('https');
const nodemailer = require('nodemailer');

const app  = express();
const PORT = process.env.PORT || 3000;
const BASE = __dirname;
const DATA = path.join(BASE, 'data');

// ── Ensure directories ────────────────────────────────────────────────────────
fs.mkdirSync(DATA, { recursive: true });
['uploads/plans','uploads/bautagesbuch','uploads/tasks','uploads/documents','uploads/logo'].forEach(d => {
  fs.mkdirSync(path.join(DATA, d), { recursive: true });
});

// ── Auto-initialize database files if missing ─────────────────────────────────
const initDB = {
  users: [
    { id: uuid(), email: 'admin@admin.de',               password: bcrypt.hashSync('admin123', 10),  name: 'Administrator', role: 'admin',    verified: true, active: true },
    { id: uuid(), email: 'b.obradovic@storck-gmbh.de',   password: bcrypt.hashSync('bojan123',  10),  name: 'Bojan Obradovic', role: 'admin',  verified: true, active: true }
  ],
  projects: [], tasks: [], bautagesbuch: [], zeiterfassung: [], kunden: [],
  lieferanten: [], geraete: [], artikel: [], documents: [], plans: [],
  'plan-markers': [], kalender: [], crm: [], disposition: [], chat: [],
  rechnungen: [], rapportzettel: [], fotodokumentation: [], bauuebergabe: [],
  formulare: [], baulohn: [], mitarbeiterskills: [], fristen: [], berichte: [],
  arbeitssicherheit: [], gefaehrdung: [], unterweisung: [], telematik: [],
  'ticket-categories': [
    { id: uuid(), name: 'Mangel',     color: '#e74c3c' },
    { id: uuid(), name: 'Aufgabe',    color: '#3498db' },
    { id: uuid(), name: 'Hinweis',    color: '#f39c12' }
  ],
  'ticket-types': [
    { id: uuid(), name: 'Intern' },
    { id: uuid(), name: 'Extern' }
  ]
};
Object.entries(initDB).forEach(([name, def]) => {
  const file = path.join(DATA, name + '.json');
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(def, null, 2));
    console.log(`✅ Initialisiert: data/${name}.json`);
  }
});
if (!fs.existsSync(path.join(DATA, 'config.json'))) {
  fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({
    companyName: 'STORCK Sicherheitstechnik GmbH',
    companyEmail: 'b.obradovic@storck-gmbh.de',
    companyPhone: '',
    companyAddress: '',
    logoUrl: ''
  }, null, 2));
}

// ── JSON DB helpers ───────────────────────────────────────────────────────────
const dbFile  = name => path.join(DATA, name + '.json');
const readDB  = name => { try { return JSON.parse(fs.readFileSync(dbFile(name),'utf8')); } catch { return []; } };
const cfgFile = path.join(DATA,'config.json');
const readCfg = () => { try { return JSON.parse(fs.readFileSync(cfgFile,'utf8')); } catch { return {}; } };
const writeCfg= cfg => { fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2)); broadcast('config'); };

// ── SSE: real-time push to all connected clients ──────────────────────────────
const sseClients = new Set();
function broadcast(topic) {
  const msg = `data: ${JSON.stringify({ topic, ts: Date.now() })}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch { sseClients.delete(res); }
  }
}
const writeDB = (name, data) => {
  fs.writeFileSync(dbFile(name), JSON.stringify(data, null, 2));
  broadcast(name);
};

// ── Email / SMTP helper ──────────────────────────────────────────────────────
function createTransporter() {
  const cfg = readCfg();
  if (!cfg.smtpHost || !cfg.smtpUser || !cfg.smtpPass) return null;
  return nodemailer.createTransport({
    host:   cfg.smtpHost,
    port:   parseInt(cfg.smtpPort || 587),
    secure: parseInt(cfg.smtpPort) === 465,
    auth:   { user: cfg.smtpUser, pass: cfg.smtpPass },
    tls:    { rejectUnauthorized: false }
  });
}

async function sendMail(to, subject, html) {
  const t = createTransporter();
  if (!t) { console.log('[EMAIL] SMTP not configured – skipping:', subject); return; }
  const cfg = readCfg();
  await t.sendMail({ from: `"${cfg.smtpFromName||'STORCK Baumanagement'}" <${cfg.smtpUser}>`, to, subject, html });
  console.log('[EMAIL] Sent:', subject, '->', to);
}

function inviteEmailHtml(name, email, password, baseUrl) {
  return '<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#f4f4f4;padding:30px">' +
  '<div style="max-width:520px;margin:0 auto;background:#fff;border-radius:10px;padding:30px;box-shadow:0 2px 10px rgba(0,0,0,.1)">' +
  '<div style="text-align:center;margin-bottom:24px"><div style="display:inline-block;width:50px;height:50px;background:linear-gradient(135deg,#c0392b,#e74c3c);border-radius:12px;line-height:50px;text-align:center;font-size:26px;font-weight:900;color:#fff;font-family:Georgia,serif">S</div></div>' +
  '<h2 style="color:#1e1e2e;margin:0 0 8px">Willkommen bei STORCK Baumanagement</h2>' +
  '<p style="color:#555">Hallo <strong>' + name + '</strong>,<br>Ihr Konto wurde erstellt. Sie können sich sofort anmelden.</p>' +
  '<div style="background:#f8f8f8;border-radius:8px;padding:16px;margin:20px 0">' +
  '<p style="margin:0 0 6px;font-size:13px;color:#888">Ihre Zugangsdaten:</p>' +
  '<p style="margin:4px 0"><strong>E-Mail:</strong> ' + email + '</p>' +
  '<p style="margin:4px 0"><strong>Passwort:</strong> <code style="background:#e8e8e8;padding:2px 6px;border-radius:4px">' + password + '</code></p>' +
  '</div>' +
  '<div style="text-align:center;margin:24px 0">' +
  '<a href="' + baseUrl + '" style="display:inline-block;background:linear-gradient(135deg,#c0392b,#e74c3c);color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:15px">🏗 Zur Plattform anmelden</a>' +
  '</div>' +
  '</div></body></html>';
}

function verifyEmailHtml(name, baseUrl, token) {
  return `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#f4f4f4;padding:30px">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:10px;padding:30px;box-shadow:0 2px 10px rgba(0,0,0,.1)">
    <h2 style="color:#1e1e2e">E-Mail-Adresse bestätigen</h2>
    <p style="color:#555">Hallo <strong>${name}</strong>,<br>bitte klicken Sie auf den Button um Ihre E-Mail zu bestätigen:</p>
    <div style="text-align:center;margin:24px 0">
      <a href="${baseUrl}/api/auth/verify/${token}" style="display:inline-block;background:#c0392b;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600">E-Mail bestätigen</a>
    </div>
    <p style="font-size:12px;color:#aaa">Link gültig für 72 Stunden.</p>
  </div></body></html>`;
}

// ── Logo for print reports ────────────────────────────────────────────────────
let LOGO_B64 = '';
const logoPath = path.join(BASE, '..', 'Logo-Storck-Sicherheitstechnik.png');
if (fs.existsSync(logoPath)) LOGO_B64 = fs.readFileSync(logoPath).toString('base64');

// ── Multer storage factory ────────────────────────────────────────────────────
const storage = subdir => multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(DATA, 'uploads', subdir)),
  filename:    (req, file, cb) => cb(null, uuid() + path.extname(file.originalname))
});
const uploadPlan = multer({ storage: storage('plans'), limits: { fileSize: 100*1024*1024 } });
const uploadBTB  = multer({ storage: storage('bautagesbuch'), limits: { fileSize: 50*1024*1024 } });
const uploadTask = multer({ storage: storage('tasks'), limits: { fileSize: 50*1024*1024 } });
const uploadDoc  = multer({ storage: storage('documents'), limits: { fileSize: 100*1024*1024 } });

// Logo upload: always overwrite with fixed filename per extension
const uploadLogo = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(DATA, 'uploads', 'logo')),
    filename:    (req, file, cb) => cb(null, 'company-logo' + path.extname(file.originalname).toLowerCase())
  }),
  limits: { fileSize: 5*1024*1024 },
  fileFilter: (req, file, cb) => cb(null, /\.(png|jpg|jpeg|svg|gif|webp)$/i.test(file.originalname))
});

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: 'storck-secret-2024',
  resave: false, saveUninitialized: false,
  cookie: { maxAge: 8*60*60*1000 }
}));
app.use(express.static(path.join(BASE, 'public')));

// ── Auth middleware ───────────────────────────────────────────────────────────
const auth      = (req, res, next) => req.session.user ? next() : res.status(401).json({ error: 'Nicht angemeldet' });
const adminOnly = (req, res, next) => req.session.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Nur für Admins' });

// ── Helper: get current logo info ────────────────────────────────────────────
function getLogoInfo() {
  const logoDir = path.join(DATA, 'uploads', 'logo');
  try {
    const files = fs.readdirSync(logoDir).filter(f => /\.(png|jpg|jpeg|svg|gif|webp)$/i.test(f));
    if (files.length) return { url: `/api/config/logo/${files[0]}`, filename: files[0] };
  } catch {}
  return null;
}

// ══════════════════════════════════════════════════════════════════════════════
// AUTH
// ══════════════════════════════════════════════════════════════════════════════
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  const users = readDB('users');
  const user  = users.find(u => u.email.toLowerCase() === email.toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password)) return res.status(401).json({ error: 'E-Mail oder Passwort falsch' });
  if (!user.active) return res.status(403).json({ error: 'Konto ist deaktiviert' });
  req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role };
  res.json({ user: req.session.user });
});
app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ ok: true }); });

// Email verification: GET /api/auth/verify/:token  → verifies user + auto-login redirect
app.get('/api/auth/verify/:token', (req, res) => {
  const users = readDB('users');
  const idx   = users.findIndex(u => u.verificationToken === req.params.token);
  if (idx === -1) return res.status(400).send(`<html><body style="font-family:Arial;text-align:center;padding:60px"><h2 style="color:#c0392b">❌ Ungültiger oder abgelaufener Verifizierungslink</h2><p>Bitte wenden Sie sich an Ihren Administrator.</p></body></html>`);
  users[idx].verified = true;
  users[idx].verificationToken = null;
  writeDB('users', users);
  // Auto-login after verify
  req.session.user = { id: users[idx].id, name: users[idx].name, email: users[idx].email, role: users[idx].role };
  res.send(`<!DOCTYPE html><html><head><meta http-equiv="refresh" content="2;url=/"></head><body style="font-family:Arial;text-align:center;padding:60px;background:#f4f4f4">
    <div style="max-width:400px;margin:0 auto;background:#fff;border-radius:12px;padding:36px;box-shadow:0 2px 10px rgba(0,0,0,.1)">
      <div style="font-size:48px;margin-bottom:16px">✅</div>
      <h2 style="color:#27ae60;margin:0 0 8px">E-Mail verifiziert!</h2>
      <p style="color:#555">Sie werden automatisch weitergeleitet…</p>
    </div></body></html>`);
});

// Resend verification email: POST /api/auth/resend-verify
app.post('/api/auth/resend-verify', auth, adminOnly, (req, res) => {
  const { userId } = req.body;
  const users = readDB('users');
  const idx   = users.findIndex(u => u.id === userId);
  if (idx === -1) return res.status(404).json({ error: 'Benutzer nicht gefunden' });
  if (users[idx].verified) return res.status(400).json({ error: 'Bereits verifiziert' });
  const token = uuid();
  users[idx].verificationToken = token;
  writeDB('users', users);
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  sendMail(users[idx].email, 'E-Mail verifizieren – STORCK Baumanagement', verifyEmailHtml(users[idx].name, baseUrl, token))
    .then(() => res.json({ ok: true }))
    .catch(e => res.status(500).json({ error: e.message }));
});
app.get('/api/me', auth, (req, res) => res.json(req.session.user));

// ── SSE endpoint: client subscribes for real-time updates ─────────────────────
app.get('/api/events', auth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
  res.flushHeaders();
  // Send initial connection confirmation
  res.write(`data: ${JSON.stringify({ topic: 'connected', ts: Date.now() })}\n\n`);
  sseClients.add(res);
  // Heartbeat every 25s to keep connection alive through proxies/load balancers
  const hb = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch { clearInterval(hb); sseClients.delete(res); }
  }, 25000);
  req.on('close', () => { clearInterval(hb); sseClients.delete(res); });
});

// ══════════════════════════════════════════════════════════════════════════════
// CONFIG / SETTINGS
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/config', auth, (req, res) => {
  const cfg  = readCfg();
  const logo = getLogoInfo();
  res.json({
    hasApiKey:   !!cfg.claudeApiKey,
    hasSmtp:     !!(cfg.smtpHost && cfg.smtpUser),
    smtpHost:    cfg.smtpHost   || '',
    smtpPort:    cfg.smtpPort   || '587',
    smtpUser:    cfg.smtpUser   || '',
    smtpFromName:cfg.smtpFromName||'STORCK Baumanagement',
    companyName: cfg.companyName  || 'STORCK Sicherheitstechnik GmbH',
    onedrivePath: cfg.onedrivePath || '',
    logoUrl:     logo ? logo.url : null
  });
});
app.post('/api/config', auth, adminOnly, (req, res) => {
  const cfg = readCfg();
  if (req.body.claudeApiKey !== undefined) cfg.claudeApiKey = req.body.claudeApiKey;
  if (req.body.companyName  !== undefined) cfg.companyName  = req.body.companyName;
  if (req.body.onedrivePath !== undefined) cfg.onedrivePath = req.body.onedrivePath;
  // SMTP email settings
  if (req.body.smtpHost     !== undefined) cfg.smtpHost     = req.body.smtpHost;
  if (req.body.smtpPort     !== undefined) cfg.smtpPort     = req.body.smtpPort;
  if (req.body.smtpUser     !== undefined) cfg.smtpUser     = req.body.smtpUser;
  if (req.body.smtpPass     !== undefined) cfg.smtpPass     = req.body.smtpPass;
  if (req.body.smtpFromName !== undefined) cfg.smtpFromName = req.body.smtpFromName;
  writeCfg(cfg);
  res.json({ ok: true, hasApiKey: !!cfg.claudeApiKey, hasSmtp: !!(cfg.smtpHost && cfg.smtpUser) });
});

// ── Test SMTP connection ─────────────────────────────────────────────────────
app.post('/api/config/test-smtp', auth, adminOnly, async (req, res) => {
  try {
    const t = createTransporter();
    if (!t) return res.status(400).json({ error: 'SMTP nicht konfiguriert. Bitte zuerst speichern.' });
    await t.verify();
    res.json({ ok: true, message: 'SMTP-Verbindung erfolgreich ✅' });
  } catch(e) {
    res.status(500).json({ error: 'SMTP-Fehler: ' + e.message });
  }
});

// ── Logo upload ───────────────────────────────────────────────────────────────
app.post('/api/config/logo', auth, adminOnly, uploadLogo.single('logo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Keine Bilddatei' });
  const url = `/api/config/logo/${req.file.filename}`;
  // Update LOGO_B64 for print reports
  try { LOGO_B64 = fs.readFileSync(req.file.path).toString('base64'); } catch {}
  res.json({ ok: true, logoUrl: url });
});
app.get('/api/config/logo/:filename', (req, res) => {
  const fp = path.join(DATA, 'uploads', 'logo', path.basename(req.params.filename));
  if (!fs.existsSync(fp)) return res.status(404).send('Nicht gefunden');
  res.sendFile(fp);
});
app.delete('/api/config/logo', auth, adminOnly, (req, res) => {
  const logoDir = path.join(DATA, 'uploads', 'logo');
  try { fs.readdirSync(logoDir).forEach(f => fs.unlinkSync(path.join(logoDir, f))); } catch {}
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// KI / CLAUDE API
// ══════════════════════════════════════════════════════════════════════════════
app.post('/api/ai/chat', auth, async (req, res) => {
  const cfg    = readCfg();
  const apiKey = cfg.claudeApiKey;
  if (!apiKey) return res.status(400).json({ error: 'Kein API-Schlüssel konfiguriert. Bitte in ⚙️ Einstellungen eintragen.' });

  const { messages, system, context } = req.body;

  const systemPrompt = `Du bist ein professioneller KI-Bau-Assistent für die STORCK Sicherheitstechnik GmbH.
Bauleiter: Bojan Obradovic | Firma: STORCK Sicherheitstechnik GmbH, Konrad-Adenauer-Straße 15, 35440 Linden

Du hilfst bei:
- Bautagesbuch-Einträge verfassen und optimieren
- Mängel und Aufgaben präzise beschreiben
- Fragen zu DIN-Normen, VDE-Vorschriften, VOB, EN-Normen
- Berichte analysieren und zusammenfassen
- Sicherheitstechnik, Brandschutz, Elektrotechnik
- Baustellenmanagement und Best Practices

${context ? 'Aktueller Kontext: ' + context : ''}
${system || ''}

Antworte immer auf Deutsch. Sei präzise, professionell und praxisnah.
Wenn du Normen nennst, gib die Norm-Nummer an (z.B. DIN VDE 0100-410).`;

  try {
    const body = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      system: systemPrompt,
      messages
    });

    const data = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(body)
        }
      };
      const request = https.request(options, r => {
        let buf = '';
        r.on('data', d => buf += d);
        r.on('end', () => { try { resolve(JSON.parse(buf)); } catch(e) { reject(e); } });
      });
      request.on('error', reject);
      request.write(body);
      request.end();
    });

    if (data.error) throw new Error(data.error.message || 'API-Fehler');
    res.json({ text: data.content[0].text });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// USERS
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/users', auth, adminOnly, (req, res) => res.json(readDB('users').map(u => ({ ...u, password: undefined }))));
app.post('/api/users', auth, adminOnly, (req, res) => {
  const { name, email, password, role } = req.body;
  const users = readDB('users');
  if (users.find(u => u.email.toLowerCase() === email.toLowerCase())) return res.status(400).json({ error: 'E-Mail bereits vorhanden' });
  const plainPw = password;
  const user = { id: uuid(), name, email, password: bcrypt.hashSync(password, 10), role: role||'worker', active: true, verified: true, createdAt: new Date().toISOString() };
  users.push(user); writeDB('users', users);
  // Send invitation email with login credentials (no verification required)
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  sendMail(email, 'Einladung: STORCK Baumanagement – Ihre Zugangsdaten', inviteEmailHtml(name, email, plainPw, baseUrl, null)).catch(e => console.error('[EMAIL] Error:', e.message));
  res.json({ ...user, password: undefined, verificationToken: undefined });
});
app.put('/api/users/:id', auth, adminOnly, (req, res) => {
  const users = readDB('users');
  const idx   = users.findIndex(u => u.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Nicht gefunden' });
  const { name, email, role, active, password } = req.body;
  users[idx] = { ...users[idx], name: name||users[idx].name, email: email||users[idx].email, role: role||users[idx].role, active: active!==undefined ? active : users[idx].active };
  if (password) users[idx].password = bcrypt.hashSync(password, 10);
  writeDB('users', users);
  res.json({ ...users[idx], password: undefined });
});
app.delete('/api/users/:id', auth, adminOnly, (req, res) => { writeDB('users', readDB('users').filter(u => u.id !== req.params.id)); res.json({ ok: true }); });

// ══════════════════════════════════════════════════════════════════════════════
// TICKET TYPES & CATEGORIES (configurable by admin)
// ══════════════════════════════════════════════════════════════════════════════
const DEFAULT_TYPES = [
  { id:'tt1', name:'Mangel',       color:'#c0392b' },
  { id:'tt2', name:'Aufgabe',      color:'#e67e22' },
  { id:'tt3', name:'Abnahme',      color:'#27ae60' },
  { id:'tt4', name:'Behinderung',  color:'#8e44ad' },
  { id:'tt5', name:'Nachtrag',     color:'#2980b9' },
  { id:'tt6', name:'Restleistung', color:'#16a085' },
  { id:'tt7', name:'Schaden',      color:'#e74c3c' },
  { id:'tt8', name:'Aktennotiz',   color:'#7f8c8d' },
];
const DEFAULT_CATS = [
  { id:'tc1',  name:'Brandmeldeanlage',    color:'#c0392b' },
  { id:'tc2',  name:'Einbruchmeldeanlage', color:'#2980b9' },
  { id:'tc3',  name:'Videoüberwachung',    color:'#8e44ad' },
  { id:'tc4',  name:'Zutrittskontrolle',   color:'#16a085' },
  { id:'tc5',  name:'SAA / Sprachanlage',  color:'#27ae60' },
  { id:'tc6',  name:'Netzwerk',            color:'#2c3e50' },
  { id:'tc7',  name:'Elektro',             color:'#f39c12' },
  { id:'tc8',  name:'Sicherheitstechnik',  color:'#7f8c8d' },
  { id:'tc9',  name:'Sonstiges',           color:'#95a5a6' },
];

// Seed defaults on first start
function initDefaults(name, defaults) {
  const file = dbFile(name);
  try { JSON.parse(fs.readFileSync(file,'utf8')); } catch { writeDB(name, defaults); }
}
initDefaults('ticket-types', DEFAULT_TYPES);
initDefaults('ticket-categories', DEFAULT_CATS);

app.get('/api/ticket-types', auth, (req, res) => res.json(readDB('ticket-types')));
app.post('/api/ticket-types', auth, adminOnly, (req, res) => {
  const list = readDB('ticket-types');
  const item = { id: uuid(), name: req.body.name||'Neu', color: req.body.color||'#7f8c8d' };
  list.push(item); writeDB('ticket-types', list); res.json(item);
});
app.put('/api/ticket-types/:id', auth, adminOnly, (req, res) => {
  const list = readDB('ticket-types');
  const idx = list.findIndex(t => t.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Nicht gefunden' });
  list[idx] = { ...list[idx], ...req.body }; writeDB('ticket-types', list); res.json(list[idx]);
});
app.delete('/api/ticket-types/:id', auth, adminOnly, (req, res) => {
  writeDB('ticket-types', readDB('ticket-types').filter(t => t.id !== req.params.id)); res.json({ ok: true });
});

app.get('/api/ticket-categories', auth, (req, res) => res.json(readDB('ticket-categories')));
app.post('/api/ticket-categories', auth, adminOnly, (req, res) => {
  const list = readDB('ticket-categories');
  const item = { id: uuid(), name: req.body.name||'Neu', color: req.body.color||'#7f8c8d' };
  list.push(item); writeDB('ticket-categories', list); res.json(item);
});
app.put('/api/ticket-categories/:id', auth, adminOnly, (req, res) => {
  const list = readDB('ticket-categories');
  const idx = list.findIndex(c => c.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Nicht gefunden' });
  list[idx] = { ...list[idx], ...req.body }; writeDB('ticket-categories', list); res.json(list[idx]);
});
app.delete('/api/ticket-categories/:id', auth, adminOnly, (req, res) => {
  writeDB('ticket-categories', readDB('ticket-categories').filter(c => c.id !== req.params.id)); res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// PROJECTS
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/projects', auth, (req, res) => res.json(readDB('projects')));
app.post('/api/projects', auth, (req, res) => {
  const projects = readDB('projects');
  const p = { id: uuid(), ...req.body, createdBy: req.session.user.id, createdAt: new Date().toISOString(), status: req.body.status||'aktiv' };
  projects.push(p); writeDB('projects', projects); res.json(p);
});
app.put('/api/projects/:id', auth, (req, res) => {
  const projects = readDB('projects');
  const idx = projects.findIndex(p => p.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Nicht gefunden' });
  projects[idx] = { ...projects[idx], ...req.body }; writeDB('projects', projects); res.json(projects[idx]);
});
app.delete('/api/projects/:id', auth, adminOnly, (req, res) => { writeDB('projects', readDB('projects').filter(p => p.id !== req.params.id)); res.json({ ok: true }); });

// ══════════════════════════════════════════════════════════════════════════════
// PLANS
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/plans', auth, (req, res) => {
  const plans = readDB('plans');
  if (req.session.user.role === 'admin') return res.json(plans);
  const uid = req.session.user.id;
  res.json(plans.filter(p => !p.restrictedTo?.length || p.restrictedTo.includes(uid)));
});
app.post('/api/plans', auth, uploadPlan.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Keine Datei' });
  const plans = readDB('plans');
  const p = { id: uuid(), projectId: req.body.projectId||null, name: req.body.name||req.file.originalname, originalName: req.file.originalname, filename: req.file.filename, mimetype: req.file.mimetype, size: req.file.size, category: req.body.category||'Allgemein', description: req.body.description||'', restrictedTo: req.body.restrictedTo ? JSON.parse(req.body.restrictedTo) : [], canDownload: req.body.canDownload ? JSON.parse(req.body.canDownload) : [], uploadedBy: req.session.user.id, uploaderName: req.session.user.name, uploadedAt: new Date().toISOString() };
  plans.push(p); writeDB('plans', plans); res.json(p);
});
app.put('/api/plans/:id', auth, adminOnly, (req, res) => {
  const plans = readDB('plans');
  const idx = plans.findIndex(p => p.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Nicht gefunden' });
  plans[idx] = { ...plans[idx], ...req.body }; writeDB('plans', plans); res.json(plans[idx]);
});
app.delete('/api/plans/:id', auth, adminOnly, (req, res) => {
  const plans = readDB('plans');
  const plan  = plans.find(p => p.id === req.params.id);
  if (plan) {
    try { fs.unlinkSync(path.join(DATA,'uploads','plans',plan.filename)); } catch {}
    // Also delete markers for this plan
    writeDB('plan-markers', readDB('plan-markers').filter(m => m.planId !== req.params.id));
  }
  writeDB('plans', plans.filter(p => p.id !== req.params.id)); res.json({ ok: true });
});
app.get('/api/plans/:id/file', auth, (req, res) => {
  const plan = readDB('plans').find(p => p.id === req.params.id);
  if (!plan) return res.status(404).send('Nicht gefunden');
  const uid = req.session.user.id;
  if (req.session.user.role !== 'admin' && plan.restrictedTo?.length && !plan.restrictedTo.includes(uid)) return res.status(403).send('Kein Zugriff');
  const fp = path.join(DATA,'uploads','plans',plan.filename);
  if (!fs.existsSync(fp)) return res.status(404).send('Datei nicht gefunden');
  if (req.query.download === '1') {
    if (req.session.user.role !== 'admin' && plan.canDownload?.length && !plan.canDownload.includes(uid)) return res.status(403).send('Download nicht erlaubt');
    res.download(fp, plan.originalName);
  } else {
    res.setHeader('Content-Type', plan.mimetype||'application/octet-stream');
    res.setHeader('Content-Disposition', 'inline; filename="'+plan.originalName+'"');
    res.sendFile(fp);
  }
});

// ── Plan Markers (Markierungen/Pins auf Plänen) ───────────────────────────────
app.get('/api/plans/:id/markers', auth, (req, res) => {
  const markers = readDB('plan-markers');
  res.json(markers.filter(m => m.planId === req.params.id));
});
app.post('/api/plans/:id/markers', auth, (req, res) => {
  const markers = readDB('plan-markers');
  const existing = markers.filter(m => m.planId === req.params.id);
  const num = existing.length ? Math.max(...existing.map(m => m.num||0)) + 1 : 1;
  const m = {
    id: uuid(),
    planId: req.params.id,
    num,
    x: req.body.x,
    y: req.body.y,
    title: req.body.title || 'Markierung ' + num,
    description: req.body.description || '',
    type: req.body.type || 'info',   // info | mangel | aufgabe | erledigt
    createdBy: req.session.user.id,
    createdByName: req.session.user.name,
    createdAt: new Date().toISOString()
  };
  markers.push(m); writeDB('plan-markers', markers); res.json(m);
});
app.put('/api/plans/:planId/markers/:id', auth, (req, res) => {
  const markers = readDB('plan-markers');
  const idx = markers.findIndex(m => m.id === req.params.id && m.planId === req.params.planId);
  if (idx < 0) return res.status(404).json({ error: 'Nicht gefunden' });
  markers[idx] = { ...markers[idx], ...req.body, updatedAt: new Date().toISOString() };
  writeDB('plan-markers', markers); res.json(markers[idx]);
});
app.delete('/api/plans/:planId/markers/:id', auth, (req, res) => {
  writeDB('plan-markers', readDB('plan-markers').filter(m => !(m.id === req.params.id && m.planId === req.params.planId)));
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// BAUTAGESBUCH
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/bautagesbuch', auth, (req, res) => {
  const list = readDB('bautagesbuch');
  res.json(req.session.user.role === 'admin' ? list : list.filter(b => b.createdBy === req.session.user.id));
});
app.post('/api/bautagesbuch', auth, uploadBTB.array('photos', 20), (req, res) => {
  const list   = readDB('bautagesbuch');
  const photos = (req.files||[]).map(f => ({ filename: f.filename, originalName: f.originalname }));
  const data   = JSON.parse(req.body.data||'{}');
  const entry  = { id: uuid(), ...data, photos: [...(data.photos||[]), ...photos], createdBy: req.session.user.id, createdByName: req.session.user.name, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  list.push(entry); writeDB('bautagesbuch', list); res.json(entry);
});
app.put('/api/bautagesbuch/:id', auth, (req, res) => {
  const list = readDB('bautagesbuch');
  const idx  = list.findIndex(b => b.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Nicht gefunden' });
  if (req.session.user.role !== 'admin' && list[idx].createdBy !== req.session.user.id) return res.status(403).json({ error: 'Kein Zugriff' });
  list[idx] = { ...list[idx], ...req.body, updatedAt: new Date().toISOString() }; writeDB('bautagesbuch', list); res.json(list[idx]);
});
app.delete('/api/bautagesbuch/:id', auth, (req, res) => {
  const list  = readDB('bautagesbuch');
  const entry = list.find(b => b.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'Nicht gefunden' });
  if (req.session.user.role !== 'admin' && entry.createdBy !== req.session.user.id) return res.status(403).json({ error: 'Kein Zugriff' });
  (entry.photos||[]).forEach(p => { try { fs.unlinkSync(path.join(DATA,'uploads','bautagesbuch',p.filename)); } catch {} });
  writeDB('bautagesbuch', list.filter(b => b.id !== req.params.id)); res.json({ ok: true });
});
app.get('/api/bautagesbuch/:id/photo/:filename', auth, (req, res) => {
  const fp = path.join(DATA,'uploads','bautagesbuch', path.basename(req.params.filename));
  if (!fs.existsSync(fp)) return res.status(404).send('Nicht gefunden');
  res.sendFile(fp);
});

// ── Bautagesbuch Print Report ─────────────────────────────────────────────────
app.get('/api/bautagesbuch/:id/print', auth, (req, res) => {
  const entry = readDB('bautagesbuch').find(b => b.id === req.params.id);
  if (!entry) return res.status(404).send('Nicht gefunden');

  const fmtD = iso => iso ? new Date(iso).toLocaleDateString('de-DE',{day:'2-digit',month:'2-digit',year:'numeric'}) : '–';
  const esc  = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  // Logo
  let logoSrc = '';
  const li = getLogoInfo();
  if (li) { try { logoSrc = `data:image/png;base64,${fs.readFileSync(path.join(DATA,'uploads','logo',li.filename)).toString('base64')}`; } catch {} }
  else if (LOGO_B64) { logoSrc = `data:image/png;base64,${LOGO_B64}`; }

  // Helper: render a section table with header row + data rows
  const sectionTable = (headers, rows) => {
    if (!rows || !rows.length) return '<div class="notes-box" style="min-height:28px;color:#aaa;font-size:9pt">–</div>';
    return `<table class="grid"><thead><tr>${headers.map(h=>`<td class="label" style="text-align:center">${esc(h)}</td>`).join('')}</tr></thead><tbody>
      ${rows.map(r=>`<tr>${r.map(v=>`<td class="value">${esc(v||'–')}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  };

  // Personal
  const personalHTML = sectionTable(
    ['Name / Firma','Gewerk / Funktion','Anzahl'],
    (entry.workers||[]).map(w=>[w.name,w.gewerk||'–',String(w.count||1)])
  );

  // Nachunternehmer
  const nuHTML = entry.nachunternehmer?.length ? sectionTable(
    ['Firma / Nachunternehmer','Leistung','Pers.'],
    entry.nachunternehmer.map(r=>[r['btb-nufirma'],r['btb-nuleist'],r['btb-nucnt']])
  ) : '';

  // Maschinen
  const maschHTML = entry.maschinen?.length ? sectionTable(
    ['Maschine / Gerät','Firma / Eigentümer','Stunden'],
    entry.maschinen.map(r=>[r['btb-masch'],r['btb-maschfirma'],r['btb-maschhrs']])
  ) : '';

  // Material
  const matHTML = entry.material?.length ? sectionTable(
    ['Material / Lieferant','Menge / Einheit','Uhrzeit'],
    entry.material.map(r=>[r['btb-mat'],r['btb-matmenge'],r['btb-matzeit']])
  ) : '';

  // Besucher
  const besHTML = entry.besucher?.length ? sectionTable(
    ['Name','Firma / Funktion','Uhrzeit'],
    entry.besucher.map(r=>[r['btb-besname'],r['btb-besfirma'],r['btb-beszeit']])
  ) : '';

  // Photos
  let photoHTML = '';
  if (entry.photos?.length) {
    const photoItems = entry.photos.map(p => {
      const fp = path.join(DATA,'uploads','bautagesbuch',p.filename);
      if (!fs.existsSync(fp)) return '';
      const b64 = fs.readFileSync(fp).toString('base64');
      const ext = path.extname(p.filename).slice(1).replace('jpg','jpeg');
      return `<div class="photo-item"><img src="data:image/${ext};base64,${b64}" alt="${esc(p.originalName||'')}"><div class="photo-caption">${esc(p.originalName||'')}</div></div>`;
    }).filter(Boolean).join('');
    if (photoItems) photoHTML = `<div class="section-title">📷 Fotos / Dokumentation</div><div class="photo-grid">${photoItems}</div>`;
  }

  const html = `<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8">
<title>Bautagesbuch – ${fmtD(entry.date)}</title>
<style>
  @page { size: A4; margin: 16mm 14mm 18mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 9.5pt; color: #222; }
  .doc-header { display: flex; justify-content: space-between; align-items: flex-end; padding-bottom: 10px; border-bottom: 3px solid #c0392b; margin-bottom: 14px; }
  .doc-header img { height: 44px; max-width: 180px; object-fit: contain; }
  .doc-header-right { text-align: right; }
  .doc-header-right .title { font-size: 22pt; font-weight: 900; color: #c0392b; letter-spacing: 2px; line-height: 1; }
  .doc-header-right .subtitle { font-size: 9pt; color: #888; margin-top: 3px; letter-spacing: .5px; }
  .meta-bar { display: flex; gap: 0; background: #f7f7f7; border: 1px solid #e0e0e0; border-radius: 4px; margin-bottom: 14px; overflow: hidden; }
  .meta-bar .mi { display: flex; flex-direction: column; gap: 2px; padding: 7px 12px; flex: 1; border-right: 1px solid #e0e0e0; }
  .meta-bar .mi:last-child { border-right: none; }
  .meta-bar .ml { color: #999; font-size: 7.5pt; text-transform: uppercase; letter-spacing: .4px; }
  .meta-bar .mv { font-weight: 700; color: #222; font-size: 9.5pt; }
  .section-title { background: #c0392b; color: #fff; font-weight: 700; font-size: 9pt; padding: 5px 10px; margin: 12px 0 0; letter-spacing: .5px; border-radius: 2px; }
  table.grid { width: 100%; border-collapse: collapse; }
  table.grid td { border: 1px solid #ddd; padding: 5px 9px; font-size: 9pt; vertical-align: top; }
  table.grid thead td.label { background: #f0f0f0; font-weight: 700; color: #555; font-size: 8.5pt; text-align: center; }
  table.grid td.label { background: #f5f5f5; font-weight: 700; color: #555; width: 130px; white-space: nowrap; }
  table.grid td.value { background: #fff; }
  .notes-box { border: 1px solid #ddd; min-height: 55px; padding: 7px 10px; font-size: 9pt; white-space: pre-wrap; background: #fff; }
  .weather-badge { display: inline-block; background: #eaf2ff; color: #2980b9; border-radius: 12px; padding: 2px 8px; font-size: 8.5pt; margin: 1px 2px; }
  .photo-grid { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
  .photo-item { width: 125px; }
  .photo-item img { width: 125px; height: 88px; object-fit: cover; border: 1px solid #ddd; border-radius: 3px; display: block; }
  .photo-caption { font-size: 7pt; color: #888; text-align: center; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sig-row { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; margin-top: 8px; }
  .sig-box { border: 1px solid #ccc; border-radius: 4px; padding: 10px 12px; }
  .sig-line { border-bottom: 1.5px solid #666; margin: 36px 0 6px; }
  .sig-label { font-size: 8pt; color: #888; text-align: center; font-style: italic; }
  .doc-footer { margin-top: 18px; padding-top: 7px; border-top: 2px solid #c0392b; font-size: 7.5pt; color: #888; line-height: 1.6; }
  .doc-footer strong { color: #555; }
  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 0; }
  .two-col > div { margin-top: 0; }
  @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } #printBar { display: none !important; } }
</style>
</head><body>

<div id="printBar" style="position:fixed;bottom:20px;right:20px;display:flex;flex-direction:column;gap:6px;z-index:999;align-items:flex-end">
  <div style="background:rgba(0,0,0,.7);color:#fff;font-size:11px;padding:6px 12px;border-radius:6px;max-width:260px;line-height:1.4">
    💡 Im Druckdialog <strong>„Kopf- und Fußzeilen"</strong> deaktivieren &amp; Hintergrundgrafiken aktivieren.
  </div>
  <div style="display:flex;gap:8px">
    <button onclick="window.print()" style="background:#c0392b;color:#fff;border:none;padding:10px 20px;border-radius:6px;cursor:pointer;font-size:14px;font-weight:700;box-shadow:0 3px 14px rgba(0,0,0,.3)">🖨 Drucken / Als PDF speichern</button>
    <button onclick="window.close()" style="background:#555;color:#fff;border:none;padding:10px 14px;border-radius:6px;cursor:pointer;font-size:14px;box-shadow:0 3px 10px rgba(0,0,0,.2)">✕</button>
  </div>
</div>
<script>window.onbeforeprint=function(){document.getElementById('printBar').style.display='none'};window.onafterprint=function(){document.getElementById('printBar').style.display='flex'};</script>

<!-- HEADER -->
<div class="doc-header">
  ${logoSrc ? `<img src="${logoSrc}" alt="STORCK Logo">` : '<div></div>'}
  <div class="doc-header-right">
    <div class="title">BAUTAGESBUCH</div>
    <div class="subtitle">Baubericht / Tagesprotokoll</div>
  </div>
</div>

<!-- META BAR -->
<div class="meta-bar">
  <div class="mi"><div class="ml">Datum</div><div class="mv">${fmtD(entry.date)}</div></div>
  <div class="mi"><div class="ml">Bericht-Nr.</div><div class="mv">${esc(entry.reportNo||'–')}</div></div>
  <div class="mi"><div class="ml">Projekt</div><div class="mv">${esc(entry.projectName||'–')}</div></div>
  <div class="mi"><div class="ml">Bauleiter</div><div class="mv">${esc(entry.createdByName||'–')}</div></div>
  <div class="mi"><div class="ml">Arbeitsbeginn</div><div class="mv">${esc(entry.start||'–')}</div></div>
  <div class="mi"><div class="ml">Arbeitsende</div><div class="mv">${esc(entry.end||'–')}</div></div>
</div>

<!-- PROJEKTINFORMATIONEN -->
<div class="section-title">Projektinformationen</div>
<table class="grid">
  <tr>
    <td class="label">Auftraggeber</td><td class="value">${esc(entry.client||'–')}</td>
    <td class="label">Auftragsnummer</td><td class="value">${esc(entry.orderNo||'–')}</td>
  </tr>
</table>

<!-- WITTERUNG -->
<div class="section-title">Witterungsbedingungen</div>
<table class="grid">
  <tr>
    <td class="label">Wetter</td>
    <td class="value" colspan="3">${(entry.weather||[]).map(w=>`<span class="weather-badge">${esc(w)}</span>`).join('')||'–'}</td>
  </tr>
  <tr>
    <td class="label">Temperatur</td><td class="value">${entry.temperature ? esc(entry.temperature)+'°C' : '–'}</td>
    <td class="label">Niederschlag</td><td class="value">${esc(entry.precipitation||'–')}</td>
  </tr>
  <tr>
    <td class="label">Windstärke</td><td class="value" colspan="3">${esc(entry.wind||'–')}</td>
  </tr>
</table>

<!-- PERSONAL -->
<div class="section-title">Personal vor Ort</div>
${personalHTML}

${entry.nachunternehmer?.length ? `<div class="section-title">Nachunternehmer</div>${nuHTML}` : ''}

${entry.maschinen?.length ? `<div class="section-title">Maschinen &amp; Geräte</div>${maschHTML}` : ''}

${entry.material?.length ? `<div class="section-title">Materiallieferungen</div>${matHTML}` : ''}

${entry.besucher?.length ? `<div class="section-title">Besucherliste</div>${besHTML}` : ''}

<!-- TÄTIGKEITEN -->
<div class="section-title">Tätigkeiten &amp; Leistungen</div>
<div class="notes-box" style="min-height:70px">${esc(entry.activities||'–')}</div>

${entry.soll ? `<div class="section-title">Soll-Leistung (geplant)</div><div class="notes-box">${esc(entry.soll)}</div>` : ''}

<!-- BEHINDERUNGEN -->
<div class="section-title">Behinderungen &amp; Besonderheiten</div>
<div class="notes-box" style="min-height:55px">${esc(entry.notes||'–')}</div>

${entry.safety ? `<div class="section-title">Sicherheitsrelevante Vorfälle</div><div class="notes-box">${esc(entry.safety)}</div>` : ''}

${photoHTML}

<!-- UNTERSCHRIFTEN -->
<div class="section-title">Unterschriften</div>
<div class="sig-row">
  <div class="sig-box">
    <div class="sig-line"></div>
    <div class="sig-label">Bauleiter – ${esc(entry.createdByName||'Administrator')}</div>
  </div>
  <div class="sig-box">
    <div class="sig-line"></div>
    <div class="sig-label">Auftraggeber / Bauherr${entry.client ? ' – '+esc(entry.client) : ''}</div>
  </div>
</div>

<!-- FOOTER -->
<div class="doc-footer">
  <strong>STORCK Sicherheitstechnik GmbH</strong> &nbsp;|&nbsp; Konrad-Adenauer-Straße 15, 35440 Linden &nbsp;|&nbsp;
  Tel.: +49 (641) 76097-0 &nbsp;|&nbsp; b.obradovic@storck-gmbh.de &nbsp;|&nbsp; www.storck-gmbh.de &nbsp;|&nbsp;
  Geschäftsführer: Stefan Werner &nbsp;|&nbsp; Amtsgericht Gießen / HRB 2462
</div>

</body></html>`;

  res.setHeader('Content-Type','text/html; charset=utf-8');
  res.send(html);
});

// ══════════════════════════════════════════════════════════════════════════════
// TASKS
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/tasks', auth, (req, res) => {
  const tasks = readDB('tasks');
  if (req.session.user.role === 'admin') return res.json(tasks);
  const uid = req.session.user.id;
  res.json(tasks.filter(t => t.createdBy === uid || t.assignedTo === uid));
});
app.post('/api/tasks', auth, uploadTask.array('photos', 10), (req, res) => {
  const list   = readDB('tasks');
  const photos = (req.files||[]).map(f => ({ filename: f.filename, originalName: f.originalname }));
  const data   = JSON.parse(req.body.data||'{}');
  // Auto-assign sequential ticket number
  const maxNum = list.reduce((m, t) => Math.max(m, t.ticketNo||0), 0);
  const task   = { id: uuid(), ticketNo: maxNum + 1, ...data, photos, status: data.status||'offen', createdBy: req.session.user.id, createdByName: req.session.user.name, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  list.push(task); writeDB('tasks', list); res.json(task);
});
app.put('/api/tasks/:id', auth, (req, res) => {
  const list = readDB('tasks');
  const idx  = list.findIndex(t => t.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Nicht gefunden' });
  list[idx] = { ...list[idx], ...req.body, updatedAt: new Date().toISOString() }; writeDB('tasks', list); res.json(list[idx]);
});
app.delete('/api/tasks/:id', auth, adminOnly, (req, res) => { writeDB('tasks', readDB('tasks').filter(t => t.id !== req.params.id)); res.json({ ok: true }); });
// Tasks for a specific plan (by planId field)
app.get('/api/plans/:id/tasks', auth, (req, res) => {
  const tasks = readDB('tasks');
  res.json(tasks.filter(t => t.planId === req.params.id));
});
app.get('/api/tasks/:id/photo/:filename', auth, (req, res) => {
  const fp = path.join(DATA,'uploads','tasks', path.basename(req.params.filename));
  if (!fs.existsSync(fp)) return res.status(404).send('Nicht gefunden');
  res.sendFile(fp);
});

// ══════════════════════════════════════════════════════════════════════════════
// DOCUMENTS
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/documents', auth, (req, res) => res.json(readDB('documents')));
app.post('/api/documents', auth, uploadDoc.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Keine Datei' });
  const docs = readDB('documents');
  const d = { id: uuid(), name: req.body.name||req.file.originalname, originalName: req.file.originalname, filename: req.file.filename, mimetype: req.file.mimetype, size: req.file.size, category: req.body.category||'Normen', description: req.body.description||'', uploadedBy: req.session.user.id, uploaderName: req.session.user.name, uploadedAt: new Date().toISOString() };
  docs.push(d); writeDB('documents', docs); res.json(d);
});
app.delete('/api/documents/:id', auth, adminOnly, (req, res) => {
  const docs = readDB('documents');
  const doc  = docs.find(d => d.id === req.params.id);
  if (doc) try { fs.unlinkSync(path.join(DATA,'uploads','documents',doc.filename)); } catch {}
  writeDB('documents', docs.filter(d => d.id !== req.params.id)); res.json({ ok: true });
});
app.get('/api/documents/:id/file', auth, (req, res) => {
  const doc = readDB('documents').find(d => d.id === req.params.id);
  if (!doc) return res.status(404).send('Nicht gefunden');
  const fp = path.join(DATA,'uploads','documents', doc.filename);
  if (!fs.existsSync(fp)) return res.status(404).send('Datei nicht gefunden');
  if (req.query.download === '1') res.download(fp, doc.originalName);
  else { res.setHeader('Content-Type', doc.mimetype||'application/octet-stream'); res.setHeader('Content-Disposition','inline; filename="'+doc.originalName+'"'); res.sendFile(fp); }
});

// ══════════════════════════════════════════════════════════════════════════════
// STATS
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/stats', auth, (req, res) => {
  const uid = req.session.user.id;
  const isAdmin = req.session.user.role === 'admin';
  const tasks = readDB('tasks');
  const btb   = readDB('bautagesbuch');
  res.json({
    projects:    readDB('projects').length,
    plans:       readDB('plans').length,
    documents:   readDB('documents').length,
    users:       isAdmin ? readDB('users').length : undefined,
    bautagesbuch: isAdmin ? btb.length : btb.filter(b=>b.createdBy===uid).length,
    tasksOffen:  (isAdmin ? tasks : tasks.filter(t=>t.createdBy===uid||t.assignedTo===uid)).filter(t=>t.status==='offen').length,
    tasksGesamt: (isAdmin ? tasks : tasks.filter(t=>t.createdBy===uid||t.assignedTo===uid)).length,
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// ZEITERFASSUNG
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/zeiterfassung', auth, (req, res) => {
  const all = readDB('zeiterfassung');
  const isAdmin = req.session.user.role === 'admin';
  res.json(isAdmin ? all : all.filter(e => e.userId === req.session.user.id));
});
app.post('/api/zeiterfassung', auth, (req, res) => {
  const entries = readDB('zeiterfassung');
  const e = {
    id: uuid(), userId: req.session.user.id, userName: req.session.user.name,
    projectId: req.body.projectId || '', projectName: req.body.projectName || '',
    date: req.body.date || new Date().toISOString().slice(0,10),
    startTime: req.body.startTime || '', endTime: req.body.endTime || '',
    pause: req.body.pause || 0, // minutes
    beschreibung: req.body.beschreibung || '',
    status: req.body.status || 'offen', // offen | genehmigt | abgelehnt
    createdAt: new Date().toISOString()
  };
  // Calculate duration
  if (e.startTime && e.endTime) {
    const [sh,sm] = e.startTime.split(':').map(Number);
    const [eh,em] = e.endTime.split(':').map(Number);
    e.dauer = Math.max(0, (eh*60+em) - (sh*60+sm) - Number(e.pause));
  }
  entries.push(e); writeDB('zeiterfassung', entries); res.json(e);
});
app.put('/api/zeiterfassung/:id', auth, (req, res) => {
  const entries = readDB('zeiterfassung');
  const idx = entries.findIndex(e => e.id === req.params.id);
  if (idx < 0) return res.status(404).json({error:'Nicht gefunden'});
  const updated = { ...entries[idx], ...req.body, updatedAt: new Date().toISOString() };
  if (updated.startTime && updated.endTime) {
    const [sh,sm] = updated.startTime.split(':').map(Number);
    const [eh,em] = updated.endTime.split(':').map(Number);
    updated.dauer = Math.max(0, (eh*60+em) - (sh*60+sm) - Number(updated.pause||0));
  }
  entries[idx] = updated; writeDB('zeiterfassung', entries); res.json(updated);
});
app.delete('/api/zeiterfassung/:id', auth, (req, res) => {
  writeDB('zeiterfassung', readDB('zeiterfassung').filter(e => e.id !== req.params.id));
  res.json({ok:true});
});

// ══════════════════════════════════════════════════════════════════════════════
// GERÄTEWARTUNG
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/geraete', auth, (req, res) => res.json(readDB('geraete')));
app.post('/api/geraete', auth, (req, res) => {
  const list = readDB('geraete');
  const g = {
    id: uuid(), name: req.body.name || 'Gerät',
    typ: req.body.typ || '', seriennummer: req.body.seriennummer || '',
    standort: req.body.standort || '', projectId: req.body.projectId || '',
    kaufdatum: req.body.kaufdatum || '', letzteWartung: req.body.letzteWartung || '',
    naechsteWartung: req.body.naechsteWartung || '',
    wartungsintervall: req.body.wartungsintervall || 12, // months
    status: req.body.status || 'aktiv', // aktiv | defekt | ausgemustert
    notizen: req.body.notizen || '',
    createdBy: req.session.user.id, createdAt: new Date().toISOString()
  };
  list.push(g); writeDB('geraete', list); res.json(g);
});
app.put('/api/geraete/:id', auth, (req, res) => {
  const list = readDB('geraete');
  const idx = list.findIndex(g => g.id === req.params.id);
  if (idx < 0) return res.status(404).json({error:'Nicht gefunden'});
  list[idx] = { ...list[idx], ...req.body, updatedAt: new Date().toISOString() };
  writeDB('geraete', list); res.json(list[idx]);
});
app.delete('/api/geraete/:id', auth, (req, res) => {
  writeDB('geraete', readDB('geraete').filter(g => g.id !== req.params.id));
  res.json({ok:true});
});

// ══════════════════════════════════════════════════════════════════════════════
// DISPOSITION (Personaleinsatzplanung)
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/disposition', auth, (req, res) => res.json(readDB('disposition')));
app.post('/api/disposition', auth, (req, res) => {
  const list = readDB('disposition');
  const d = {
    id: uuid(), userId: req.body.userId || '', userName: req.body.userName || '',
    projectId: req.body.projectId || '', projectName: req.body.projectName || '',
    date: req.body.date || '', endDate: req.body.endDate || req.body.date || '',
    startTime: req.body.startTime || '07:00', endTime: req.body.endTime || '16:00',
    aufgabe: req.body.aufgabe || '', notiz: req.body.notiz || '',
    farbe: req.body.farbe || '#2980b9',
    createdBy: req.session.user.id, createdAt: new Date().toISOString()
  };
  list.push(d); writeDB('disposition', list); res.json(d);
});
app.put('/api/disposition/:id', auth, (req, res) => {
  const list = readDB('disposition');
  const idx = list.findIndex(d => d.id === req.params.id);
  if (idx < 0) return res.status(404).json({error:'Nicht gefunden'});
  list[idx] = { ...list[idx], ...req.body, updatedAt: new Date().toISOString() };
  writeDB('disposition', list); res.json(list[idx]);
});
app.delete('/api/disposition/:id', auth, (req, res) => {
  writeDB('disposition', readDB('disposition').filter(d => d.id !== req.params.id));
  res.json({ok:true});
});

// ══════════════════════════════════════════════════════════════════════════════
// BAUSTELLENCHAT (Project Messages)
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/chat/:projectId', auth, (req, res) => {
  const msgs = readDB('chat').filter(m => m.projectId === req.params.projectId);
  res.json(msgs.slice(-200)); // last 200 messages
});
app.post('/api/chat/:projectId', auth, (req, res) => {
  const msgs = readDB('chat');
  const m = {
    id: uuid(), projectId: req.params.projectId,
    userId: req.session.user.id, userName: req.session.user.name,
    text: req.body.text || '', createdAt: new Date().toISOString()
  };
  msgs.push(m); writeDB('chat', msgs); res.json(m);
});
app.delete('/api/chat/:projectId/:id', auth, (req, res) => {
  const isAdmin = req.session.user.role === 'admin';
  const msgs = readDB('chat');
  const msg = msgs.find(m => m.id === req.params.id);
  if (!msg) return res.status(404).json({error:'Nicht gefunden'});
  if (msg.userId !== req.session.user.id && !isAdmin) return res.status(403).json({error:'Keine Berechtigung'});
  writeDB('chat', msgs.filter(m => m.id !== req.params.id));
  res.json({ok:true});
});

// ═══════════════════════════════════════════════════════════════
// STAMMDATEN – Kunden & Lieferanten
// ═══════════════════════════════════════════════════════════════
app.get('/api/kunden', auth, (req, res) => res.json(readDB('kunden')));
app.post('/api/kunden', auth, (req, res) => {
  const list = readDB('kunden');
  const item = { id: uuid(), ...req.body, erstellt: new Date().toISOString() };
  writeDB('kunden', [...list, item]); res.json(item);
});
app.put('/api/kunden/:id', auth, (req, res) => {
  const list = readDB('kunden').map(x => x.id === req.params.id ? { ...x, ...req.body } : x);
  writeDB('kunden', list); res.json({ ok: true });
});
app.delete('/api/kunden/:id', auth, (req, res) => { writeDB('kunden', readDB('kunden').filter(x => x.id !== req.params.id)); res.json({ ok: true }); });

app.get('/api/lieferanten', auth, (req, res) => res.json(readDB('lieferanten')));
app.post('/api/lieferanten', auth, (req, res) => {
  const list = readDB('lieferanten');
  const item = { id: uuid(), ...req.body, erstellt: new Date().toISOString() };
  writeDB('lieferanten', [...list, item]); res.json(item);
});
app.put('/api/lieferanten/:id', auth, (req, res) => {
  const list = readDB('lieferanten').map(x => x.id === req.params.id ? { ...x, ...req.body } : x);
  writeDB('lieferanten', list); res.json({ ok: true });
});
app.delete('/api/lieferanten/:id', auth, (req, res) => { writeDB('lieferanten', readDB('lieferanten').filter(x => x.id !== req.params.id)); res.json({ ok: true }); });

// ═══════════════════════════════════════════════════════════════
// AUFTRAGSBEARBEITUNG – Angebot, Auftrag, Rechnung
// ═══════════════════════════════════════════════════════════════
app.get('/api/auftraege', auth, (req, res) => res.json(readDB('auftraege')));
app.post('/api/auftraege', auth, (req, res) => {
  const list = readDB('auftraege');
  const typ = req.body.typ || 'angebot';
  const prefix = {angebot:'AN',auftrag:'AU',rechnung:'RE',gutschrift:'GS'}[typ] || 'DO';
  const num = String(list.filter(x=>x.typ===typ).length+1).padStart(4,'0');
  const item = { id: uuid(), nummer: prefix+'-'+new Date().getFullYear()+'-'+num, ...req.body, datum: req.body.datum||new Date().toISOString().slice(0,10), status: req.body.status||'offen', erstellt: new Date().toISOString() };
  writeDB('auftraege', [...list, item]); res.json(item);
});
app.put('/api/auftraege/:id', auth, (req, res) => {
  const list = readDB('auftraege').map(x => x.id === req.params.id ? { ...x, ...req.body } : x);
  writeDB('auftraege', list); res.json({ ok: true });
});
app.delete('/api/auftraege/:id', auth, (req, res) => { writeDB('auftraege', readDB('auftraege').filter(x => x.id !== req.params.id)); res.json({ ok: true }); });

// ═══════════════════════════════════════════════════════════════
// AUFMASS
// ═══════════════════════════════════════════════════════════════
app.get('/api/aufmass', auth, (req, res) => res.json(readDB('aufmass')));
app.post('/api/aufmass', auth, (req, res) => {
  const list = readDB('aufmass');
  const item = { id: uuid(), ...req.body, datum: req.body.datum||new Date().toISOString().slice(0,10), erstellt: new Date().toISOString() };
  writeDB('aufmass', [...list, item]); res.json(item);
});
app.put('/api/aufmass/:id', auth, (req, res) => {
  const list = readDB('aufmass').map(x => x.id === req.params.id ? { ...x, ...req.body } : x);
  writeDB('aufmass', list); res.json({ ok: true });
});
app.delete('/api/aufmass/:id', auth, (req, res) => { writeDB('aufmass', readDB('aufmass').filter(x => x.id !== req.params.id)); res.json({ ok: true }); });

// ═══════════════════════════════════════════════════════════════
// ARTIKEL & LEISTUNGSKATALOG
// ═══════════════════════════════════════════════════════════════
app.get('/api/artikel', auth, (req, res) => res.json(readDB('artikel')));
app.post('/api/artikel', auth, (req, res) => {
  const list = readDB('artikel');
  const item = { id: uuid(), ...req.body, erstellt: new Date().toISOString() };
  writeDB('artikel', [...list, item]); res.json(item);
});
app.put('/api/artikel/:id', auth, (req, res) => {
  const list = readDB('artikel').map(x => x.id === req.params.id ? { ...x, ...req.body } : x);
  writeDB('artikel', list); res.json({ ok: true });
});
app.delete('/api/artikel/:id', auth, (req, res) => { writeDB('artikel', readDB('artikel').filter(x => x.id !== req.params.id)); res.json({ ok: true }); });

// ═══════════════════════════════════════════════════════════════
// EINKAUF – Bestellungen
// ═══════════════════════════════════════════════════════════════
app.get('/api/bestellungen', auth, (req, res) => res.json(readDB('bestellungen')));
app.post('/api/bestellungen', auth, (req, res) => {
  const list = readDB('bestellungen');
  const num = String(list.length+1).padStart(4,'0');
  const item = { id: uuid(), bestellnummer: 'BE-'+new Date().getFullYear()+'-'+num, ...req.body, datum: req.body.datum||new Date().toISOString().slice(0,10), status: req.body.status||'offen', erstellt: new Date().toISOString() };
  writeDB('bestellungen', [...list, item]); res.json(item);
});
app.put('/api/bestellungen/:id', auth, (req, res) => {
  const list = readDB('bestellungen').map(x => x.id === req.params.id ? { ...x, ...req.body } : x);
  writeDB('bestellungen', list); res.json({ ok: true });
});
app.delete('/api/bestellungen/:id', auth, (req, res) => { writeDB('bestellungen', readDB('bestellungen').filter(x => x.id !== req.params.id)); res.json({ ok: true }); });

// ═══════════════════════════════════════════════════════════════
// LAGER
// ═══════════════════════════════════════════════════════════════
app.get('/api/lager', auth, (req, res) => res.json(readDB('lager')));
app.post('/api/lager', auth, (req, res) => {
  const list = readDB('lager');
  const item = { id: uuid(), ...req.body, erstellt: new Date().toISOString() };
  writeDB('lager', [...list, item]); res.json(item);
});
app.put('/api/lager/:id', auth, (req, res) => {
  const list = readDB('lager').map(x => x.id === req.params.id ? { ...x, ...req.body } : x);
  writeDB('lager', list); res.json({ ok: true });
});
app.delete('/api/lager/:id', auth, (req, res) => { writeDB('lager', readDB('lager').filter(x => x.id !== req.params.id)); res.json({ ok: true }); });
app.post('/api/lager/:id/buchung', auth, (req, res) => {
  const list = readDB('lager');
  const item = list.find(x => x.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Nicht gefunden' });
  const menge = parseFloat(req.body.menge) || 0;
  item.bestand = (parseFloat(item.bestand)||0) + menge;
  item.bewegungen = [...(item.bewegungen||[]), { datum: new Date().toISOString().slice(0,10), typ: req.body.typ||'eingang', menge, bemerkung: req.body.bemerkung||'', user: req.session.user.name }];
  writeDB('lager', list); res.json(item);
});

// ═══════════════════════════════════════════════════════════════
// KALENDER
// ═══════════════════════════════════════════════════════════════
app.get('/api/kalender', auth, (req, res) => res.json(readDB('kalender')));
app.post('/api/kalender', auth, (req, res) => {
  const list = readDB('kalender');
  const item = { id: uuid(), ...req.body, ersteller: req.session.user.name, erstellt: new Date().toISOString() };
  writeDB('kalender', [...list, item]); res.json(item);
});
app.put('/api/kalender/:id', auth, (req, res) => {
  const list = readDB('kalender').map(x => x.id === req.params.id ? { ...x, ...req.body } : x);
  writeDB('kalender', list); res.json({ ok: true });
});
app.delete('/api/kalender/:id', auth, (req, res) => { writeDB('kalender', readDB('kalender').filter(x => x.id !== req.params.id)); res.json({ ok: true }); });

// ═══════════════════════════════════════════════════════════════
// CRM & KOMMUNIKATION
// ═══════════════════════════════════════════════════════════════
app.get('/api/crm', auth, (req, res) => res.json(readDB('crm')));
app.post('/api/crm', auth, (req, res) => {
  const list = readDB('crm');
  const item = { id: uuid(), ...req.body, datum: req.body.datum||new Date().toISOString().slice(0,10), ersteller: req.session.user.name, erstellt: new Date().toISOString() };
  writeDB('crm', [...list, item]); res.json(item);
});
app.put('/api/crm/:id', auth, (req, res) => {
  const list = readDB('crm').map(x => x.id === req.params.id ? { ...x, ...req.body } : x);
  writeDB('crm', list); res.json({ ok: true });
});
app.delete('/api/crm/:id', auth, (req, res) => { writeDB('crm', readDB('crm').filter(x => x.id !== req.params.id)); res.json({ ok: true }); });

// ═══════════════════════════════════════════════════════════════
// CHECKLISTEN
// ═══════════════════════════════════════════════════════════════
app.get('/api/checklisten', auth, (req, res) => res.json(readDB('checklisten')));
app.post('/api/checklisten', auth, (req, res) => {
  const list = readDB('checklisten');
  const item = { id: uuid(), ...req.body, erstellt: new Date().toISOString(), ersteller: req.session.user.name };
  writeDB('checklisten', [...list, item]); res.json(item);
});
app.put('/api/checklisten/:id', auth, (req, res) => {
  const list = readDB('checklisten').map(x => x.id === req.params.id ? { ...x, ...req.body } : x);
  writeDB('checklisten', list); res.json({ ok: true });
});
app.delete('/api/checklisten/:id', auth, (req, res) => { writeDB('checklisten', readDB('checklisten').filter(x => x.id !== req.params.id)); res.json({ ok: true }); });

// ═══════════════════════════════════════════════════════════════
// BETRIEBSBUCHHALTUNG
// ═══════════════════════════════════════════════════════════════
app.get('/api/buchungen', auth, (req, res) => res.json(readDB('buchungen')));
app.post('/api/buchungen', auth, (req, res) => {
  const list = readDB('buchungen');
  const item = { id: uuid(), ...req.body, datum: req.body.datum||new Date().toISOString().slice(0,10), erstellt: new Date().toISOString() };
  writeDB('buchungen', [...list, item]); res.json(item);
});
app.put('/api/buchungen/:id', auth, (req, res) => {
  const list = readDB('buchungen').map(x => x.id === req.params.id ? { ...x, ...req.body } : x);
  writeDB('buchungen', list); res.json({ ok: true });
});
app.delete('/api/buchungen/:id', auth, (req, res) => { writeDB('buchungen', readDB('buchungen').filter(x => x.id !== req.params.id)); res.json({ ok: true }); });

// ═══════════════════════════════════════════════════════════════
// WARTUNG & SERVICE
// ═══════════════════════════════════════════════════════════════
app.get('/api/wartung', auth, (req, res) => res.json(readDB('wartung')));
app.post('/api/wartung', auth, (req, res) => {
  const list = readDB('wartung');
  const item = { id: uuid(), ...req.body, datum: req.body.datum||new Date().toISOString().slice(0,10), status: req.body.status||'offen', erstellt: new Date().toISOString(), ersteller: req.session.user.name };
  writeDB('wartung', [...list, item]); res.json(item);
});
app.put('/api/wartung/:id', auth, (req, res) => {
  const list = readDB('wartung').map(x => x.id === req.params.id ? { ...x, ...req.body } : x);
  writeDB('wartung', list); res.json({ ok: true });
});
app.delete('/api/wartung/:id', auth, (req, res) => { writeDB('wartung', readDB('wartung').filter(x => x.id !== req.params.id)); res.json({ ok: true }); });

// ── Rechnungen ────────────────────────────────────────────────────────────────
app.get('/api/rechnungen', auth, (req, res) => res.json(readDB('rechnungen')));
app.post('/api/rechnungen', auth, (req, res) => {
  const all = readDB('rechnungen');
  const year = new Date().getFullYear();
  const nr = 'RE-' + year + '-' + String(all.filter(r=>r.nummer&&r.nummer.startsWith('RE-'+year)).length+1).padStart(4,'0');
  const item = { id: uuid(), nummer: nr, ...req.body, erstelltVon: req.session.user.name, createdAt: new Date().toISOString() };
  all.push(item); writeDB('rechnungen', all); res.json(item);
});
app.put('/api/rechnungen/:id', auth, (req, res) => {
  const all = readDB('rechnungen'); const idx = all.findIndex(x=>x.id===req.params.id);
  if(idx<0) return res.status(404).json({error:'Nicht gefunden'});
  all[idx]={...all[idx],...req.body}; writeDB('rechnungen',all); res.json(all[idx]);
});
app.delete('/api/rechnungen/:id', auth, (req, res) => { writeDB('rechnungen', readDB('rechnungen').filter(x=>x.id!==req.params.id)); res.json({ok:true}); });

// ── Rapportzettel ─────────────────────────────────────────────────────────────
app.get('/api/rapportzettel', auth, (req, res) => res.json(readDB('rapportzettel')));
app.post('/api/rapportzettel', auth, (req, res) => {
  const item = { id: uuid(), ...req.body, erstelltVon: req.session.user.name, createdAt: new Date().toISOString() };
  const all = readDB('rapportzettel'); all.push(item); writeDB('rapportzettel',all); res.json(item);
});
app.put('/api/rapportzettel/:id', auth, (req, res) => {
  const all=readDB('rapportzettel'); const idx=all.findIndex(x=>x.id===req.params.id);
  if(idx<0) return res.status(404).json({error:'Nicht gefunden'});
  all[idx]={...all[idx],...req.body}; writeDB('rapportzettel',all); res.json(all[idx]);
});
app.delete('/api/rapportzettel/:id', auth, (req, res) => { writeDB('rapportzettel', readDB('rapportzettel').filter(x=>x.id!==req.params.id)); res.json({ok:true}); });

// ── Fotodokumentation ─────────────────────────────────────────────────────────
app.get('/api/fotodokumentation', auth, (req, res) => res.json(readDB('fotodokumentation')));
app.post('/api/fotodokumentation', auth, (req, res) => {
  const item = { id: uuid(), ...req.body, hochgeladenVon: req.session.user.name, createdAt: new Date().toISOString() };
  const all = readDB('fotodokumentation'); all.push(item); writeDB('fotodokumentation',all); res.json(item);
});
app.put('/api/fotodokumentation/:id', auth, (req, res) => {
  const all=readDB('fotodokumentation'); const idx=all.findIndex(x=>x.id===req.params.id);
  if(idx<0) return res.status(404).json({error:'Nicht gefunden'});
  all[idx]={...all[idx],...req.body}; writeDB('fotodokumentation',all); res.json(all[idx]);
});
app.delete('/api/fotodokumentation/:id', auth, (req, res) => { writeDB('fotodokumentation', readDB('fotodokumentation').filter(x=>x.id!==req.params.id)); res.json({ok:true}); });

// ── Bauübergabe ───────────────────────────────────────────────────────────────
app.get('/api/bauuebergabe', auth, (req, res) => res.json(readDB('bauuebergabe')));
app.post('/api/bauuebergabe', auth, (req, res) => {
  const all=readDB('bauuebergabe');
  const year=new Date().getFullYear();
  const nr='BÜ-'+year+'-'+String(all.filter(r=>r.nummer&&r.nummer.startsWith('BÜ-'+year)).length+1).padStart(3,'0');
  const item = { id: uuid(), nummer: nr, ...req.body, erstelltVon: req.session.user.name, createdAt: new Date().toISOString() };
  all.push(item); writeDB('bauuebergabe',all); res.json(item);
});
app.put('/api/bauuebergabe/:id', auth, (req, res) => {
  const all=readDB('bauuebergabe'); const idx=all.findIndex(x=>x.id===req.params.id);
  if(idx<0) return res.status(404).json({error:'Nicht gefunden'});
  all[idx]={...all[idx],...req.body}; writeDB('bauuebergabe',all); res.json(all[idx]);
});
app.delete('/api/bauuebergabe/:id', auth, (req, res) => { writeDB('bauuebergabe', readDB('bauuebergabe').filter(x=>x.id!==req.params.id)); res.json({ok:true}); });

// ── Formulare (Vorlagen) ──────────────────────────────────────────────────────
app.get('/api/formulare', auth, (req, res) => res.json(readDB('formulare')));
app.post('/api/formulare', auth, (req, res) => {
  const item = { id: uuid(), ...req.body, erstelltVon: req.session.user.name, createdAt: new Date().toISOString() };
  const all=readDB('formulare'); all.push(item); writeDB('formulare',all); res.json(item);
});
app.put('/api/formulare/:id', auth, (req, res) => {
  const all=readDB('formulare'); const idx=all.findIndex(x=>x.id===req.params.id);
  if(idx<0) return res.status(404).json({error:'Nicht gefunden'});
  all[idx]={...all[idx],...req.body}; writeDB('formulare',all); res.json(all[idx]);
});
app.delete('/api/formulare/:id', auth, (req, res) => { writeDB('formulare', readDB('formulare').filter(x=>x.id!==req.params.id)); res.json({ok:true}); });

// ── Baulohn ───────────────────────────────────────────────────────────────────
app.get('/api/baulohn', auth, (req, res) => res.json(readDB('baulohn')));
app.post('/api/baulohn', auth, (req, res) => {
  const item = { id: uuid(), ...req.body, erstelltVon: req.session.user.name, createdAt: new Date().toISOString() };
  const all=readDB('baulohn'); all.push(item); writeDB('baulohn',all); res.json(item);
});
app.put('/api/baulohn/:id', auth, (req, res) => {
  const all=readDB('baulohn'); const idx=all.findIndex(x=>x.id===req.params.id);
  if(idx<0) return res.status(404).json({error:'Nicht gefunden'});
  all[idx]={...all[idx],...req.body}; writeDB('baulohn',all); res.json(all[idx]);
});
app.delete('/api/baulohn/:id', auth, (req, res) => { writeDB('baulohn', readDB('baulohn').filter(x=>x.id!==req.params.id)); res.json({ok:true}); });

// ── Mitarbeiter Skills ────────────────────────────────────────────────────────
app.get('/api/mitarbeiterskills', auth, (req, res) => res.json(readDB('mitarbeiterskills')));
app.post('/api/mitarbeiterskills', auth, (req, res) => {
  const item = { id: uuid(), ...req.body, createdAt: new Date().toISOString() };
  const all=readDB('mitarbeiterskills'); all.push(item); writeDB('mitarbeiterskills',all); res.json(item);
});
app.put('/api/mitarbeiterskills/:id', auth, (req, res) => {
  const all=readDB('mitarbeiterskills'); const idx=all.findIndex(x=>x.id===req.params.id);
  if(idx<0) return res.status(404).json({error:'Nicht gefunden'});
  all[idx]={...all[idx],...req.body}; writeDB('mitarbeiterskills',all); res.json(all[idx]);
});
app.delete('/api/mitarbeiterskills/:id', auth, (req, res) => { writeDB('mitarbeiterskills', readDB('mitarbeiterskills').filter(x=>x.id!==req.params.id)); res.json({ok:true}); });

// ── Fristenmanagement ─────────────────────────────────────────────────────────
app.get('/api/fristen', auth, (req, res) => res.json(readDB('fristen')));
app.post('/api/fristen', auth, (req, res) => {
  const item = { id: uuid(), ...req.body, erstelltVon: req.session.user.name, createdAt: new Date().toISOString() };
  const all=readDB('fristen'); all.push(item); writeDB('fristen',all); res.json(item);
});
app.put('/api/fristen/:id', auth, (req, res) => {
  const all=readDB('fristen'); const idx=all.findIndex(x=>x.id===req.params.id);
  if(idx<0) return res.status(404).json({error:'Nicht gefunden'});
  all[idx]={...all[idx],...req.body}; writeDB('fristen',all); res.json(all[idx]);
});
app.delete('/api/fristen/:id', auth, (req, res) => { writeDB('fristen', readDB('fristen').filter(x=>x.id!==req.params.id)); res.json({ok:true}); });

// ── Berichtswesen ─────────────────────────────────────────────────────────────
app.get('/api/berichte', auth, (req, res) => res.json(readDB('berichte')));
app.post('/api/berichte', auth, (req, res) => {
  const all=readDB('berichte');
  const year=new Date().getFullYear();
  const nr='BR-'+year+'-'+String(all.filter(r=>r.nummer&&r.nummer.startsWith('BR-'+year)).length+1).padStart(4,'0');
  const item = { id: uuid(), nummer: nr, ...req.body, erstelltVon: req.session.user.name, createdAt: new Date().toISOString() };
  all.push(item); writeDB('berichte',all); res.json(item);
});
app.put('/api/berichte/:id', auth, (req, res) => {
  const all=readDB('berichte'); const idx=all.findIndex(x=>x.id===req.params.id);
  if(idx<0) return res.status(404).json({error:'Nicht gefunden'});
  all[idx]={...all[idx],...req.body}; writeDB('berichte',all); res.json(all[idx]);
});
app.delete('/api/berichte/:id', auth, (req, res) => { writeDB('berichte', readDB('berichte').filter(x=>x.id!==req.params.id)); res.json({ok:true}); });

// ── Arbeitssicherheit ─────────────────────────────────────────────────────────
app.get('/api/arbeitssicherheit', auth, (req, res) => res.json(readDB('arbeitssicherheit')));
app.post('/api/arbeitssicherheit', auth, (req, res) => {
  const item = { id: uuid(), ...req.body, gemeldetVon: req.session.user.name, createdAt: new Date().toISOString() };
  const all=readDB('arbeitssicherheit'); all.push(item); writeDB('arbeitssicherheit',all); res.json(item);
});
app.put('/api/arbeitssicherheit/:id', auth, (req, res) => {
  const all=readDB('arbeitssicherheit'); const idx=all.findIndex(x=>x.id===req.params.id);
  if(idx<0) return res.status(404).json({error:'Nicht gefunden'});
  all[idx]={...all[idx],...req.body}; writeDB('arbeitssicherheit',all); res.json(all[idx]);
});
app.delete('/api/arbeitssicherheit/:id', auth, (req, res) => { writeDB('arbeitssicherheit', readDB('arbeitssicherheit').filter(x=>x.id!==req.params.id)); res.json({ok:true}); });

// ── Gefährdungsbeurteilung ────────────────────────────────────────────────────
app.get('/api/gefaehrdung', auth, (req, res) => res.json(readDB('gefaehrdung')));
app.post('/api/gefaehrdung', auth, (req, res) => {
  const item = { id: uuid(), ...req.body, erstelltVon: req.session.user.name, createdAt: new Date().toISOString() };
  const all=readDB('gefaehrdung'); all.push(item); writeDB('gefaehrdung',all); res.json(item);
});
app.put('/api/gefaehrdung/:id', auth, (req, res) => {
  const all=readDB('gefaehrdung'); const idx=all.findIndex(x=>x.id===req.params.id);
  if(idx<0) return res.status(404).json({error:'Nicht gefunden'});
  all[idx]={...all[idx],...req.body}; writeDB('gefaehrdung',all); res.json(all[idx]);
});
app.delete('/api/gefaehrdung/:id', auth, (req, res) => { writeDB('gefaehrdung', readDB('gefaehrdung').filter(x=>x.id!==req.params.id)); res.json({ok:true}); });

// ── Unterweisung ──────────────────────────────────────────────────────────────
app.get('/api/unterweisung', auth, (req, res) => res.json(readDB('unterweisung')));
app.post('/api/unterweisung', auth, (req, res) => {
  const item = { id: uuid(), ...req.body, erstelltVon: req.session.user.name, createdAt: new Date().toISOString() };
  const all=readDB('unterweisung'); all.push(item); writeDB('unterweisung',all); res.json(item);
});
app.put('/api/unterweisung/:id', auth, (req, res) => {
  const all=readDB('unterweisung'); const idx=all.findIndex(x=>x.id===req.params.id);
  if(idx<0) return res.status(404).json({error:'Nicht gefunden'});
  all[idx]={...all[idx],...req.body}; writeDB('unterweisung',all); res.json(all[idx]);
});
app.delete('/api/unterweisung/:id', auth, (req, res) => { writeDB('unterweisung', readDB('unterweisung').filter(x=>x.id!==req.params.id)); res.json({ok:true}); });

// ── Telematik ─────────────────────────────────────────────────────────────────
app.get('/api/telematik', auth, (req, res) => res.json(readDB('telematik')));
app.post('/api/telematik', auth, (req, res) => {
  const item = { id: uuid(), ...req.body, createdAt: new Date().toISOString() };
  const all=readDB('telematik'); all.push(item); writeDB('telematik',all); res.json(item);
});
app.put('/api/telematik/:id', auth, (req, res) => {
  const all=readDB('telematik'); const idx=all.findIndex(x=>x.id===req.params.id);
  if(idx<0) return res.status(404).json({error:'Nicht gefunden'});
  all[idx]={...all[idx],...req.body}; writeDB('telematik',all); res.json(all[idx]);
});
app.delete('/api/telematik/:id', auth, (req, res) => { writeDB('telematik', readDB('telematik').filter(x=>x.id!==req.params.id)); res.json({ok:true}); });

app.get('*', (req, res) => res.sendFile(path.join(BASE,'public','index.html')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅  STORCK Plattform läuft auf http://localhost:${PORT}`);
  console.log(`   Im Netzwerk: http://<IP-Adresse>:${PORT}`);
  console.log(`   Admin-Login: admin@admin.de / admin123\n`);
});
