'use strict';

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const multer = require('multer');
const { openDatabase } = require('./db');
const { sessionMiddleware } = require('./auth');
const { purgeMedia } = require('./media-helpers');

const TRASH_DAYS = 30;

function createApp(options = {}) {
  const config = {
    dataDir: path.resolve(options.dataDir || process.env.DATA_DIR || path.join(__dirname, '..', 'data')),
    maxUploadBytes: (options.maxUploadMb || Number(process.env.MAX_UPLOAD_MB) || 4096) * 1024 * 1024,
  };
  fs.mkdirSync(path.join(config.dataDir, 'tmp'), { recursive: true });

  const db = openDatabase(options.dbFile || path.join(config.dataDir, 'album.db'));
  const app = express();

  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);
  app.use(express.json({ limit: '1mb' }));
  app.use(sessionMiddleware(db));

  app.use('/api/auth', require('./routes/auth')(db));
  app.use('/api/media', require('./routes/media')(db, config));
  app.use('/api/albums', require('./routes/albums')(db));
  app.use('/api', require('./routes/library')(db, config));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Не найдено' }));

  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.use((err, _req, res, _next) => {
    if (err instanceof multer.MulterError) {
      const message = err.code === 'LIMIT_FILE_SIZE' ? 'Файл слишком большой' : err.message;
      return res.status(413).json({ error: message });
    }
    if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  });

  // Items stay in the trash for TRASH_DAYS, then are removed for good.
  const purgeTrash = () => {
    const cutoff = new Date(Date.now() - TRASH_DAYS * 86400e3).toISOString();
    const rows = db.prepare('SELECT * FROM media WHERE deleted_at IS NOT NULL AND deleted_at < ?').all(cutoff);
    for (const row of rows) purgeMedia(db, config.dataDir, row);
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
  };
  purgeTrash();
  const timer = setInterval(purgeTrash, 6 * 3600e3);
  timer.unref();

  app.locals.db = db;
  app.locals.config = config;
  app.locals.close = () => {
    clearInterval(timer);
    db.close();
  };
  return app;
}

module.exports = { createApp };
