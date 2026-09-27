'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server/app');

// 1x1 transparent PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

let server;
let baseUrl;
let dataDir;
let app;

// Minimal cookie-keeping client for one family member.
function client() {
  let cookie = '';
  const call = async (method, url, body) => {
    const headers = cookie ? { cookie } : {};
    let payload;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(baseUrl + url, { method, headers, body: payload });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data, headers: res.headers };
  };
  const upload = (name, bytes, extra = {}) => {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'image/png' }), name);
    for (const [k, v] of Object.entries(extra)) form.append(k, v);
    return call('POST', '/api/media', form);
  };
  return { call, upload };
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'family-album-'));
  app = createApp({ dataDir });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  app.locals.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const admin = client();
const member = client();
const viewer = client();
const guest = client();

test('first user becomes admin, others need an invite', async () => {
  let res = await admin.call('GET', '/api/auth/status');
  assert.equal(res.data.needsSetup, true);

  res = await admin.call('POST', '/api/auth/register', { name: 'Мама', email: 'mama@example.com', password: 'secret1' });
  assert.equal(res.status, 201);
  assert.equal(res.data.user.role, 'admin');

  res = await member.call('POST', '/api/auth/register', { name: 'Папа', email: 'papa@example.com', password: 'secret1' });
  assert.equal(res.status, 403);

  const invite = await admin.call('POST', '/api/auth/invites', { role: 'member' });
  res = await member.call('POST', '/api/auth/register', {
    name: 'Папа', email: 'papa@example.com', password: 'secret1', invite: invite.data.code,
  });
  assert.equal(res.status, 201);
  assert.equal(res.data.user.role, 'member');

  // Invites are single-use.
  res = await guest.call('POST', '/api/auth/register', {
    name: 'X', email: 'x@example.com', password: 'secret1', invite: invite.data.code,
  });
  assert.equal(res.status, 403);

  const viewerInvite = await admin.call('POST', '/api/auth/invites', { role: 'viewer' });
  res = await viewer.call('POST', '/api/auth/register', {
    name: 'Бабушка', email: 'baba@example.com', password: 'secret1', invite: viewerInvite.data.code,
  });
  assert.equal(res.data.user.role, 'viewer');
});

test('login and logout', async () => {
  const c = client();
  let res = await c.call('POST', '/api/auth/login', { email: 'mama@example.com', password: 'wrong' });
  assert.equal(res.status, 401);
  res = await c.call('POST', '/api/auth/login', { email: 'MAMA@example.com', password: 'secret1' });
  assert.equal(res.status, 200);
  assert.equal((await c.call('GET', '/api/auth/status')).data.user.name, 'Мама');
  await c.call('POST', '/api/auth/logout');
  assert.equal((await c.call('GET', '/api/media')).status, 401);
});

let photoId;

test('upload, dedupe and fetch files', async () => {
  let res = await member.upload('море.png', PNG, { takenAt: '2020-07-15T10:00:00Z', width: '1', height: '1' });
  assert.equal(res.status, 201);
  assert.equal(res.data.duplicate, false);
  assert.equal(res.data.media.kind, 'photo');
  assert.equal(res.data.media.name, 'море.png');
  assert.equal(res.data.media.takenAt, '2020-07-15T10:00:00.000Z');
  photoId = res.data.media.id;

  res = await member.upload('копия.png', PNG);
  assert.equal(res.data.duplicate, true);
  assert.equal(res.data.media.id, photoId);

  res = await viewer.upload('other.png', Buffer.concat([PNG, Buffer.from([0])]));
  assert.equal(res.status, 403, 'viewers cannot upload');

  const form = new FormData();
  form.append('file', new Blob(['hello'], { type: 'text/plain' }), 'notes.txt');
  res = await member.call('POST', '/api/media', form);
  assert.equal(res.status, 415);

  res = await viewer.call('GET', `/api/media/${photoId}/file`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.data, PNG);

  res = await guest.call('GET', `/api/media/${photoId}/file`);
  assert.equal(res.status, 401);
});

