/**
 * Client-half behavior test for dsh-session-delete-ui.
 *
 * The browser bundle is a `window.__ModuleLoader__` factory; this harness
 * installs a loader shim plus a minimal React shim, so the real component
 * functions and the real `apply` body execute. That catches the failure mode
 * that matters for a slot contribution: a component that throws (the host
 * reports `slot entry crashed` and the row disappears).
 *
 * Run: node test/client-render.test.mjs
 */

let registeredFactory = null;
globalThis.window = {
  __ModuleLoader__: {
    load(spec) { registeredFactory = spec.factory; },
  },
  addEventListener() {},
  removeEventListener() {},
};

const module = await import('../client.js');

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

// --------------------------------------------------------------------------
// Minimal React shim: element trees + hook state, no DOM.

function flat(children, out) {
  for (const child of children) {
    if (Array.isArray(child)) flat(child, out);
    else if (child === null || child === undefined || child === false || child === true) continue;
    else out.push(child);
  }
  return out;
}

function makeReact() {
  let cursor = 0;
  let cells = [];
  const react = {
    Fragment: Symbol('Fragment'),
    /** Simulate a fresh mount: hook cells and cursor both restart. */
    __resetHooks() { cursor = 0; cells = []; },
    createElement(type, props, ...children) {
      const next = {};
      if (props !== null && props !== undefined) for (const key of Object.keys(props)) next[key] = props[key];
      const kids = flat(children, []);
      if (kids.length === 1) next.children = kids[0];
      else if (kids.length > 1) next.children = kids;
      return { type, props: next };
    },
    useState(initial) {
      const index = cursor;
      cursor += 1;
      if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial;
      return [cells[index], (value) => { cells[index] = typeof value === 'function' ? value(cells[index]) : value; }];
    },
    useEffect() { cursor += 1; },
    useRef(initial) {
      const index = cursor;
      cursor += 1;
      if (!(index in cells)) cells[index] = { current: initial === undefined ? null : initial };
      return cells[index];
    },
  };
  return react;
}

/** Collect every string rendered in a tree, plus elements by role/tag. */
function walk(node, strings, elements) {
  if (node === null || node === undefined || typeof node === 'boolean') return;
  if (typeof node === 'string' || typeof node === 'number') {
    strings.push(String(node));
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) walk(child, strings, elements);
    return;
  }
  if (typeof node.type === 'function') {
    walk(node.type(node.props), strings, elements);
    return;
  }
  elements.push(node);
  walk(node.props.children, strings, elements);
}

function render(Component, props) {
  const strings = [];
  const elements = [];
  walk(React.createElement(Component, props), strings, elements);
  return { text: strings.join(' | '), elements };
}

const React = makeReact();

// --------------------------------------------------------------------------
// Load the plugin through the documented client contract.

check('the bundle registers one factory for the package id', registeredFactory !== null);
const client = registeredFactory((name) => {
  if (name === 'react') return React;
  throw new Error(`unexpected require(${name})`);
});
check('the client half injects slots and locale', Array.isArray(client.inject)
  && client.inject.includes('slots') && client.inject.includes('locale'), JSON.stringify(client.inject));

const registrations = [];
const slots = {
  inject(name, callback) { check(`slots.inject uses ctx.slots.inject for ${name}`, typeof callback === 'function'); callback(); },
  register(options, Component) { registrations.push({ options, Component }); return () => {}; },
};
const dicts = [];
const locale = { register(namespace, dictionaries) { dicts.push({ namespace, dictionaries }); return () => {}; } };
const refreshed = [];
const sessions = { refresh() { refreshed.push(true); return Promise.resolve(); } };
const ctx = {
  get(name) {
    if (name === 'slots') return slots;
    if (name === 'locale') return locale;
    if (name === 'sessions') return sessions;
    return undefined;
  },
  effect(callback) { callback(); },
};
client.apply(ctx);

check('two slot registrations were made', registrations.length === 2, String(registrations.length));
const menu = registrations.find((entry) => entry.options.name === 'sidebar.workspaces.session.menu.item');
const overlay = registrations.find((entry) => entry.options.name === 'shell.overlay');
check('menu entry targets the session row menu', menu !== undefined);
check('menu entry lands after the shipped Archive row (order 500)', menu.options.order === 500, String(menu.options.order));
check('menu entry has a stable slot id', menu.options.id === 'session-delete');
check('overlay entry targets shell.overlay', overlay !== undefined);
check('both entries declare the plugin locale namespace', menu.options.locale === 'dsh-session-delete-ui' && overlay.options.locale === 'dsh-session-delete-ui');
check('dictionaries registered for zh and en', dicts.length === 1 && dicts[0].dictionaries.zh !== undefined && dicts[0].dictionaries.en !== undefined);

