'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const multer = require('multer');
const exifr = require('exifr');
const { requireAuth, requireRole, canModify, randomToken } = require('../auth');
const {
  serialize,
  listMedia,
  getMediaRow,
  getLabels,
  setLabels,
  addLabel,
  purgeMedia,
} = require('../media-helpers');

const EXTENSION_MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.3gp': 'video/3gpp',
};

function detectMime(file) {
  if (/^(image|video)\//.test(file.mimetype)) return file.mimetype;
  return EXTENSION_MIME[path.extname(file.originalname).toLowerCase()] || null;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

async function readExif(file) {
  try {
    const data = await exifr.parse(file, { gps: true, tiff: true, exif: true });
    if (!data) return {};
    const taken = data.DateTimeOriginal || data.CreateDate || data.ModifyDate;
    return {
      takenAt: taken instanceof Date && !Number.isNaN(taken.getTime()) ? taken.toISOString() : null,
      camera: [data.Make, data.Model].filter(Boolean).join(' ').trim() || null,
      latitude: Number.isFinite(data.latitude) ? data.latitude : null,
      longitude: Number.isFinite(data.longitude) ? data.longitude : null,
      width: data.ExifImageWidth || data.ImageWidth || null,
      height: data.ExifImageHeight || data.ImageHeight || null,
    };
  } catch {
    return {};
  }
}

function toIsoDate(value) {
  if (!value) return null;
  const date = new Date(/^\d+$/.test(value) ? Number(value) : value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function positiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

module.exports = function mediaRoutes(db, config) {
  const router = express.Router();
  const { dataDir } = config;
  const tmpDir = path.join(dataDir, 'tmp');

  const upload = multer({
    dest: tmpDir,
    limits: { fileSize: config.maxUploadBytes, files: 2 },
  });

  const loadOwned = (req, res) => {
    const row = getMediaRow(db, req.params.id, req.user.id);
    if (!row) {
      res.status(404).json({ error: 'Файл не найден' });
      return null;
    }
    if (!canModify(req.user, row.owner_id)) {
      res.status(403).json({ error: 'Недостаточно прав' });
      return null;
    }
    return row;
  };

  // --- Upload ---

  router.post(
    '/',
    requireRole('member'),
    upload.fields([{ name: 'file', maxCount: 1 }, { name: 'thumb', maxCount: 1 }]),
    async (req, res, next) => {
      const file = req.files?.file?.[0];
      const thumb = req.files?.thumb?.[0];
      const cleanup = () => {
        for (const f of [file, thumb]) if (f) fs.rm(f.path, { force: true }, () => {});
      };

      try {
        if (!file) return res.status(400).json({ error: 'Файл не передан' });
        // Browsers encode multipart file names as latin1; restore UTF-8 names.
        const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
        const mime = detectMime({ ...file, originalname: originalName });
        if (!mime) {
          cleanup();
          return res.status(415).json({ error: 'Поддерживаются только фото и видео' });
        }
        const kind = mime.startsWith('video/') ? 'video' : 'photo';

        const checksum = await sha256File(file.path);
        const existing = db
          .prepare('SELECT id FROM media WHERE checksum = ? AND size = ? AND deleted_at IS NULL')
          .get(checksum, file.size);
        if (existing) {
          cleanup();
          const row = getMediaRow(db, existing.id, req.user.id);
          return res.status(200).json({ duplicate: true, media: serialize(row) });
        }

        const exif = kind === 'photo' ? await readExif(file.path) : {};
        const takenAt = exif.takenAt || toIsoDate(req.body.takenAt) || new Date().toISOString();

        // Originals are stored under originals/YYYY/MM by capture date.
        const ext = path.extname(originalName).toLowerCase().replace(/[^.a-z0-9]/g, '') || '';
        const relDir = path.join('originals', takenAt.slice(0, 4), takenAt.slice(5, 7));
        const storedPath = path.join(relDir, `${randomToken(12)}${ext}`);
        fs.mkdirSync(path.join(dataDir, relDir), { recursive: true });
        fs.renameSync(file.path, path.join(dataDir, storedPath));

        let thumbPath = null;
        if (thumb && thumb.size > 0 && thumb.size < 10 * 1024 * 1024) {
          thumbPath = path.join('thumbs', `${randomToken(12)}.jpg`);
          fs.mkdirSync(path.join(dataDir, 'thumbs'), { recursive: true });
          fs.renameSync(thumb.path, path.join(dataDir, thumbPath));
        } else if (thumb) {
          fs.rm(thumb.path, { force: true }, () => {});
        }

        const id = db.transaction(() => {
          const { lastInsertRowid } = db
            .prepare(`
              INSERT INTO media (owner_id, kind, original_name, stored_path, thumb_path, mime, size, checksum,
                                 width, height, duration, taken_at, camera, latitude, longitude, title, description)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `)
            .run(
              req.user.id,
              kind,
              originalName,
              storedPath,
              thumbPath,
              mime,
              file.size,
              checksum,
              positiveNumber(req.body.width) || exif.width || null,
              positiveNumber(req.body.height) || exif.height || null,
              positiveNumber(req.body.duration),
              takenAt,
              exif.camera || null,
              exif.latitude ?? null,
              exif.longitude ?? null,
              String(req.body.title || '').slice(0, 200),
              String(req.body.description || '').slice(0, 5000),
            );
          const mediaId = Number(lastInsertRowid);
          if (req.body.albumId) {
            db.prepare('INSERT OR IGNORE INTO album_media (album_id, media_id) SELECT id, ? FROM albums WHERE id = ?')
              .run(mediaId, Number(req.body.albumId));
          }
          return mediaId;
        });

        res.status(201).json({ duplicate: false, media: serialize(getMediaRow(db, id, req.user.id)) });
      } catch (err) {
        cleanup();
        next(err);
      }
    },
  );

  // --- Listing & details ---

  router.get('/', requireAuth, (req, res) => {
    const q = req.query;
    res.json(
      listMedia(db, req.user.id, {
        q: q.q,
        kind: q.kind,
        favorite: q.favorite === '1',
        albumId: q.album,
        labelId: q.label,
        ownerId: q.owner,
        from: q.from,
        to: q.to,
        trash: q.trash === '1',
        sort: q.sort,
        limit: q.limit,
        offset: q.offset,
      }),
    );
  });

  // Photos taken on today's date in previous years.
  router.get('/memories', requireAuth, (req, res) => {
    const now = new Date();
    const monthDay = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const rows = db
      .prepare(`
        SELECT m.*, u.name AS owner_name,
               EXISTS (SELECT 1 FROM favorites f WHERE f.media_id = m.id AND f.user_id = ?) AS favorite
        FROM media m LEFT JOIN users u ON u.id = m.owner_id
        WHERE m.deleted_at IS NULL AND strftime('%m-%d', m.taken_at) = ? AND strftime('%Y', m.taken_at) < ?
        ORDER BY m.taken_at DESC LIMIT 60
      `)
      .all(req.user.id, monthDay, String(now.getFullYear()));
    res.json({ items: rows.map((r) => serialize(r)) });
  });

  router.get('/:id', requireAuth, (req, res) => {
    const row = getMediaRow(db, req.params.id, req.user.id);
    if (!row) return res.status(404).json({ error: 'Файл не найден' });
    const albums = db
      .prepare(`
        SELECT a.id, a.title FROM album_media am JOIN albums a ON a.id = am.album_id
        WHERE am.media_id = ? ORDER BY a.title
      `)
      .all(row.id);
    res.json({
      ...serialize(row),
      ...getLabels(db, row.id),
      albums,
      canEdit: canModify(req.user, row.owner_id),
    });
  });

  router.patch('/:id', requireRole('member'), (req, res) => {
    const row = loadOwned(req, res);
    if (!row) return;
    const body = req.body;
    db.transaction(() => {
      if (typeof body.title === 'string') {
        db.prepare('UPDATE media SET title = ? WHERE id = ?').run(body.title.slice(0, 200), row.id);
      }
      if (typeof body.description === 'string') {
        db.prepare('UPDATE media SET description = ? WHERE id = ?').run(body.description.slice(0, 5000), row.id);
      }
      if (body.takenAt) {
        const iso = toIsoDate(body.takenAt);
        if (iso) db.prepare('UPDATE media SET taken_at = ? WHERE id = ?').run(iso, row.id);
      }
      if (Array.isArray(body.tags)) setLabels(db, row.id, 'tag', body.tags);
      if (Array.isArray(body.people)) setLabels(db, row.id, 'person', body.people);
    });
    const updated = getMediaRow(db, row.id, req.user.id);
    res.json({ ...serialize(updated), ...getLabels(db, row.id), canEdit: true });
  });

  // --- Favorites (personal for each family member) ---

  router.put('/:id/favorite', requireAuth, (req, res) => {
    db.prepare('INSERT OR IGNORE INTO favorites (user_id, media_id) SELECT ?, id FROM media WHERE id = ?')
      .run(req.user.id, Number(req.params.id));
    res.json({ favorite: true });
  });

  router.delete('/:id/favorite', requireAuth, (req, res) => {
    db.prepare('DELETE FROM favorites WHERE user_id = ? AND media_id = ?').run(req.user.id, Number(req.params.id));
    res.json({ favorite: false });
  });

  // --- Trash ---

  router.delete('/:id', requireRole('member'), (req, res) => {
    const row = loadOwned(req, res);
    if (!row) return;
    if (req.query.permanent === '1') {
      purgeMedia(db, dataDir, row);
    } else {
      db.prepare('UPDATE media SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
    }
    res.json({ ok: true });
  });

  router.post('/:id/restore', requireRole('member'), (req, res) => {
    const row = loadOwned(req, res);
    if (!row) return;
    db.prepare('UPDATE media SET deleted_at = NULL WHERE id = ?').run(row.id);
    res.json({ ok: true });
  });

  // Apply one action to many items at once (from multi-select in the UI).
  router.post('/bulk', requireRole('member'), (req, res) => {
    const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger);
    const { action } = req.body;
    let affected = 0;
    let skipped = 0;

    db.transaction(() => {
      for (const id of ids) {
        const row = getMediaRow(db, id, req.user.id);
        if (!row) continue;
        const needsOwnership = ['trash', 'restore', 'delete', 'addTag', 'addPerson'].includes(action);
        if (needsOwnership && !canModify(req.user, row.owner_id)) {
          skipped++;
          continue;
        }
        switch (action) {
          case 'trash':
            db.prepare('UPDATE media SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), id);
            break;
          case 'restore':
            db.prepare('UPDATE media SET deleted_at = NULL WHERE id = ?').run(id);
            break;
          case 'delete':
            purgeMedia(db, dataDir, row);
            break;
          case 'favorite':
            db.prepare('INSERT OR IGNORE INTO favorites (user_id, media_id) VALUES (?, ?)').run(req.user.id, id);
            break;
          case 'unfavorite':
            db.prepare('DELETE FROM favorites WHERE user_id = ? AND media_id = ?').run(req.user.id, id);
            break;
          case 'addToAlbum':
            db.prepare('INSERT OR IGNORE INTO album_media (album_id, media_id) SELECT id, ? FROM albums WHERE id = ?')
              .run(id, Number(req.body.albumId));
            break;
          case 'addTag':
            addLabel(db, id, 'tag', req.body.name || '');
            break;
          case 'addPerson':
            addLabel(db, id, 'person', req.body.name || '');
            break;
          default:
            throw Object.assign(new Error('Неизвестное действие'), { status: 400 });
        }
        affected++;
      }
    });

    res.json({ affected, skipped });
  });

  // --- Comments ---

  router.get('/:id/comments', requireAuth, (req, res) => {
    res.json(
      db
        .prepare(`
          SELECT c.id, c.text, c.created_at AS createdAt, c.user_id AS userId, u.name AS userName
          FROM comments c LEFT JOIN users u ON u.id = c.user_id
          WHERE c.media_id = ? ORDER BY c.created_at
        `)
        .all(Number(req.params.id)),
    );
  });

  router.post('/:id/comments', requireAuth, (req, res) => {
    const text = String(req.body.text || '').trim().slice(0, 2000);
    if (!text) return res.status(400).json({ error: 'Пустой комментарий' });
    if (!getMediaRow(db, req.params.id)) return res.status(404).json({ error: 'Файл не найден' });
    const { lastInsertRowid } = db
      .prepare('INSERT INTO comments (media_id, user_id, text) VALUES (?, ?, ?)')
      .run(Number(req.params.id), req.user.id, text);
    res.status(201).json({
      id: Number(lastInsertRowid),
      text,
      createdAt: new Date().toISOString(),
      userId: req.user.id,
      userName: req.user.name,
    });
  });

  // --- Files ---

  router.get('/:id/file', requireAuth, (req, res) => sendOriginal(db, dataDir, req, res));
  router.get('/:id/thumb', requireAuth, (req, res) => sendThumb(db, dataDir, req, res));

  return router;
};

function sendOriginal(db, dataDir, req, res, row = getMediaRow(db, req.params.id)) {
  if (!row) return res.status(404).json({ error: 'Файл не найден' });
  const file = path.join(dataDir, row.stored_path);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  if (req.query.download === '1') return res.download(file, row.original_name);
  res.type(row.mime);
  res.sendFile(file); // supports Range requests, needed for video seeking
}

function sendThumb(db, dataDir, req, res, row = getMediaRow(db, req.params.id)) {
  if (!row) return res.status(404).json({ error: 'Файл не найден' });
  if (!row.thumb_path) {
    // No preview was generated (e.g. unsupported in the uploader's browser).
    if (row.kind === 'photo') return sendOriginal(db, dataDir, req, res, row);
    return res.status(404).json({ error: 'Нет превью' });
  }
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.type('image/jpeg');
  res.sendFile(path.join(dataDir, row.thumb_path));
}

module.exports.sendOriginal = sendOriginal;
module.exports.sendThumb = sendThumb;
