'use strict';

const express = require('express');
const { requireAuth, requireRole, canModify, randomToken } = require('../auth');

// Albums include a cover: the explicit one, or the most recent item in them.
const ALBUM_SELECT = `
  SELECT a.id, a.title, a.description, a.owner_id AS ownerId, u.name AS ownerName,
         a.share_token AS shareToken, a.created_at AS createdAt,
         (SELECT COUNT(*) FROM album_media am JOIN media m ON m.id = am.media_id
          WHERE am.album_id = a.id AND m.deleted_at IS NULL) AS count,
         COALESCE(
           (SELECT m.id FROM media m WHERE m.id = a.cover_media_id AND m.deleted_at IS NULL),
           (SELECT m.id FROM album_media am JOIN media m ON m.id = am.media_id
            WHERE am.album_id = a.id AND m.deleted_at IS NULL ORDER BY m.taken_at DESC LIMIT 1)
         ) AS coverId,
         (SELECT MIN(m.taken_at) FROM album_media am JOIN media m ON m.id = am.media_id
          WHERE am.album_id = a.id AND m.deleted_at IS NULL) AS startDate,
         (SELECT MAX(m.taken_at) FROM album_media am JOIN media m ON m.id = am.media_id
          WHERE am.album_id = a.id AND m.deleted_at IS NULL) AS endDate
  FROM albums a LEFT JOIN users u ON u.id = a.owner_id
`;

module.exports = function albumRoutes(db) {
  const router = express.Router();

  const getAlbum = (id) => db.prepare(`${ALBUM_SELECT} WHERE a.id = ?`).get(Number(id));

  const loadOwned = (req, res) => {
    const album = getAlbum(req.params.id);
    if (!album) {
      res.status(404).json({ error: 'Альбом не найден' });
      return null;
    }
    if (!canModify(req.user, album.ownerId)) {
      res.status(403).json({ error: 'Недостаточно прав' });
      return null;
    }
    return album;
  };

  router.get('/', requireAuth, (req, res) => {
    res.json(db.prepare(`${ALBUM_SELECT} ORDER BY a.created_at DESC`).all());
  });

  router.post('/', requireRole('member'), (req, res) => {
    const title = String(req.body.title || '').trim().slice(0, 200);
    if (!title) return res.status(400).json({ error: 'Укажите название альбома' });
    const { lastInsertRowid } = db
      .prepare('INSERT INTO albums (title, description, owner_id) VALUES (?, ?, ?)')
      .run(title, String(req.body.description || '').slice(0, 5000), req.user.id);
    const id = Number(lastInsertRowid);
    if (Array.isArray(req.body.mediaIds)) {
      const insert = db.prepare('INSERT OR IGNORE INTO album_media (album_id, media_id) SELECT ?, id FROM media WHERE id = ?');
      for (const mediaId of req.body.mediaIds) insert.run(id, Number(mediaId));
    }
    res.status(201).json(getAlbum(id));
  });

  router.get('/:id', requireAuth, (req, res) => {
    const album = getAlbum(req.params.id);
    if (!album) return res.status(404).json({ error: 'Альбом не найден' });
    res.json({ ...album, canEdit: canModify(req.user, album.ownerId) });
  });

  router.patch('/:id', requireRole('member'), (req, res) => {
    const album = loadOwned(req, res);
    if (!album) return;
    const { title, description, coverId } = req.body;
    if (typeof title === 'string' && title.trim()) {
      db.prepare('UPDATE albums SET title = ? WHERE id = ?').run(title.trim().slice(0, 200), album.id);
    }
    if (typeof description === 'string') {
      db.prepare('UPDATE albums SET description = ? WHERE id = ?').run(description.slice(0, 5000), album.id);
    }
    if (coverId !== undefined) {
      db.prepare('UPDATE albums SET cover_media_id = ? WHERE id = ?').run(coverId ? Number(coverId) : null, album.id);
    }
    res.json({ ...getAlbum(album.id), canEdit: true });
  });

  router.delete('/:id', requireRole('member'), (req, res) => {
    const album = loadOwned(req, res);
    if (!album) return;
    // Deleting an album keeps the photos themselves.
    db.prepare('DELETE FROM albums WHERE id = ?').run(album.id);
    res.json({ ok: true });
  });

  // Any member may add to or remove from any album — it is a shared family space.
  router.post('/:id/media', requireRole('member'), (req, res) => {
    const album = getAlbum(req.params.id);
    if (!album) return res.status(404).json({ error: 'Альбом не найден' });
    const insert = db.prepare('INSERT OR IGNORE INTO album_media (album_id, media_id) SELECT ?, id FROM media WHERE id = ?');
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    db.transaction(() => ids.forEach((id) => insert.run(album.id, Number(id))));
    res.json(getAlbum(album.id));
  });

  router.delete('/:id/media', requireRole('member'), (req, res) => {
    const album = getAlbum(req.params.id);
    if (!album) return res.status(404).json({ error: 'Альбом не найден' });
    const remove = db.prepare('DELETE FROM album_media WHERE album_id = ? AND media_id = ?');
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    db.transaction(() => ids.forEach((id) => remove.run(album.id, Number(id))));
    res.json(getAlbum(album.id));
  });

  // Public read-only link for relatives without an account.
  router.post('/:id/share', requireRole('member'), (req, res) => {
    const album = loadOwned(req, res);
    if (!album) return;
    const token = album.shareToken || randomToken(18);
    db.prepare('UPDATE albums SET share_token = ? WHERE id = ?').run(token, album.id);
    res.json({ shareToken: token });
  });

  router.delete('/:id/share', requireRole('member'), (req, res) => {
    const album = loadOwned(req, res);
    if (!album) return;
    db.prepare('UPDATE albums SET share_token = NULL WHERE id = ?').run(album.id);
    res.json({ shareToken: null });
  });

  return router;
};