// --------------------------------------------------------------------------
console.log('\nmenu row');

const injected = menu.options.inject();
check('menu inject exposes requestDelete', typeof injected.requestDelete === 'function');

React.__resetHooks();
const menuView = render(menu.Component, {
  sessionId: 'session-1',
  displayTitle: 'My session',
  useMenuOpenState: () => [false, () => {}],
  requestDelete: injected.requestDelete,
  t: (key) => key,
});
const menuButton = menuView.elements.find((element) => element.type === 'button');
check('the row renders one button', menuButton !== undefined);
check('the row is a menu item', menuButton.props.role === 'menuitem');
check('the row shows the delete label', menuView.text.includes('menu.delete'), menuView.text);
check('the row draws its own stylesheet once', menuView.elements.some((element) => element.type === 'style'));

React.__resetHooks();
const withoutLocale = render(menu.Component, {
  sessionId: 'session-1',
  displayTitle: 'My session',
  requestDelete: injected.requestDelete,
});
check('the row survives a missing locale seat', withoutLocale.text.includes('menu.delete'), withoutLocale.text);

// --------------------------------------------------------------------------
console.log('\ndialog');

let fetchCalls = [];
let fetchReply = { ok: true, status: 200, json: async () => ({ ok: true, active: false, resident: false, missing: false, deletable: true, sizeBytes: 2048, descendants: [], activity: [] }) };
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null });
  return fetchReply;
};

const overlayProps = overlay.options.inject();
React.__resetHooks();
check('the overlay renders nothing while idle', render(overlay.Component, {
  ...overlayProps, t: (key, params) => (params === undefined ? key : `${key}(${JSON.stringify(params)})`),
}).text === '');

overlayProps.store.set(null);
await injected.requestDelete('session-1', 'My session');
await new Promise((resolve) => setTimeout(resolve, 0));
check('the menu action asks the Host for a preview first',
  fetchCalls.length === 1 && fetchCalls[0].url.endsWith('/session-delete/api/preview') && fetchCalls[0].body.sessionId === 'session-1',
  JSON.stringify(fetchCalls));

React.__resetHooks();
const dialog = render(overlay.Component, {
  ...overlayProps, t: (key, params) => (params === undefined ? key : `${key}(${JSON.stringify(params)})`),
});
check('the dialog names the session', dialog.text.includes('My session'), dialog.text);
check('the dialog states the deletion is permanent', dialog.text.includes('dialog.warning'));
check('the dialog offers cancel and delete', dialog.text.includes('dialog.cancel') && dialog.text.includes('dialog.confirm'));
const dialogElement = dialog.elements.find((element) => element.props.role === 'dialog');
check('the dialog is a modal dialog', dialogElement !== undefined && dialogElement.props['aria-modal'] === 'true');
const confirmButton = dialog.elements.filter((element) => element.type === 'button')
  .find((element) => String(element.props.className).includes('dsd_danger'));
check('the delete button is enabled for a deletable session', confirmButton.props.disabled === false);
check('the dialog reports the size it will free', dialog.text.includes('2048') || dialog.text.includes('2.0 KB'), dialog.text);

// The reported regression: resident but idle must not be refused.
fetchReply = { ok: true, status: 200, json: async () => ({ ok: true, active: false, resident: true, missing: false, deletable: true, sizeBytes: 10, descendants: [], activity: [] }) };
await injected.requestDelete('session-resident', 'Archived but resident');
await new Promise((resolve) => setTimeout(resolve, 0));
React.__resetHooks();
const residentDialog = render(overlay.Component, {
  ...overlayProps, t: (key, params) => (params === undefined ? key : `${key}(${JSON.stringify(params)})`),
});
const residentConfirm = residentDialog.elements.filter((element) => element.type === 'button')
  .find((element) => String(element.props.className).includes('dsd_danger'));
check('a resident but idle session can be confirmed', residentConfirm.props.disabled === false);
check('the dialog explains residency without claiming it is running',
  residentDialog.text.includes('dialog.resident') && !residentDialog.text.includes('dialog.activity.title'), residentDialog.text);
check('a resident but idle session keeps the plain delete label', residentDialog.text.includes('dialog.confirm'), residentDialog.text);

// An older Host half (which only knows `live`) is named, not echoed.
fetchReply = { ok: true, status: 200, json: async () => ({ ok: true, live: true, missing: false, deletable: false, sizeBytes: 10, descendants: [] }) };
await injected.requestDelete('session-old-host', 'Old host half');
await new Promise((resolve) => setTimeout(resolve, 0));
React.__resetHooks();
const outdatedDialog = render(overlay.Component, {
  ...overlayProps, t: (key, params) => (params === undefined ? key : `${key}(${JSON.stringify(params)})`),
});
const outdatedConfirm = outdatedDialog.elements.filter((element) => element.type === 'button')
  .find((element) => String(element.props.className).includes('dsd_danger'));
