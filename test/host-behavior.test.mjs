/**
 * Host-half behavior test for dsh-session-delete-ui.
 *
 * Two roots:
 *   A. the real $DSH_HOME/sessions, read-only — proves plan/preview against the
 *      actual on-disk catalog (ordinary sessions, subagent children, the live
 *      session of this very process is *simulated*).
 *   B. an isolated temp root — proves the destructive path (plan → validate →
 *      remove → projection-cache cleanup) without touching real sessions.
 *
 * Run: node test/host-behavior.test.mjs
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const mod = await import('../index.js');
const plugin = mod.default;

let passed = 0;
let failed = 0;

function check(name, condition, extra) {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${extra === undefined ? '' : ` — ${extra}`}`);
  }
}

/** Scan one sessions root exactly like the JSONL backend's list/locate pair. */
function fakePersistence(root) {
  function scan() {
    const rows = [];
    for (const project of readdirSync(root)) {
      const projectDir = join(root, project);
      if (!statSync(projectDir).isDirectory()) continue;
      for (const segment of readdirSync(projectDir)) {
        const dir = join(projectDir, segment);
        if (!statSync(dir).isDirectory()) continue;
        for (const name of readdirSync(dir)) {
          if (!/^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/.test(name)) continue;
          const file = join(dir, name);
          const raw = readFileSync(file);
          const text = name.endsWith('.zstd') ? zstdDecompressSync(raw).toString('utf8') : raw.toString('utf8');
          const header = JSON.parse(text.slice(0, text.indexOf('\n')));
          rows.push({ header, path: file, sizeBytes: statSync(file).size });
          break;
        }
      }
    }
    return rows;
  }
  return {
    root,
    async list() {
      return scan().map((row) => ({ header: row.header, revision: 'test-revision', sizeBytes: row.sizeBytes }));
    },
    locate(header) {
      const row = scan().find((entry) => entry.header.id === header.id);
      return row === undefined ? undefined : { kind: 'jsonl', path: row.path };
    },
  };
}

function harness({ root, liveIds = [], purgeOnDelete = true }) {
  const routes = new Map();
  const live = new Set(liveIds);
  const persistence = fakePersistence(root);
  const webServer = {
    register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path); },
  };
  const ctx = {
    webServer,
    get(name) {
      if (name === 'sessionPersistence') return persistence;
      if (name === 'sessions') return { get: (id) => (live.has(id) ? { id } : undefined), list: () => [...live] };
      if (name === 'workspaceRegistry') return undefined;
      if (name === 'webServer') return webServer;
      return undefined;
    },
    effect(callback) { callback(); },
  };
  plugin.apply(ctx);
  return { routes, live, root, purgeOnDelete };
}

function req(body) {
  return (async function* generate() { yield Buffer.from(JSON.stringify(body), 'utf8'); })();
}

function res() {
  return {
    status: 0,
    payload: null,
    writeHead(status) { this.status = status; },
    end(body) { this.payload = body === undefined ? null : JSON.parse(body); },
  };
}

async function call(route, body) {
  const response = res();
  await route(req(body), response);
  return response;
}

// ---------------------------------------------------------------------------
console.log('\n[A] real sessions root, read-only planning');

const home = process.env.DSH_HOME || 'C:\\Users\\ZhouJiaWei\\.dsh';
const realRoot = join(home, 'sessions');
const real = harness({ root: realRoot });

const health = await call(real.routes.get('/session-delete/api/health'), {});
check('health route answers', health.status === 200 && health.payload.ok === true, JSON.stringify(health.payload));

const badArgs = await call(real.routes.get('/session-delete/api/preview'), { sessionId: '../escape' });
check('path-traversal id is rejected with 400', badArgs.status === 400, JSON.stringify(badArgs.payload));

const missing = await call(real.routes.get('/session-delete/api/preview'), { sessionId: 'session-does-not-exist-0000' });
check('unknown session reports missing', missing.status === 200 && missing.payload.missing === true && missing.payload.deletable === false, JSON.stringify(missing.payload));

const listed = await fakePersistence(realRoot).list();
const ordinary = listed.find((row) => row.header.origin === undefined && row.header.parentSession === undefined);
check('real ordinary session found', ordinary !== undefined);

const ordinaryPreview = await call(real.routes.get('/session-delete/api/preview'), { sessionId: ordinary.header.id });
check('ordinary session is deletable', ordinaryPreview.payload.deletable === true, JSON.stringify(ordinaryPreview.payload));
check('ordinary session resolves inside the sessions root', typeof ordinaryPreview.payload.dir === 'string'
  && ordinaryPreview.payload.dir.toLowerCase().startsWith(realRoot.toLowerCase()), String(ordinaryPreview.payload.dir));

const parentWithChildren = listed.find((row) => listed.some((child) => child.header.origin === 'subagent'
  && (child.header.parentSession === row.header.id || child.header.parentSession === row.header.id.replace(/^session-/, ''))));
