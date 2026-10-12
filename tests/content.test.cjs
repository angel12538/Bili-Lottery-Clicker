const { test } = require('node:test');
const assert = require('node:assert/strict');
const { content, element } = require('./helpers.cjs');

test('fixed-position buttons are visible; hidden, disabled and panel elements are excluded', () => {
  const h = content();
  const fixed = element(h, { offsetParent: null });
  assert.equal(h.api.visible(fixed), true);
  assert.equal(h.api.visible(element(h, { hidden: true })), false);
  assert.equal(h.api.visible(element(h, { computedStyle: { visibility: 'hidden' } })), false);
  assert.equal(h.api.visible(element(h, { parentElement: element(h, { id: 'bili-floating-panel' }) })), false);
  h.queries.set('.join-button', [element(h, { disabled: true }), fixed]);
  assert.deepEqual(Array.from(h.api.findButtons(h.document, [], '.join-button')), [fixed]);
});

test('text matching chooses the actual button instead of broad ancestor divs', () => {
  const h = content();
  const parent = element(h, { textContent: '抽奖活动 关注UP主并转发抽奖动态' });
  const button = element(h, { tagName: 'BUTTON', textContent: '关注UP主并转发抽奖动态', parentElement: parent });
  const span = element(h, { tagName: 'SPAN', textContent: '关注 UP主 并转发抽奖动态', parentElement: button });
  h.queries.set('button, a, [role="button"], div, span', [parent, button, span]);
  assert.deepEqual(Array.from(h.api.findButtons(h.document, ['关注up主并转发抽奖动态'], '.join-button')), [button]);
});

test('link collection excludes current page, invalid URLs and duplicate dynamic IDs', () => {
  const h = content();
  for (const href of ['https://www.bilibili.com/opus/999', 'https://t.bilibili.com/123?a=1',
    'https://www.bilibili.com/opus/123', 'https://evil.com/opus/123']) h.api.collectAnchor({ href });
  assert.deepEqual(Array.from(h.api.pending), ['https://www.bilibili.com/opus/123']);
});

test('captcha ignores ordinary page text and hidden widgets', () => {
  const h = content(); h.document.body.innerText = '这篇文章介绍验证码和安全验证';
  assert.equal(h.api.detectCaptcha(), false);
  const selector = '.geetest_panel, iframe[src*="geetest"], iframe[src*="captcha"]';
  h.queries.set(selector, [element(h, { hidden: true })]);
  assert.equal(h.api.detectCaptcha(), false);
  h.queries.set(selector, [element(h)]); assert.equal(h.api.detectCaptcha(), true);
});

test('cross-origin popup does not fall back to clicking unrelated page buttons', () => {
  const h = content();
  const frame = element(h);
  Object.defineProperty(frame, 'contentDocument', { get() { throw new Error('cross-origin'); } });
  h.queries.set('iframe.bili-popup__content__browser, .bili-popup__content iframe', [frame]);
  assert.deepEqual(Array.from(h.api.popupDocuments()), []);
});

test('abort cancels pending waits immediately and removes timer', async () => {
  const h = content(), controller = new AbortController();
  const promise = h.api.wait(10000, controller.signal);
  controller.abort(); await assert.rejects(promise, { name: 'AbortError' });
  assert.equal(h.time.timers.size, 0);
});

test('abort during click delay prevents the click', async () => {
  const h = content(), controller = new AbortController(), button = element(h);
  const promise = h.api.clickCandidate(button, [300, 300], { controller });
  controller.abort(); await assert.rejects(promise, { name: 'AbortError' });
  await h.time.advance(1000); assert.equal(button.clicks, undefined);
});

test('captcha appearing during click delay pauses instead of clicking', async () => {
  const h = content(), button = element(h);
  const task = { controller: new AbortController(), sessionId: 'session', taskId: 'task' };
  const promise = h.api.clickCandidate(button, [300, 300], task);
  h.queries.set('.geetest_panel, iframe[src*="geetest"], iframe[src*="captcha"]', [element(h)]);
  await h.time.advance(300, h.flush);
  assert.equal(await promise, false); assert.equal(button.clicks, undefined);
  assert.equal(h.sent[0].action, 'pauseProcess'); assert.equal(task.paused, true);
});

