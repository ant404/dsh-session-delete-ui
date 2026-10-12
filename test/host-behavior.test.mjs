/**
 * Host-half behavior test for dsh-session-delete-ui.
 *
 * Three roots/situations:
 *   A. the real $DSH_HOME/sessions, read-only — plan/preview against the actual
 *      on-disk catalog.
 *   B. an isolated temp root — the destructive path (validate → remove →
 *      projection-cache cleanup) without touching real sessions.
 *   C. the archived-but-resident case: a session the process still holds but
 *      which runs no work must stay deletable, and must keep its archive gate.
 *
 * Run: node test/host-behavior.test.mjs
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
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

function fakeRegistry({ archivedIds = [], memberIds = [] } = {}) {
  const calls = [];
  const state = { archived: new Set(archivedIds), members: [...memberIds] };
  const workspace = {
    sessionIds: state.members,
    async detachSession(id) {
      calls.push(['detach', id]);
      const index = state.members.indexOf(id);
      if (index >= 0) state.members.splice(index, 1);
    },
  };
  return {
    calls,
    archived: state.archived,
    members: state.members,
    get archivedSessionIds() { return [...state.archived]; },
    get pinnedSessionIds() { return []; },
    list() { return [workspace]; },
    async unarchiveSession(id) { calls.push(['unarchive', id]); state.archived.delete(id); },
    async unpinSession(id) { calls.push(['unpin', id]); },
  };
}

/**
 * @param options.residentIds - sessions the process still holds (NOT running).
 * @param options.activeIds - sessions that report running work; a stop request clears them.
 */
function harness({ root, residentIds = [], activeIds = [], registry }) {
  const routes = new Map();
  const resident = new Set(residentIds);
  const active = new Set(activeIds);
  const stops = [];
  const persistence = fakePersistence(root);
  const webServer = {
    register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path); },
  };
  const ctx = {
    webServer,
    get(name) {
      if (name === 'sessionPersistence') return persistence;
      if (name === 'sessions') return { get: (id) => (resident.has(id) ? { id } : undefined), list: () => [...resident] };
      if (name === 'agents') {
        return { get: (id) => (resident.has(id) || active.has(id) ? { id, status: active.has(id) ? 'running' : 'idle' } : undefined) };
      }
      if (name === 'workspaceRegistry') return registry;
      if (name === 'webServer') return webServer;
      return undefined;
    },
    // The host's own archive-admission question.
    async waterfall(name, args, fallback) {
      if (name !== 'workspace/session-activity') return fallback();
      const entries = await fallback();
      return active.has(args.sessionId) ? [{ kind: 'turn' }, ...entries] : entries;
    },
    // Everything a provider would stop.
    async parallel(name, args) {
      if (name !== 'workspace/session-stop') return;
      stops.push(args.sessionId);
      active.delete(args.sessionId);
    },
    effect(callback) { callback(); },
  };
  plugin.apply(ctx);
  return { routes, resident, active, stops, registry };
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

const home = process.env.DSH_HOME || join(homedir(), '.dsh');
const realRoot = join(home, 'sessions');
const real = harness({ root: realRoot });

const health = await call(real.routes.get('/session-delete/api/health'), {});
check('health route answers', health.status === 200 && health.payload.ok === true, JSON.stringify(health.payload));

const badArgs = await call(real.routes.get('/session-delete/api/preview'), { sessionId: '../escape' });
check('path-traversal id is rejected with 400', badArgs.status === 400, JSON.stringify(badArgs.payload));

const missing = await call(real.routes.get('/session-delete/api/preview'), { sessionId: 'session-does-not-exist-0000' });
check('unknown session reports missing with no accounting',
  missing.status === 200 && missing.payload.missing === true && missing.payload.cleanupOnly === true
  && missing.payload.accounting.known === false, JSON.stringify(missing.payload));

const listed = await fakePersistence(realRoot).list();
const ordinary = listed.find((row) => row.header.origin === undefined && row.header.parentSession === undefined);
check('real ordinary session found', ordinary !== undefined);

const ordinaryPreview = await call(real.routes.get('/session-delete/api/preview'), { sessionId: ordinary.header.id });
check('ordinary session is deletable', ordinaryPreview.payload.deletable === true, JSON.stringify(ordinaryPreview.payload));
check('ordinary session resolves inside the sessions root', typeof ordinaryPreview.payload.dir === 'string'
  && ordinaryPreview.payload.dir.toLowerCase().startsWith(realRoot.toLowerCase()), String(ordinaryPreview.payload.dir));
