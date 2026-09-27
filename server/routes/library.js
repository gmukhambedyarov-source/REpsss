'use strict';

const express = require('express');
const { requireAuth, requireRole } = require('../auth');
const { serialize } = require('../media-helpers');
const { sendOriginal, sendThumb } = require('./media');

// People & tags, statistics, and the public shared-album endpoints.
module.exports = function libraryRoutes(db, config) {
  const router = express.Router();

  // --- Labels (people and tags) ---

  router.get('/labels', requireAuth, (req, res) => {
    const kind = req.query.kind === 'person' || req.query.kind === 'tag' ? req.query.kind : null;
    const rows = db
      .prepare(`
        SELECT l.id, l.kind, l.name,
               COUNT(m.id) AS count,
               (SELECT m2.id FROM media_labels ml2 JOIN media m2 ON m2.id = ml2.media_id
                WHERE ml2.label_id = l.id AND m2.deleted_at IS NULL
                ORDER BY m2.taken_at DESC LIMIT 1) AS coverId
        FROM labels l
        LEFT JOIN media_labels ml ON ml.label_id = l.id
        LEFT JOIN media m ON m.id = ml.media_id AND m.deleted_at IS NULL
        WHERE (? IS NULL OR l.kind = ?)
        GROUP BY l.id
        HAVING count > 0
        ORDER BY count DESC, l.name
      `)
      .all(kind, kind);
    res.json(rows);
  });

  router.patch('/labels/:id', requireRole('member'), (req, res) => {
    const name = String(req.body.name || '').trim().slice(0, 80);
    if (!name) return res.status(400).json({ error: 'Пустое имя' });
    const label = db.prepare('SELECT * FROM labels WHERE id = ?').get(Number(req.params.id));
    if (!label) return res.status(404).json({ error: 'Не найдено' });
    const clash = db.prepare('SELECT id FROM labels WHERE kind = ? AND name = ? AND id != ?').get(label.kind, name, label.id);
    db.transaction(() => {
      if (clash) {
        // Renaming onto an existing name merges the two labels.
        db.prepare('INSERT OR IGNORE INTO media_labels (media_id, label_id) SELECT media_id, ? FROM media_labels WHERE label_id = ?')
          .run(clash.id, label.id);
        db.prepare('DELETE FROM labels WHERE id = ?').run(label.id);
      } else {
        db.prepare('UPDATE labels SET name = ? WHERE id = ?').run(name, label.id);
      }
    });
    res.json({ id: clash ? clash.id : label.id, name, kind: label.kind, merged: Boolean(clash) });
  });

  router.delete('/labels/:id', requireRole('member'), (req, res) => {
    db.prepare('DELETE FROM labels WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  });

  // --- Statistics ---

  router.get('/stats', requireAuth, (req, res) => {
    const totals = db
      .prepare(`
        SELECT
          COALESCE(SUM(kind = 'photo'), 0) AS photos,
          COALESCE(SUM(kind = 'video'), 0) AS videos,
          COALESCE(SUM(size), 0) AS bytes
        FROM media WHERE deleted_at IS NULL
      `)
      .get();
    const trash = db.prepare('SELECT COUNT(*) AS n FROM media WHERE deleted_at IS NOT NULL').get().n;
    const byYear = db
      .prepare(`
        SELECT strftime('%Y', taken_at) AS year, COUNT(*) AS count
        FROM media WHERE deleted_at IS NULL GROUP BY year ORDER BY year DESC
      `)
      .all();
    const byMember = db
      .prepare(`
        SELECT u.id, u.name, COUNT(m.id) AS count, COALESCE(SUM(m.size), 0) AS bytes
        FROM users u LEFT JOIN media m ON m.owner_id = u.id AND m.deleted_at IS NULL
        GROUP BY u.id ORDER BY count DESC
      `)
      .all();
    res.json({
      ...totals,
      trash,
      albums: db.prepare('SELECT COUNT(*) AS n FROM albums').get().n,
      people: db.prepare("SELECT COUNT(*) AS n FROM labels WHERE kind = 'person'").get().n,
      byYear,
      byMember,
    });
  });

  // --- Public shared albums (no account needed) ---

  const sharedAlbum = (token) =>
    db.prepare('SELECT id, title, description FROM albums WHERE share_token = ?').get(String(token));

  const sharedMedia = (albumId, mediaId) =>
    db
      .prepare(`
        SELECT m.* FROM media m JOIN album_media am ON am.media_id = m.id
        WHERE am.album_id = ? AND m.id = ? AND m.deleted_at IS NULL
      `)
      .get(albumId, Number(mediaId));

  router.get('/shared/:token', (req, res) => {
    const album = sharedAlbum(req.params.token);
    if (!album) return res.status(404).json({ error: 'Ссылка недействительна' });
    const base = `/api/shared/${encodeURIComponent(req.params.token)}/media`;
    const items = db
      .prepare(`
        SELECT m.* FROM media m JOIN album_media am ON am.media_id = m.id
        WHERE am.album_id = ? AND m.deleted_at IS NULL ORDER BY m.taken_at ASC
      `)
      .all(album.id)
      .map((row) => {
        // Hide who uploaded what and where it was taken from outside viewers.
        const item = serialize(row, base);
        delete item.ownerId;
        delete item.latitude;
        delete item.longitude;
        return item;
      });
    res.json({ album, items });
  });

  router.get('/shared/:token/media/:id/:variant', (req, res) => {
    const album = sharedAlbum(req.params.token);
    const row = album && sharedMedia(album.id, req.params.id);
    if (!row) return res.status(404).json({ error: 'Не найдено' });
    if (req.params.variant === 'thumb') return sendThumb(db, config.dataDir, req, res, row);
    if (req.params.variant === 'file') return sendOriginal(db, config.dataDir, req, res, row);
    res.status(404).json({ error: 'Не найдено' });
  });

  return router;
};