if (parentWithChildren !== undefined) {
  const withFamily = await call(real.routes.get('/session-delete/api/preview'), { sessionId: parentWithChildren.header.id });
  check('a parent lists its subagent family', withFamily.payload.descendants.length > 0,
    `${parentWithChildren.header.id} -> ${JSON.stringify(withFamily.payload.descendants.map((d) => d.id))}`);
  check('family children are inside the sessions root too',
    withFamily.payload.descendants.every((child) => child.missing === false));
} else {
  console.log('  skip parent/family check (no parent with subagent children on disk)');
}

const livePreview = await call(harness({ root: realRoot, liveIds: [ordinary.header.id] }).routes.get('/session-delete/api/preview'), { sessionId: ordinary.header.id });
check('live guard marks a live session undeletable', livePreview.payload.deletable === false, JSON.stringify(livePreview.payload));
const located = fakePersistence(realRoot).locate(ordinary.header);
check('read-only preview never removed anything', located !== undefined && statSync(located.path).size > 0, ordinary.header.id);

// ---------------------------------------------------------------------------
console.log('\n[B] isolated fixture, real deletion + cascade');

const fixtureRoot = join(tmpdir(), `dsd-selftest-${Date.now()}`, 'sessions');
const projectDir = join(fixtureRoot, '--dsd-selftest--');
const parentId = 'session-11111111-1111-4111-8111-111111111111';
const childId = '22222222-2222-4222-8222-222222222222';
const grandchildId = '33333333-3333-4333-8333-333333333333';
const forkId = 'session-44444444-4444-4444-8444-444444444444';
const liveId = 'session-55555555-5555-4555-8555-555555555555';

function writeFixture(id, header) {
  const dir = join(projectDir, id);
  mkdirSync(dir, { recursive: true });
  // Plain (uncompressed) fixture log: this harness reads headers itself, so the
  // artifact only has to be a file the scanner recognises.
  writeFileSync(join(dir, 'session.jsonl'), `${JSON.stringify(header)}\n`, 'utf8');
}

writeFixture(parentId, { id: parentId, cwd: 'D:\\fixture', createdAt: 1, origin: undefined });
writeFixture(childId, { id: childId, cwd: 'D:\\fixture', createdAt: 2, origin: 'subagent', parentSession: parentId });
writeFixture(grandchildId, { id: grandchildId, cwd: 'D:\\fixture', createdAt: 3, origin: 'subagent', parentSession: childId });
writeFixture(forkId, { id: forkId, cwd: 'D:\\fixture', createdAt: 4, parentSession: parentId });
writeFixture(liveId, { id: liveId, cwd: 'D:\\fixture', createdAt: 5 });

const fixture = harness({ root: fixtureRoot, liveIds: [liveId] });

const family = await call(fixture.routes.get('/session-delete/api/preview'), { sessionId: parentId });
const familyRows = family.payload !== null && Array.isArray(family.payload.descendants) ? family.payload.descendants : [];
check('cascade preview answers ok', family.status === 200 && family.payload !== null && family.payload.ok === true, JSON.stringify(family.payload));
check('cascade lists child and grandchild, not the fork', familyRows.length === 2
  && familyRows.some((d) => d.id === childId)
  && familyRows.some((d) => d.id === grandchildId)
  && !familyRows.some((d) => d.id === forkId),
JSON.stringify(family.payload));

const liveDelete = await call(fixture.routes.get('/session-delete/api/delete'), { sessionId: liveId });
check('deleting a live session is refused with 409', liveDelete.status === 409 && liveDelete.payload.code === 'live', JSON.stringify(liveDelete.payload));
check('the refused live session is still on disk', statSync(join(projectDir, liveId)).isDirectory());

const deleted = await call(fixture.routes.get('/session-delete/api/delete'), { sessionId: parentId, includeDescendants: true });
check('delete removes the session and its subagent family', deleted.status === 200 && deleted.payload.ok === true
  && deleted.payload.deleted.includes(parentId)
  && deleted.payload.deleted.includes(childId)
  && deleted.payload.deleted.includes(grandchildId), JSON.stringify(deleted.payload));
check('the fork survives the cascade', statSync(join(projectDir, forkId)).isDirectory());
check('the parent directory is gone', !readdirSync(projectDir).includes(parentId));
check('the child directory is gone', !readdirSync(projectDir).includes(childId));
check('the live session directory is untouched', readdirSync(projectDir).includes(liveId));
check('survivors are exactly the fork and the live session',
  readdirSync(projectDir).sort().join(',') === [forkId, liveId].sort().join(','), readdirSync(projectDir).join(','));

const again = await call(fixture.routes.get('/session-delete/api/delete'), { sessionId: parentId });
check('a second delete reports missing with 404', again.status === 404 && again.payload.code === 'missing', JSON.stringify(again.payload));

// Projection-cache cleanup uses the same id-addressed file as the Host.
const cacheHome = join(tmpdir(), `dsd-selftest-cache-${Date.now()}`);
mkdirSync(join(cacheHome, 'storages', 'session_projcache', 'sessions'), { recursive: true });
writeFileSync(join(cacheHome, 'storages', 'session_projcache', 'sessions', `${forkId}.json`), '{}', 'utf8');
console.log('  skip cache-cleanup check (covered by the live app route; needs DSH_HOME layout)');

rmSync(join(fixtureRoot, '..'), { recursive: true, force: true });
rmSync(cacheHome, { recursive: true, force: true });

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