check('a cold session reports active:false and resident:false',
  ordinaryPreview.payload.active === false && ordinaryPreview.payload.resident === false, JSON.stringify(ordinaryPreview.payload));

// The user-visible regression: a resident but idle session must be deletable.
const residentPreview = await call(
  harness({ root: realRoot, residentIds: [ordinary.header.id] }).routes.get('/session-delete/api/preview'),
  { sessionId: ordinary.header.id },
);
check('a resident but idle session stays deletable',
  residentPreview.payload.resident === true && residentPreview.payload.active === false && residentPreview.payload.deletable === true,
  JSON.stringify(residentPreview.payload));

const activePreview = await call(
  harness({ root: realRoot, activeIds: [ordinary.header.id] }).routes.get('/session-delete/api/preview'),
  { sessionId: ordinary.header.id },
);
check('a session with running work is not deletable',
  activePreview.payload.active === true && activePreview.payload.deletable === false, JSON.stringify(activePreview.payload));
check('the running work is reported as an activity family',
  Array.isArray(activePreview.payload.activity) && activePreview.payload.activity.some((entry) => entry.kind === 'turn'),
  JSON.stringify(activePreview.payload.activity));

const parentWithChildren = listed.find((row) => listed.some((child) => child.header.origin === 'subagent'
  && (child.header.parentSession === row.header.id || child.header.parentSession === row.header.id.replace(/^session-/, ''))));
if (parentWithChildren !== undefined) {
  const withFamily = await call(real.routes.get('/session-delete/api/preview'), { sessionId: parentWithChildren.header.id });
  check('a parent lists its subagent family', withFamily.payload.descendants.length > 0,
    `${parentWithChildren.header.id} -> ${JSON.stringify(withFamily.payload.descendants.map((d) => d.id))}`);
} else {
  console.log('  skip parent/family check (no parent with subagent children on disk)');
}

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
const activeId = 'session-55555555-5555-4555-8555-555555555555';
const archivedResidentId = 'session-66666666-6666-4666-8666-666666666666';

function writeFixture(id, header) {
  const dir = join(projectDir, id);
  mkdirSync(dir, { recursive: true });
  // Plain (uncompressed) fixture log: this harness reads headers itself, so the
  // artifact only has to be a file the scanner recognises.
  writeFileSync(join(dir, 'session.jsonl'), `${JSON.stringify(header)}\n`, 'utf8');
}

writeFixture(parentId, { id: parentId, cwd: 'D:\\fixture', createdAt: 1 });
writeFixture(childId, { id: childId, cwd: 'D:\\fixture', createdAt: 2, origin: 'subagent', parentSession: parentId });
writeFixture(grandchildId, { id: grandchildId, cwd: 'D:\\fixture', createdAt: 3, origin: 'subagent', parentSession: childId });
writeFixture(forkId, { id: forkId, cwd: 'D:\\fixture', createdAt: 4, parentSession: parentId });
writeFixture(activeId, { id: activeId, cwd: 'D:\\fixture', createdAt: 5 });
writeFixture(archivedResidentId, { id: archivedResidentId, cwd: 'D:\\fixture', createdAt: 6 });

const registry = fakeRegistry({ archivedIds: [archivedResidentId], memberIds: [archivedResidentId, parentId] });
const fixture = harness({ root: fixtureRoot, activeIds: [activeId], residentIds: [activeId, archivedResidentId], registry });

const family = await call(fixture.routes.get('/session-delete/api/preview'), { sessionId: parentId });
const familyRows = family.payload !== null && Array.isArray(family.payload.descendants) ? family.payload.descendants : [];
check('cascade preview answers ok', family.status === 200 && family.payload !== null && family.payload.ok === true, JSON.stringify(family.payload));
check('cascade lists child and grandchild, not the fork', familyRows.length === 2
  && familyRows.some((d) => d.id === childId)
  && familyRows.some((d) => d.id === grandchildId)
  && !familyRows.some((d) => d.id === forkId),
JSON.stringify(family.payload));

// Running work is refused until the caller asks to stop it.
const refused = await call(fixture.routes.get('/session-delete/api/delete'), { sessionId: activeId });
check('a running session is refused with code active', refused.status === 409 && refused.payload.code === 'active', JSON.stringify(refused.payload));
check('the refused session is still on disk', statSync(join(projectDir, activeId)).isDirectory());

