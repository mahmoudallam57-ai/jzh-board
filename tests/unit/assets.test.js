import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pub = join(root, 'public');
const INDEX_SHA256 = '033d06588bf0e6b280b5f909118d7d1fe0b6921c96ea5a4828b7b92ec9a4471d';

test('public/index.html matches the v27 page hash', () => {
  const buf = readFileSync(join(pub, 'index.html'));
  assert.equal(createHash('sha256').update(buf).digest('hex'), INDEX_SHA256);
});

test('every img/<file> referenced in index.html exists in public/img', () => {
  const html = readFileSync(join(pub, 'index.html'), 'utf8');
  const refs = new Set([...html.matchAll(/img\/([A-Za-z0-9_.\-]+\.(?:jpg|jpeg|png|webp|gif|svg))/gi)].map((m) => m[1]));
  assert.ok(refs.size > 0, 'expected image references in index.html');
  const missing = [...refs].filter((f) => !existsSync(join(pub, 'img', f)));
  assert.deepEqual(missing, []);
});

test('public/video.mp4 exists and is larger than 1 MB', () => {
  const p = join(pub, 'video.mp4');
  assert.ok(existsSync(p), 'video.mp4 missing');
  assert.ok(statSync(p).size > 1024 * 1024, 'video.mp4 should be > 1 MB');
});
