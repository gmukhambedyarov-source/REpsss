'use strict';

const express = require('express');
const {
  hashPassword,
  verifyPassword,
  randomToken,
  createSession,
  setSessionCookie,
  clearSessionCookie,
  requireAuth,
  requireRole,
} = require('../auth');

const ROLES = ['admin', 'member', 'viewer'];

module.exports = function authRoutes(db) {
  const router = express.Router();

  const userCount = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

  router.get('/status', (req, res) => {
    res.json({ needsSetup: userCount() === 0, user: req.user });
  });

  router.post('/register', (req, res) => {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim();
    const password = String(req.body.password || '');
    const inviteCode = String(req.body.invite || '').trim();

    if (!name || !email || password.length < 6) {
      return res.status(400).json({ error: 'Укажите имя, e-mail и пароль (не короче 6 символов)' });
    }
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
      return res.status(409).json({ error: 'Пользователь с таким e-mail уже есть' });
    }

    const result = db.transaction(() => {
      // The very first account becomes the family administrator;
      // everybody else needs an invitation.
      let role = 'admin';
      let invite = null;
      if (userCount() > 0) {
        invite = db.prepare('SELECT * FROM invites WHERE code = ? AND used_by IS NULL').get(inviteCode);
        if (!invite) return null;
        role = invite.role;
      }
      const { lastInsertRowid } = db
        .prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
        .run(name, email, hashPassword(password), role);
      if (invite) db.prepare('UPDATE invites SET used_by = ? WHERE code = ?').run(lastInsertRowid, invite.code);
      return Number(lastInsertRowid);
    });

    if (result === null) return res.status(403).json({ error: 'Нужен действующий код приглашения' });
    setSessionCookie(req, res, createSession(db, result));
    res.status(201).json({ user: db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(result) });
  });

  router.post('/login', (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(req.body.email || '').trim());
    if (!user || !verifyPassword(String(req.body.password || ''), user.password_hash)) {
      return res.status(401).json({ error: 'Неверный e-mail или пароль' });
    }
    setSessionCookie(req, res, createSession(db, user.id));
    res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  });

  router.post('/logout', (req, res) => {
    if (req.sessionToken) db.prepare('DELETE FROM sessions WHERE token = ?').run(req.sessionToken);
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  router.post('/password', requireAuth, (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    const next = String(req.body.newPassword || '');
    if (!verifyPassword(String(req.body.currentPassword || ''), user.password_hash)) {
      return res.status(400).json({ error: 'Текущий пароль указан неверно' });
    }
    if (next.length < 6) return res.status(400).json({ error: 'Пароль должен быть не короче 6 символов' });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), user.id);
    res.json({ ok: true });
  });

  // --- Family members & invitations (admin) ---

  router.get('/users', requireAuth, (req, res) => {
    res.json(
      db
        .prepare(`
          SELECT u.id, u.name, u.email, u.role, u.created_at,
                 (SELECT COUNT(*) FROM media m WHERE m.owner_id = u.id AND m.deleted_at IS NULL) AS media_count
          FROM users u ORDER BY u.created_at
        `)
        .all(),
    );
  });

  router.patch('/users/:id', requireRole('admin'), (req, res) => {
    const id = Number(req.params.id);
    const role = req.body.role;
    if (!ROLES.includes(role)) return res.status(400).json({ error: 'Неизвестная роль' });
    if (id === req.user.id) return res.status(400).json({ error: 'Нельзя изменить собственную роль' });
    const { changes } = db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
    if (!changes) return res.status(404).json({ error: 'Пользователь не найден' });
    res.json({ ok: true });
  });

  router.delete('/users/:id', requireRole('admin'), (req, res) => {
    const id = Number(req.params.id);
    if (id === req.user.id) return res.status(400).json({ error: 'Нельзя удалить самого себя' });
    const { changes } = db.prepare('DELETE FROM users WHERE id = ?').run(id);
    if (!changes) return res.status(404).json({ error: 'Пользователь не найден' });
    res.json({ ok: true });
  });

  router.get('/invites', requireRole('admin'), (req, res) => {
    res.json(
      db
        .prepare(`
          SELECT i.code, i.role, i.created_at, u.name AS used_by_name
          FROM invites i LEFT JOIN users u ON u.id = i.used_by
          ORDER BY i.created_at DESC
        `)
        .all(),
    );
  });

  router.post('/invites', requireRole('admin'), (req, res) => {
    const role = ROLES.includes(req.body.role) ? req.body.role : 'member';
    const code = randomToken(9);
    db.prepare('INSERT INTO invites (code, role, created_by) VALUES (?, ?, ?)').run(code, role, req.user.id);
    res.status(201).json({ code, role });
  });

  router.delete('/invites/:code', requireRole('admin'), (req, res) => {
    db.prepare('DELETE FROM invites WHERE code = ?').run(req.params.code);
    res.json({ ok: true });
  });

  return router;
};