test('edit metadata, tags and people; permission checks', async () => {
  let res = await member.call('PATCH', `/api/media/${photoId}`, {
    title: 'Отпуск на море',
    tags: ['море', 'лето'],
    people: ['Бабушка', 'Дедушка'],
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.data.tags.map((t) => t.name).sort(), ['лето', 'море']);
  assert.equal(res.data.people.length, 2);

  res = await viewer.call('PATCH', `/api/media/${photoId}`, { title: 'x' });
  assert.equal(res.status, 403);

  res = await admin.call('PATCH', `/api/media/${photoId}`, { description: 'Сочи' });
  assert.equal(res.status, 200, 'admin can edit anything');

  res = await admin.call('GET', '/api/labels?kind=person');
  assert.equal(res.data.length, 2);
});

test('search and filters', async () => {
  await member.upload('зима.png', Buffer.concat([PNG, Buffer.from([1])]), { takenAt: '2021-01-02T10:00:00Z' });

  let res = await viewer.call('GET', '/api/media');
  assert.equal(res.data.total, 2);
  assert.equal(res.data.items[0].name, 'зима.png', 'newest first');

  res = await viewer.call('GET', `/api/media?q=${encodeURIComponent('Дедушка')}`);
  assert.equal(res.data.total, 1);

  res = await viewer.call('GET', '/api/media?from=2020-07-15&to=2020-07-15');
  assert.equal(res.data.total, 1);

  res = await viewer.call('GET', '/api/media?kind=video');
  assert.equal(res.data.total, 0);
});

test('favorites are personal', async () => {
  await viewer.call('PUT', `/api/media/${photoId}/favorite`);
  let res = await viewer.call('GET', '/api/media?favorite=1');
  assert.equal(res.data.total, 1);
  res = await member.call('GET', '/api/media?favorite=1');
  assert.equal(res.data.total, 0);
});

test('comments', async () => {
  let res = await viewer.call('POST', `/api/media/${photoId}/comments`, { text: 'Какие красивые!' });
  assert.equal(res.status, 201);
  res = await member.call('GET', `/api/media/${photoId}/comments`);
  assert.equal(res.data[0].userName, 'Бабушка');
});

test('albums and public sharing', async () => {
  let res = await member.call('POST', '/api/albums', { title: 'Лето 2020', mediaIds: [photoId] });
  assert.equal(res.status, 201);
  const album = res.data;
  assert.equal(album.count, 1);
  assert.equal(album.coverId, photoId);

  res = await viewer.call('POST', '/api/albums', { title: 'x' });
  assert.equal(res.status, 403);

  res = await member.call('POST', `/api/albums/${album.id}/share`);
  const token = res.data.shareToken;
  assert.ok(token);

  res = await guest.call('GET', `/api/shared/${token}`);
  assert.equal(res.status, 200);
  assert.equal(res.data.album.title, 'Лето 2020');
  assert.equal(res.data.items.length, 1);
  assert.equal(res.data.items[0].ownerId, undefined);

  res = await guest.call('GET', res.data.items[0].fileUrl);
  assert.equal(res.status, 200);

  // Items outside the album are not reachable through the link.
  const other = (await member.call('GET', '/api/media?q=' + encodeURIComponent('зима'))).data.items[0];
  res = await guest.call('GET', `/api/shared/${token}/media/${other.id}/file`);
  assert.equal(res.status, 404);

  await member.call('DELETE', `/api/albums/${album.id}/share`);
  res = await guest.call('GET', `/api/shared/${token}`);
  assert.equal(res.status, 404);
});

test('trash, restore and permanent delete', async () => {
  let res = await member.call('DELETE', `/api/media/${photoId}`);
  assert.equal(res.status, 200);
  assert.equal((await member.call('GET', '/api/media')).data.total, 1);
  assert.equal((await member.call('GET', '/api/media?trash=1')).data.total, 1);

  await member.call('POST', `/api/media/${photoId}/restore`);
  assert.equal((await member.call('GET', '/api/media')).data.total, 2);

  res = await member.call('POST', '/api/media/bulk', { ids: [photoId], action: 'trash' });
  assert.equal(res.data.affected, 1);

  const stored = app.locals.db.prepare('SELECT stored_path FROM media WHERE id = ?').get(photoId).stored_path;
  assert.ok(fs.existsSync(path.join(dataDir, stored)));
  await member.call('DELETE', `/api/media/${photoId}?permanent=1`);
  assert.equal((await member.call('GET', '/api/media?trash=1')).data.total, 0);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fs.existsSync(path.join(dataDir, stored)), false);
});

test('stats', async () => {
  const res = await viewer.call('GET', '/api/stats');
  assert.equal(res.data.photos, 1);
  assert.equal(res.data.videos, 0);
  assert.equal(res.data.albums, 1);
});
