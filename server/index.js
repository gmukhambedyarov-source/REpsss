'use strict';

const { createApp } = require('./app');

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '0.0.0.0';
const app = createApp();

app.listen(port, host, () => {
  console.log(`Семейный альбом запущен: http://localhost:${port}`);
  console.log(`Данные хранятся в: ${app.locals.config.dataDir}`);
});
