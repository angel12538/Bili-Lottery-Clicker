const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { source, background } = require('./helpers.cjs');
const url = id => `https://www.bilibili.com/opus/${id}`;

test('normalizes both link types, preserves large IDs and rejects other origins', () => {
  const context = vm.createContext({ URL });
  vm.runInContext(source('shared.js'), context);
  const { normalizeLink, isBiliPage } = context.BiliLottery;
  assert.equal(normalizeLink('https://t.bilibili.com/1055344069620793408/?a=1#x'), url('1055344069620793408'));
  assert.equal(normalizeLink(`${url(123)}/?foo=1`), url(123));
  for (const value of [null, 123, 'bad', 'http://t.bilibili.com/123', 'https://evil.com/opus/123',
    'https://www.bilibili.com.evil.com/opus/123', 'https://u:p@www.bilibili.com/opus/123',
    'https://www.bilibili.com:444/opus/123', `${url(123)}/extra`]) assert.equal(normalizeLink(value), null);
  assert.equal(normalizeLink('https://t.bilibili.com/123', false), null);
  assert.equal(isBiliPage('https://space.bilibili.com/123'), true);
  assert.equal(isBiliPage('https://evilbilibili.com/123'), false);
});

test('stop during opening delay cancels timers and alarms', async () => {
  const h = await background();
  await h.start();
  await h.request(h.taskMessage('stopProcess'));
  await h.advance(60000);
  assert.equal(h.created.length, 0);
  assert.equal(h.alarms.size, 0);
  assert.equal(h.state().phase, 'stopped');
});

test('links are deduplicated and lazy-loaded links reach the queue', async () => {
  const h = await background();
  await h.start([url(123), 'https://t.bilibili.com/123?x=1', 'https://evil.com/opus/12']);
  const response = await h.request(h.taskMessage('appendLinks', { links: [url(123), url(456)] }));
  assert.equal(response.added, 1);
  assert.deepEqual(h.state().links, [url(123), url(456)]);
});

test('count advances on completion; duplicate completion cannot close the next tab', async () => {
  const h = await background();
  await h.start([url(123), url(456)]);
  await h.interact();
  assert.equal(h.state().index, 0);
  const firstTab = h.state().currentTabId;
  const complete = h.taskMessage('notifyInteractionComplete', { outcome: 'clicked' });
  await h.request(complete, firstTab);
  assert.equal(h.state().index, 1);
  await h.advance(1500);
  const nextTab = h.state().currentTabId;
  assert.equal((await h.request(complete, firstTab)).success, false);
  assert.ok(h.tabs.has(nextTab));
  assert.equal(h.state().clicked, 1);
  assert.deepEqual(h.removed, [firstTab]);
});

test('duplicate page load events dispatch exactly one interaction', async () => {
  const h = await background();
  await h.start(); await h.advance(1500); await h.load(); await h.load(); await h.advance(2000); await h.load();
  assert.equal(h.sent.filter(message => message.action === 'performLotteryInteraction').length, 1);
});

test('unrelated tabs, subframes and stale sessions cannot mutate tasks', async () => {
  const h = await background();
  await h.start(); await h.interact();
  assert.equal((await h.request(h.taskMessage('notifyInteractionComplete'), 1)).success, false);
  assert.equal((await h.request(h.taskMessage('stopProcess'), 20)).success, false);
  assert.equal((await h.request({ action: 'stopProcess', sessionId: 'stale' })).success, false);
  assert.equal((await h.request(h.taskMessage('stopProcess'), 1, { frameId: 2 })).success, false);
  assert.equal((await h.request({ action: 'startProcess', links: [] }, 1, { url: 'https://evil.com' })).success, false);
  assert.equal(h.state().running, true);
});

test('start cannot replace an active task', async () => {
  const h = await background(); await h.start();
  const session = h.state().sessionId;
  assert.equal((await h.start([url(456)])).success, false);
  assert.equal(h.state().sessionId, session);
});

test('load and interaction timeouts skip stalled tabs', async () => {
  const h = await background();
  await h.start([url(123), url(456)]); await h.advance(1500); await h.advance(45000);
  assert.equal(h.state().index, 1); assert.equal(h.state().skipped, 1);
  await h.advance(1500); await h.load(); await h.advance(2000); await h.advance(45000);
  assert.equal(h.state().index, 2); assert.equal(h.state().skipped, 2);
  await h.advance(6000); assert.equal(h.state().phase, 'complete');
});

