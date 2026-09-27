'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SORTS = {
  taken_desc: 'm.taken_at DESC, m.id DESC',
  taken_asc: 'm.taken_at ASC, m.id ASC',
  uploaded_desc: 'm.uploaded_at DESC, m.id DESC',
};

// Turns a DB row into the public JSON shape. `base` is the URL prefix used for
// file links, so that the same shape can be served from shared-album routes.
function serialize(row, base = '/api/media') {
  return {
    id: row.id,
    kind: row.kind,
    name: row.original_name,
    mime: row.mime,
    size: row.size,
    width: row.width,
    height: row.height,
    duration: row.duration,
    takenAt: row.taken_at,
    uploadedAt: row.uploaded_at,
    title: row.title,
    description: row.description,
    camera: row.camera,
    latitude: row.latitude,
    longitude: row.longitude,
    ownerId: row.owner_id,
    ownerName: row.owner_name ?? null,
    favorite: Boolean(row.favorite),
    deletedAt: row.deleted_at,
    hasThumb: Boolean(row.thumb_path),
    thumbUrl: `${base}/${row.id}/thumb`,
    fileUrl: `${base}/${row.id}/file`,
  };
}

// Builds and runs the media listing query from a set of optional filters.
function listMedia(db, userId, filters = {}) {
  const where = [];
  const params = [];

  where.push(filters.trash ? 'm.deleted_at IS NOT NULL' : 'm.deleted_at IS NULL');

  if (filters.kind === 'photo' || filters.kind === 'video') {
    where.push('m.kind = ?');
    params.push(filters.kind);
  }
  if (filters.favorite) {
    where.push('EXISTS (SELECT 1 FROM favorites f WHERE f.media_id = m.id AND f.user_id = ?)');
    params.push(userId);
  }
  if (filters.albumId) {
    where.push('EXISTS (SELECT 1 FROM album_media am WHERE am.media_id = m.id AND am.album_id = ?)');
    params.push(Number(filters.albumId));
  }
  if (filters.labelId) {
    where.push('EXISTS (SELECT 1 FROM media_labels ml WHERE ml.media_id = m.id AND ml.label_id = ?)');
    params.push(Number(filters.labelId));
  }
  if (filters.ownerId) {
    where.push('m.owner_id = ?');
    params.push(Number(filters.ownerId));
  }
  if (filters.from) {
    where.push('m.taken_at >= ?');
    params.push(String(filters.from));
  }
  if (filters.to) {
    // Inclusive end date: compare against the start of the following day.
    const to = new Date(String(filters.to));
    if (!Number.isNaN(to.getTime())) {
      to.setUTCDate(to.getUTCDate() + 1);
      where.push('m.taken_at < ?');
      params.push(to.toISOString().slice(0, 10));
    }
  }
  if (filters.q) {
    const like = `%${String(filters.q).trim()}%`;
    where.push(`(
      m.title LIKE ? OR m.description LIKE ? OR m.original_name LIKE ? OR m.camera LIKE ?
      OR EXISTS (SELECT 1 FROM media_labels ml JOIN labels l ON l.id = ml.label_id
                 WHERE ml.media_id = m.id AND l.name LIKE ?)
      OR EXISTS (SELECT 1 FROM album_media am JOIN albums a ON a.id = am.album_id
                 WHERE am.media_id = m.id AND a.title LIKE ?)
    )`);
    params.push(like, like, like, like, like, like);
  }

  const whereSql = where.join(' AND ');
  const order = SORTS[filters.sort] || SORTS.taken_desc;
  const limit = Math.min(Math.max(Number(filters.limit) || 200, 1), 1000);
  const offset = Math.max(Number(filters.offset) || 0, 0);

  const total = db.prepare(`SELECT COUNT(*) AS n FROM media m WHERE ${whereSql}`).get(...params).n;
  const rows = db
    .prepare(`
      SELECT m.*, u.name AS owner_name,
             EXISTS (SELECT 1 FROM favorites f WHERE f.media_id = m.id AND f.user_id = ?) AS favorite
      FROM media m LEFT JOIN users u ON u.id = m.owner_id
      WHERE ${whereSql}
      ORDER BY ${order}
      LIMIT ? OFFSET ?
    `)
    .all(userId, ...params, limit, offset);

  return { items: rows.map((r) => serialize(r)), total, limit, offset };
}

function getMediaRow(db, id, userId = 0) {
  return db
    .prepare(`
      SELECT m.*, u.name AS owner_name,
             EXISTS (SELECT 1 FROM favorites f WHERE f.media_id = m.id AND f.user_id = ?) AS favorite
      FROM media m LEFT JOIN users u ON u.id = m.owner_id
      WHERE m.id = ?
    `)
    .get(userId, Number(id));
}

function getLabels(db, mediaId) {
  const rows = db
    .prepare(`
      SELECT l.id, l.kind, l.name FROM media_labels ml JOIN labels l ON l.id = ml.label_id
      WHERE ml.media_id = ? ORDER BY l.name
    `)
    .all(mediaId);
  return {
    tags: rows.filter((r) => r.kind === 'tag').map(({ id, name }) => ({ id, name })),
    people: rows.filter((r) => r.kind === 'person').map(({ id, name }) => ({ id, name })),
  };
}

function ensureLabel(db, kind, name) {
  const clean = String(name).trim().slice(0, 80);
  if (!clean) return null;
  db.prepare('INSERT OR IGNORE INTO labels (kind, name) VALUES (?, ?)').run(kind, clean);
  return db.prepare('SELECT id FROM labels WHERE kind = ? AND name = ?').get(kind, clean).id;
}

// Replaces all labels of the given kind on a media item.
function setLabels(db, mediaId, kind, names) {
  db.prepare(`
    DELETE FROM media_labels WHERE media_id = ?
      AND label_id IN (SELECT id FROM labels WHERE kind = ?)
  `).run(mediaId, kind);
  const insert = db.prepare('INSERT OR IGNORE INTO media_labels (media_id, label_id) VALUES (?, ?)');
  for (const name of names) {
    const labelId = ensureLabel(db, kind, name);
    if (labelId) insert.run(mediaId, labelId);
  }
}

function addLabel(db, mediaId, kind, name) {
  const labelId = ensureLabel(db, kind, name);
  if (labelId) db.prepare('INSERT OR IGNORE INTO media_labels (media_id, label_id) VALUES (?, ?)').run(mediaId, labelId);
}

function removeMediaFiles(dataDir, row) {
  for (const rel of [row.stored_path, row.thumb_path]) {
    if (rel) fs.rm(path.join(dataDir, rel), { force: true }, () => {});
  }
}

// Permanently deletes a media row and its files.
function purgeMedia(db, dataDir, row) {
  db.prepare('DELETE FROM media WHERE id = ?').run(row.id);
  removeMediaFiles(dataDir, row);
}

module.exports = {
  serialize,
  listMedia,
  getMediaRow,
  getLabels,
  setLabels,
  addLabel,
  purgeMedia,
};