test('waitFor checks immediately and times out if no match appears', async () => {
  const h = content(), signal = new AbortController().signal;
  assert.equal(await h.api.waitFor(() => 'ready', 500, signal), 'ready');
  const promise = h.api.waitFor(() => null, 500, signal);
  await h.time.advance(500, h.flush); assert.equal(await promise, null);
});

test('stale cancellation does not abort the current interaction; duplicate dispatch is idempotent', async () => {
  const h = content();
  const listener = h.chrome.runtime.onMessage.listeners[0];
  const payload = { action: 'performLotteryInteraction', sessionId: 'session', taskId: 'task' };
  listener(payload, { id: 'extension' }, () => {});
  const task = h.api.task();
  listener(payload, { id: 'extension' }, () => {});
  assert.equal(h.api.task(), task);
  listener({ action: 'cancelInteraction', taskId: 'stale' }, { id: 'extension' }, () => {});
  assert.equal(task.controller.signal.aborted, false);
  listener({ action: 'cancelInteraction', taskId: 'task' }, { id: 'extension' }, () => {});
  assert.equal(task.controller.signal.aborted, true); await h.flush();
  assert.equal(h.sent.length, 0);
});

test('observers append new links and stopping removes pending callbacks', async () => {
  const h = content();
  h.queries.set('a[href*="/opus/"], a[href*="t.bilibili.com/"]', [{ href: 'https://t.bilibili.com/123' }]);
  h.api.applyState({ sessionId: 'session', running: true, isSource: true, total: 0, count: 0, clicked: 0, skipped: 0 });
  await h.time.advance(500, h.flush);
  assert.equal(h.sent[0].action, 'appendLinks');
  assert.deepEqual(Array.from(h.sent[0].links), ['https://www.bilibili.com/opus/123']);
  h.api.stopObservers(); assert.equal(h.time.timers.size, 0);
});

test('full interaction clicks the join button once and reports an attempt', async () => {
  const h = content(), button = element(h, { tagName: 'BUTTON' });
  const popup = element(h, { querySelectorAll: selector => selector === '.join-button' ? [button] : [] });
  h.queries.set('.bili-popup__wrap, [role="dialog"]', [popup]);
  const task = { controller: new AbortController(), sessionId: 'session', taskId: 'task' };
  const promise = h.api.runInteraction(task);
  await h.time.advance(10000, h.flush); await promise;
  assert.equal(button.clicks, 1);
  assert.equal(h.sent.length, 1); assert.equal(h.sent[0].action, 'notifyInteractionComplete');
  assert.equal(h.sent[0].outcome, 'clicked');
  const resume = h.api.runInteraction({ ...task, controller: new AbortController(), taskId: 'resumed' });
  await h.time.advance(10000, h.flush); await resume;
  assert.equal(button.clicks, 1, 'resuming after an attempted join must not click again');
});

test('captcha appearing while waiting for an entry pauses without reporting completion', async () => {
  const h = content();
  const task = { controller: new AbortController(), sessionId: 'session', taskId: 'task' };
  const promise = h.api.runInteraction(task);
  await h.time.advance(1200, h.flush);
  h.queries.set('.geetest_panel, iframe[src*="geetest"], iframe[src*="captcha"]', [element(h)]);
  await h.time.advance(150, h.flush); await promise;
  assert.deepEqual(h.sent.map(message => message.action), ['pauseProcess']);
});

test('stop after the join click suppresses delayed completion messages', async () => {
  const h = content(), button = element(h, { tagName: 'BUTTON' });
  h.queries.set('.bili-popup__wrap, [role="dialog"]', [element(h, {
    querySelectorAll: selector => selector === '.join-button' ? [button] : [],
  })]);
  const task = { controller: new AbortController(), sessionId: 'session', taskId: 'task' };
  const promise = h.api.runInteraction(task);
  for (let count = 0; !button.clicks && count < 50; count++) await h.time.advance(100, h.flush);
  assert.equal(button.clicks, 1);
  task.controller.abort(); await promise;
  assert.equal(h.sent.length, 0);
});