test('manual task closure advances; source closure stops', async () => {
  const h = await background(); await h.start([url(123), url(456)]); await h.advance(1500);
  await h.chrome.tabs.remove(h.state().currentTabId); await h.flush();
  assert.equal(h.state().index, 1);
  await h.chrome.tabs.remove(1); await h.flush(); await h.advance(60000);
  assert.equal(h.created.length, 1); assert.equal(h.state().running, false);
});

test('captcha pause keeps the task tab; resume rotates task identity', async () => {
  const h = await background(); await h.start(); await h.interact();
  const tabId = h.state().currentTabId;
  const oldTask = h.state().taskId;
  await h.request(h.taskMessage('pauseProcess'), tabId);
  assert.equal(h.state().phase, 'paused'); assert.ok(h.tabs.has(tabId));
  await h.advance(60000); assert.equal(h.created.length, 1);
  await h.start(); await h.advance(2000);
  assert.equal(h.state().currentTabId, tabId); assert.notEqual(h.state().taskId, oldTask);
  assert.equal((await h.request(h.taskMessage('notifyInteractionComplete', { taskId: oldTask }), tabId)).success, false);
});

test('stop cancels an active interaction and preserves the current tab for manual use', async () => {
  const h = await background(); await h.start(); await h.interact();
  const tabId = h.state().currentTabId;
  await h.request(h.taskMessage('stopProcess'), tabId);
  assert.ok(h.tabs.has(tabId));
  assert.ok(h.sent.some(message => message.id === tabId && message.action === 'cancelInteraction'));
  assert.ok(h.sent.some(message => message.id === tabId && message.action === 'processState' && !message.state.running));
});

test('another page cannot replace a captcha-paused queue', async () => {
  const h = await background(); await h.start(); await h.interact();
  await h.request(h.taskMessage('pauseProcess'), h.state().currentTabId);
  const session = h.state().sessionId;
  assert.equal((await h.request({ action: 'startProcess', links: [url(456)] }, 20)).success, false);
  assert.equal(h.state().sessionId, session);
});

test('worker restart restores the queue without redispatching an active click', async () => {
  const h = await background(); await h.start(); await h.interact();
  const recovered = await background(h);
  assert.equal(recovered.state().phase, 'interacting');
  assert.equal(recovered.sent.filter(message => message.action === 'performLotteryInteraction').length, 0);
  await recovered.request(recovered.taskMessage('notifyInteractionComplete', { outcome: 'clicked' }), recovered.state().currentTabId);
  assert.equal(recovered.state().clicked, 1);
});

test('worker restart resumes a pending opening timer', async () => {
  const h = await background(); await h.start();
  const recovered = await background(h); await recovered.advance(1500);
  assert.equal(recovered.created.length, 1);
});

test('restoring a committed completion cannot count it again', async () => {
  const h = await background(); await h.start([url(123), url(456)]);
  Object.assign(h.storage.lotteryProcess, { phase: 'advancing', index: 1, clicked: 1, deadline: 1000 });
  const recovered = await background(h); await recovered.advance(0);
  assert.equal(recovered.state().index, 1); assert.equal(recovered.state().phase, 'scheduled');
});

test('empty initial collection waits for lazy-loaded links before completing', async () => {
  const h = await background(); await h.start([]); await h.advance(500);
  await h.request(h.taskMessage('appendLinks', { links: [url(123)] })); await h.interact();
  assert.equal(h.state().links.length, 1);
  await h.request(h.taskMessage('notifyInteractionComplete', { outcome: 'skipped' }), h.state().currentTabId);
  await h.advance(6000); assert.equal(h.state().phase, 'complete');
});

test('tab creation and missing receivers fail without blocking the queue', async () => {
  const h = await background(); h.failures.create = true; await h.start(); await h.advance(1500);
  assert.equal(h.state().skipped, 1);
  const second = await background(); second.failures.send = true; await second.start(); await second.interact();
  assert.equal(second.state().skipped, 1); assert.equal(second.removed.length, 1);
});

test('unexpected redirect is skipped before interacting', async () => {
  const h = await background(); await h.start(); await h.advance(1500); await h.load(undefined, 'https://passport.bilibili.com/login');
  assert.equal(h.state().skipped, 1);
  assert.equal(h.sent.filter(message => message.action === 'performLotteryInteraction').length, 0);
});

test('toolbar action toggles the panel on Bili pages only', async () => {
  const h = await background(); h.chrome.action.onClicked.emit(h.tabs.get(1)); await h.flush();
  h.chrome.action.onClicked.emit({ id: 2, url: 'https://example.com' }); await h.flush();
  assert.deepEqual(h.sent.filter(message => message.action === 'togglePanel').map(message => message.id), [1]);
});
