const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const source = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

function event() {
  const listeners = [];
  return { addListener: listener => listeners.push(listener), emit: (...args) => listeners.map(fn => fn(...args)), listeners };
}

function clock() {
  let now = 1000, nextId = 1;
  const timers = new Map();
  const setTimeout = (callback, delay) => {
    const id = nextId++;
    timers.set(id, { callback, at: now + delay });
    return id;
  };
  const clearTimeout = id => timers.delete(id);
  return {
    timers, setTimeout, clearTimeout, now: () => now,
    Date: class extends Date { static now() { return now; } },
    async advance(ms, flush = async () => {}) {
      const end = now + ms;
      for (let guard = 0; guard < 1000; guard++) {
        const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) { now = end; await flush(); return; }
        now = due[1].at;
        timers.delete(due[0]);
        due[1].callback();
        await flush();
      }
      throw new Error('Timer did not settle');
    },
  };
}

async function background(previous) {
  const time = clock();
  const storage = previous?.storage || {};
  const tabs = previous?.tabs || new Map([[1, { id: 1, url: 'https://www.bilibili.com/opus/999', status: 'complete' }]]);
  const sent = [], removed = [], created = [], alarms = new Map();
  let tabId = 100;
  const failures = {};
  const chrome = {
    runtime: { onMessage: event() },
    storage: { session: {
      async get() { return structuredClone(storage); },
      async set(value) { Object.assign(storage, structuredClone(value)); },
    } },
    tabs: {
      onUpdated: event(), onRemoved: event(),
      async create(options) {
        if (failures.create) throw new Error('create failed');
        const tab = { ...options, id: tabId++, status: 'loading' };
        tabs.set(tab.id, tab); created.push(tab); return tab;
      },
      async get(id) { if (!tabs.has(id)) throw new Error('closed'); return tabs.get(id); },
      async remove(id) {
        if (!tabs.delete(id)) throw new Error('closed');
        removed.push(id); chrome.tabs.onRemoved.emit(id);
      },
      async sendMessage(id, payload) {
        sent.push({ id, ...structuredClone(payload) });
        if (!tabs.has(id) || (payload.action === 'performLotteryInteraction' && failures.send)) throw new Error('no receiver');
        return payload.action === 'performLotteryInteraction' ? { accepted: true } : { success: true };
      },
    },
    alarms: {
      onAlarm: event(), async clear(name) { alarms.delete(name); },
      async create(name, value) { alarms.set(name, value); },
    },
    action: { onClicked: event() },
  };
  const context = vm.createContext({ chrome, console, URL, crypto: { randomUUID },
    Date: time.Date, setTimeout: time.setTimeout, clearTimeout: time.clearTimeout });
  context.importScripts = name => vm.runInContext(source(name), context);
  vm.runInContext(source('background.js'), context);
  const flush = async () => {
    for (let i = 0; i < 8; i++) await vm.runInContext('serial', context);
  };
  await flush();
  const harness = {
    time, storage, tabs, sent, removed, created, alarms, failures, chrome, flush,
    state: () => structuredClone(storage.lotteryProcess),
    advance: ms => time.advance(ms, flush),
    async request(payload, id = 1, extra = {}) {
      let answer;
      chrome.runtime.onMessage.emit(payload, { tab: tabs.get(id) || { id, url: 'https://www.bilibili.com/opus/123' },
        frameId: 0, ...extra }, response => { answer = response; });
      await flush(); return answer;
    },
    async load(id = harness.state().currentTabId, url) {
      const tab = tabs.get(id);
      Object.assign(tab, { status: 'complete', ...(url ? { url } : {}) });
      chrome.tabs.onUpdated.emit(id, { status: 'complete' }, tab);
      await flush();
    },
    async start(links = ['https://www.bilibili.com/opus/123']) {
      return harness.request({ action: 'startProcess', links });
    },
    async interact() { await harness.advance(1500); await harness.load(); await harness.advance(2000); },
    taskMessage(action, extras = {}) {
      const state = harness.state();
      return { action, sessionId: state.sessionId, taskId: state.taskId, ...extras };
    },
  };
  return harness;
}

function content() {
  const time = clock();
  const sent = [], queries = new Map(), elements = new Map();
  const window = {
    innerWidth: 1000, innerHeight: 800, addEventListener() {}, removeEventListener() {}, scrollBy() {},
    getComputedStyle: element => element.computedStyle || { display: 'block', visibility: 'visible', opacity: '1' },
  };
  const document = {
    readyState: 'loading', defaultView: window, addEventListener() {}, removeEventListener() {},
    getElementById: id => elements.get(id), querySelectorAll: selector => queries.get(selector) || [],
    body: { innerText: '', isConnected: true },
  };
  const chrome = {
    runtime: { id: 'extension', onMessage: event(), async sendMessage(payload) { sent.push(payload); return { success: true }; } },
    storage: { local: { async get() { return {}; }, async set() {} } },
  };
  class Observer { observe() {} unobserve() {} disconnect() { this.disconnected = true; } }
  const context = vm.createContext({ chrome, console, document, window, URL, AbortController,
    location: { href: 'https://www.bilibili.com/opus/999' },
    performance: { now: time.now }, setTimeout: time.setTimeout, clearTimeout: time.clearTimeout,
    setInterval: time.setTimeout, clearInterval: time.clearTimeout,
    MutationObserver: Observer, IntersectionObserver: Observer });
  vm.runInContext(source('shared.js'), context);
  // Expose private helpers only in the test VM, without changing the extension.
  const exposed = source('content.js').replace(/\}\)\(\);\s*$/, `
    globalThis.testAPI = { visible, findButtons, detectCaptcha, popupDocuments, wait, waitFor,
      collectAnchor, captureFromAnchors, startObservers, stopObservers, checkCaptcha,
      clickCandidate, runInteraction, applyState, pending, seen,
      state: () => processState, task: () => activeTask };
  })();`);
  vm.runInContext(exposed, context);
  return { api: context.testAPI, chrome, document, window, sent, queries, elements, time,
    async flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); } };
}

function element(harness, options = {}) {
  const result = {
    ownerDocument: harness.document, isConnected: true, parentElement: null,
    textContent: '', innerText: '', tagName: 'DIV', disabled: false,
    getClientRects() { return this.hidden ? [] : [{}]; },
    getBoundingClientRect: () => ({ left: 10, top: 10, right: 100, bottom: 100 }),
    getAttribute(name) { return this.attributes?.[name] ?? null; },
    closest(selector) {
      for (let node = this; node; node = node.parentElement) {
        if (selector === '#bili-floating-panel' && node.id === 'bili-floating-panel') return node;
        if (selector === '[inert]' && node.inert) return node;
        if (selector === 'button' && node.tagName === 'BUTTON') return node;
        if (selector === 'button, a, [role="button"]'
          && (['BUTTON', 'A'].includes(node.tagName) || node.attributes?.role === 'button')) return node;
      }
      return null;
    },
    scrollIntoView() {}, click() { this.clicks = (this.clicks || 0) + 1; },
    ...options,
  };
  return result;
}

module.exports = { source, background, content, element };