check('an older Host half is reported instead of repeated', outdatedDialog.text.includes('dialog.hostOutdated'), outdatedDialog.text);
check('an older Host half blocks the click', outdatedConfirm.props.disabled === true);

// Running work: named, and offered as stop-and-delete instead of a refusal.
fetchReply = { ok: true, status: 200, json: async () => ({ ok: true, active: true, resident: true, missing: false, deletable: false, sizeBytes: 10, descendants: [], activity: [{ kind: 'turn', items: [] }, { kind: 'job', items: [{ id: 'job-1', label: 'Build task' }] }] }) };
await injected.requestDelete('session-2', 'Busy session');
await new Promise((resolve) => setTimeout(resolve, 0));
React.__resetHooks();
const activeDialog = render(overlay.Component, {
  ...overlayProps, t: (key, params) => (params === undefined ? key : `${key}(${JSON.stringify(params)})`),
});
const activeConfirm = activeDialog.elements.filter((element) => element.type === 'button')
  .find((element) => String(element.props.className).includes('dsd_danger'));
check('running work offers a stop-and-delete action', activeConfirm.props.disabled === false
  && activeDialog.text.includes('dialog.stopAndDelete'), activeDialog.text);
check('the dialog names the running work families', activeDialog.text.includes('dialog.activity.turn')
  && activeDialog.text.includes('dialog.activity.job')
  && activeDialog.text.includes('Build task'), activeDialog.text);
check('the dialog no longer claims the session is merely "running or open"',
  !activeDialog.text.includes('dialog.running'), activeDialog.text);

// A cascade is named.
fetchReply = { ok: true, status: 200, json: async () => ({ ok: true, active: false, resident: false, missing: false, deletable: true, sizeBytes: 10, descendants: [{ id: 'c1', sizeBytes: 5 }, { id: 'c2', sizeBytes: 5 }], activity: [] }) };
await injected.requestDelete('session-3', 'Parent session');
await new Promise((resolve) => setTimeout(resolve, 0));
React.__resetHooks();
const cascadeDialog = render(overlay.Component, {
  ...overlayProps, t: (key, params) => (params === undefined ? key : `${key}(${JSON.stringify(params)})`),
});
check('the dialog lists the subagent family it would take', cascadeDialog.text.includes('"n":2'), cascadeDialog.text);

// --------------------------------------------------------------------------
console.log('\nconfirm path');

fetchCalls = [];
fetchReply = { ok: true, status: 200, json: async () => ({ ok: true, deleted: ['session-3', 'c1', 'c2'] }) };
overlayProps.confirm();
await new Promise((resolve) => setTimeout(resolve, 0));
check('confirm posts the delete with the cascade', fetchCalls.some((call) => call.url.endsWith('/session-delete/api/delete')
  && call.body.sessionId === 'session-3' && call.body.includeDescendants === true), JSON.stringify(fetchCalls));
check('confirm asks the Host to stop activity first', fetchCalls.some((call) => call.url.endsWith('/session-delete/api/delete')
  && call.body.stopActivity === true), JSON.stringify(fetchCalls));
check('the browser session catalog is refreshed', refreshed.length === 1, String(refreshed.length));

React.__resetHooks();
const notice = render(overlay.Component, {
  ...overlayProps, t: (key, params) => (params === undefined ? key : `${key}(${JSON.stringify(params)})`),
});
check('a success notice names the removed session', notice.text.includes('Parent session'), notice.text);
check('the dialog is gone after success', notice.elements.every((element) => element.props.role !== 'dialog'));

// A rejected delete keeps the dialog open with the reason.
fetchReply = { ok: false, status: 409, json: async () => ({ ok: false, code: 'active', detail: 'running' }) };
await injected.requestDelete('session-4', 'Busy session');
await new Promise((resolve) => setTimeout(resolve, 0));
overlayProps.confirm();
await new Promise((resolve) => setTimeout(resolve, 0));
React.__resetHooks();
const failedDialog = render(overlay.Component, {
  ...overlayProps, t: (key, params) => (params === undefined ? key : `${key}(${JSON.stringify(params)})`),
});
check('a rejected delete keeps the dialog open', failedDialog.elements.some((element) => element.props.role === 'dialog'));
check('the dialog shows the localized refusal', failedDialog.text.includes('error.active'), failedDialog.text);

overlayProps.close();
check('cancel closes the dialog', overlayProps.store.get() === null);

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
