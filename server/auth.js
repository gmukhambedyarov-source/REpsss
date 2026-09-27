'use strict';

const crypto = require('node:crypto');

const SESSION_COOKIE = 'fa_session';
const SESSION_DAYS = 30;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createSession(db, userId) {
  const token = randomToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 86400e3).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expires);
  return token;
}

function setSessionCookie(req, res, token) {
  const secure = req.secure ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}`,
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

// Populates req.user when a valid session cookie is present.
function sessionMiddleware(db) {
  const lookup = db.prepare(`
    SELECT u.id, u.name, u.email, u.role
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ?
  `);
  return (req, _res, next) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    req.sessionToken = token || null;
    req.user = token ? lookup.get(token, new Date().toISOString()) || null : null;
    next();
  };
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Требуется вход' });
  next();
}

const ROLE_RANK = { viewer: 0, member: 1, admin: 2 };

function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Требуется вход' });
    if (ROLE_RANK[req.user.role] < ROLE_RANK[role]) {
      return res.status(403).json({ error: 'Недостаточно прав' });
    }
    next();
  };
}

// Admins may change anything; members only what they own.
function canModify(user, ownerId) {
  return user.role === 'admin' || (user.role === 'member' && user.id === ownerId);
}

module.exports = {
  SESSION_COOKIE,
  hashPassword,
  verifyPassword,
  randomToken,
  createSession,
  setSessionCookie,
  clearSessionCookie,
  sessionMiddleware,
  requireAuth,
  requireRole,
  canModify,
};