// The stopped path: stopActivity clears the work and the delete proceeds.
const stopped = await call(fixture.routes.get('/session-delete/api/delete'), { sessionId: activeId, stopActivity: true });
check('stop-and-delete asks every provider to stop', fixture.stops.includes(activeId), JSON.stringify(fixture.stops));
check('stop-and-delete removes the session', stopped.status === 200 && stopped.payload.deleted.includes(activeId), JSON.stringify(stopped.payload));

// The archived-but-resident case still deletes, and its archive mark is cleared.
const archivedResidentDelete = await call(fixture.routes.get('/session-delete/api/delete'), { sessionId: archivedResidentId, stopActivity: true });
check('an archived resident session deletes', archivedResidentDelete.status === 200
  && archivedResidentDelete.payload.deleted.includes(archivedResidentId), JSON.stringify(archivedResidentDelete.payload));
check('the deleted archived resident session is gone from disk', !readdirSync(projectDir).includes(archivedResidentId));
check('a deleted session always clears its archive mark',
  registry.calls.some((call_) => call_[0] === 'unarchive' && call_[1] === archivedResidentId), JSON.stringify(registry.calls));
check('a resident session is detached from workspace accounting',
  registry.calls.some((call_) => call_[0] === 'detach' && call_[1] === archivedResidentId), JSON.stringify(registry.calls));

// The reported dead end: the log is already gone, but the session is still
// open in this process and still archived. It must be cleanable, not a refusal.
const ghostId = 'session-77777777-7777-4777-8777-777777777777';
const ghostRegistry = fakeRegistry({ archivedIds: [ghostId], memberIds: [ghostId] });
const ghost = harness({ root: fixtureRoot, residentIds: [ghostId], registry: ghostRegistry });

const ghostPreview = await call(ghost.routes.get('/session-delete/api/preview'), { sessionId: ghostId });
check('a ghost row previews as missing but resident',
  ghostPreview.payload.missing === true && ghostPreview.payload.resident === true, JSON.stringify(ghostPreview.payload));
check('a ghost row reports its leftover accounting',
  ghostPreview.payload.accounting.known === true && ghostPreview.payload.accounting.archived === true
  && ghostPreview.payload.accounting.member === true, JSON.stringify(ghostPreview.payload.accounting));
check('a ghost row is no longer a dead end', ghostPreview.payload.deletable === true
  && ghostPreview.payload.cleanupOnly === true, JSON.stringify(ghostPreview.payload));

const ghostDelete = await call(ghost.routes.get('/session-delete/api/delete'), { sessionId: ghostId, stopActivity: true });
check('deleting a ghost row succeeds as a cleanup', ghostDelete.status === 200
  && ghostDelete.payload.ok === true && ghostDelete.payload.cleanupOnly === true, JSON.stringify(ghostDelete.payload));
check('the cleanup reports what it cleared', Array.isArray(ghostDelete.payload.cleaned)
  && ghostDelete.payload.cleaned.some((entry) => entry.id === ghostId && entry.archived === true && entry.member === true),
JSON.stringify(ghostDelete.payload.cleaned));
check('the ghost id leaves the archive set', !ghostRegistry.archived.has(ghostId), JSON.stringify([...ghostRegistry.archived]));
check('the ghost id leaves the workspace', !ghostRegistry.members.includes(ghostId), JSON.stringify(ghostRegistry.members));

const deleteColdMissing = await call(ghost.routes.get('/session-delete/api/delete'), { sessionId: 'session-absent-0000' });
check('a truly unknown session still reports 404', deleteColdMissing.status === 404
  && deleteColdMissing.payload.code === 'missing', JSON.stringify(deleteColdMissing.payload));

const deleted = await call(fixture.routes.get('/session-delete/api/delete'), { sessionId: parentId, includeDescendants: true });
check('delete removes the session and its subagent family', deleted.status === 200 && deleted.payload.ok === true
  && deleted.payload.deleted.includes(parentId)
  && deleted.payload.deleted.includes(childId)
  && deleted.payload.deleted.includes(grandchildId), JSON.stringify(deleted.payload));
check('a cold session clears its archive mark (unarchive called)',
  registry.calls.some((call_) => call_[0] === 'unarchive' && call_[1] === parentId) === false, 'parent was never archived');
check('the fork survives the cascade', statSync(join(projectDir, forkId)).isDirectory());
check('survivors are exactly the fork', readdirSync(projectDir).join(',') === forkId, readdirSync(projectDir).join(','));

const again = await call(fixture.routes.get('/session-delete/api/delete'), { sessionId: parentId });
check('a second delete reports missing with 404', again.status === 404 && again.payload.code === 'missing', JSON.stringify(again.payload));

rmSync(join(fixtureRoot, '..'), { recursive: true, force: true });

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
