importScripts('shared.js');

const STORAGE_KEY = 'lotteryProcess';
const ALARM_NAME = 'lottery-next-step';
const LOAD_TIMEOUT = 45000;
const INTERACTION_TIMEOUT = 45000;
const DISCOVERY_GRACE = 6000;
const MAX_LINKS = 10000;
const { normalizeLink, isBiliPage, jitter } = BiliLottery;
const emptyState = () => ({
  sessionId: null, running: false, phase: 'idle', links: [], index: 0,
  clicked: 0, skipped: 0, sourceTabId: null, currentTabId: null,
  taskId: null, deadline: 0, reason: '',
});
let state = emptyState();
let timer = null;
let serial = Promise.resolve();
const ready = chrome.storage.session.get(STORAGE_KEY).then(data => {
  if (data[STORAGE_KEY]) state = { ...emptyState(), ...data[STORAGE_KEY] };
});

// Serialize queue mutations, including tab events and timer callbacks.
function enqueue(operation) {
  const result = serial.then(() => ready).then(operation);
  serial = result.catch(error => console.error('Bili Lottery:', error));
  return result;
}

function snapshot(tabId) {
  return {
    sessionId: state.sessionId, running: state.running, phase: state.phase,
    count: state.index, total: state.links.length, clicked: state.clicked,
    skipped: state.skipped, reason: state.reason,
    isSource: tabId === state.sourceTabId, isTask: tabId === state.currentTabId,
  };
}

async function send(tabId, message) {
  if (!Number.isInteger(tabId)) return null;
  try { return await chrome.tabs.sendMessage(tabId, message); }
  catch { return null; }
}

async function publish() {
  await send(state.sourceTabId, { action: 'processState', state: snapshot(state.sourceTabId) });
  await send(state.currentTabId, { action: 'processState', state: snapshot(state.currentTabId) });
}

async function persist() {
  await chrome.storage.session.set({ [STORAGE_KEY]: state });
}

async function arm() {
  clearTimeout(timer);
  timer = null;
  await chrome.alarms.clear(ALARM_NAME);
  if (!state.running || !state.deadline) return;
  // Short timer for normal operation; alarm survives worker suspension.
  const delay = Math.max(0, state.deadline - Date.now());
  timer = setTimeout(() => { void enqueue(drive); }, delay);
  await chrome.alarms.create(ALARM_NAME, { when: Math.max(Date.now() + 1, state.deadline) });
}

async function transition(phase, delay) {
  state.phase = phase;
  state.deadline = Date.now() + delay;
  await persist();
  await arm();
}

function appendLinks(values) {
  if (!Array.isArray(values)) return 0;
  const known = new Set(state.links);
  const before = state.links.length;
  for (const value of values) {
    const link = normalizeLink(value);
    if (link && !known.has(link) && state.links.length < MAX_LINKS) {
      known.add(link);
      state.links.push(link);
    }
  }
  return state.links.length - before;
}

async function scheduleNext() {
  state.taskId = null;
  state.currentTabId = null;
  const pending = state.index < state.links.length;
  await transition(pending ? 'scheduled' : 'draining', pending ? jitter(800, 1500) : DISCOVERY_GRACE);
  await publish();
}

async function cancelCurrent() {
  await send(state.currentTabId, { action: 'cancelInteraction', taskId: state.taskId });
}

async function stop(reason = '已停止', phase = 'stopped') {
  state.running = false;
  state.reason = reason;
  state.phase = phase;
  state.deadline = 0;
  await persist();
  await arm();
  await cancelCurrent();
  await publish();
  if (phase !== 'paused') {
    state.currentTabId = null;
    state.taskId = null;
    await persist();
  }
  await publish();
}

async function finish(outcome, reason = '', closeTab = true) {
  const tabId = state.currentTabId;
  await cancelCurrent();
  state.currentTabId = null;
  state.taskId = null;
  state.index++;
  state.phase = 'advancing';
  state.deadline = Date.now();
  if (outcome === 'clicked') state.clicked++;
  else state.skipped++;
  state.reason = reason;
  // Clear ownership before removal: repeated completion cannot advance the next task.
  await persist();
  if (closeTab && Number.isInteger(tabId)) {
    try { await chrome.tabs.remove(tabId); } catch { /* Already closed. */ }
  }
  await scheduleNext();
}

async function pageLoaded(tab) {
  if (normalizeLink(tab.url) !== state.links[state.index]) {
    await finish('skipped', '页面跳转到非目标动态');
    return;
  }
  await transition('ready', jitter(1000, 2000));
}

async function drive() {
  if (!state.running) return;
  if (state.deadline > Date.now()) { await arm(); return; }
  if (state.phase === 'advancing') {
    await scheduleNext();
  } else if (state.phase === 'scheduled') {
    state.taskId = `${state.sessionId}:${state.index}:${crypto.randomUUID()}`;
    await transition('opening', LOAD_TIMEOUT);
    try {
      const tab = await chrome.tabs.create({ url: state.links[state.index], active: true });
      state.currentTabId = tab.id;
      await transition('loading', LOAD_TIMEOUT);
      if (tab.status === 'complete') await pageLoaded(tab);
    } catch { await finish('skipped', '无法打开动态页面'); }
  } else if (state.phase === 'ready') {
    await transition('interacting', INTERACTION_TIMEOUT);
    const response = await send(state.currentTabId, {
      action: 'performLotteryInteraction', sessionId: state.sessionId, taskId: state.taskId,
    });
    if (!response?.accepted) await finish('skipped', '页面脚本未就绪或无法接收任务');
  } else if (state.phase === 'draining') {
    if (state.index < state.links.length) await scheduleNext();
    else await stop(state.links.length ? '任务已完成' : '未找到可处理的动态链接', 'complete');
  } else if (state.phase === 'opening') {
    // An interrupted tabs.create call has an uncertain result. Never reopen blindly.
    await stop('打开标签页时任务中断，请重新开始');
  } else {
    await finish('skipped', state.phase === 'loading' ? '页面加载超时' : '互动等待超时');
  }
}

async function start(message, sender) {
  if (state.running) return { success: false, error: '已有任务正在运行，请先停止该任务' };
  if (state.phase === 'paused' && state.sourceTabId !== sender.tab.id) {
    return { success: false, error: '已有暂停的任务，请先在来源页继续或停止' };
  }
  if (state.phase === 'paused' && state.sourceTabId === sender.tab.id) {
    state.running = true;
    state.reason = '';
    if (Number.isInteger(state.currentTabId)) {
      try {
        const tab = await chrome.tabs.get(state.currentTabId);
        state.taskId = `${state.sessionId}:${state.index}:${crypto.randomUUID()}`;
        await pageLoaded(tab);
      } catch { await scheduleNext(); }
    } else { await scheduleNext(); }
  } else {
    await cancelCurrent();
    state = { ...emptyState(), running: true, sourceTabId: sender.tab.id,
      sessionId: crypto.randomUUID() };
    appendLinks(message.links);
    await scheduleNext();
  }
  await publish();
  return { success: true, state: snapshot(sender.tab.id) };
}

const actions = new Set(['startProcess', 'stopProcess', 'appendLinks',
  'getProcessState', 'notifyInteractionComplete', 'pauseProcess']);
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!message || !actions.has(message.action)) return false;
  if (!Number.isInteger(sender.tab?.id) || sender.frameId !== 0
    || !isBiliPage(sender.url || sender.tab.url)) {
    respond({ success: false, error: '无效的消息来源' });
    return false;
  }
  enqueue(async () => {
    if (message.action === 'getProcessState') return { success: true, state: snapshot(sender.tab.id) };
    if (message.action === 'startProcess') return start(message, sender);
    const source = sender.tab.id === state.sourceTabId && message.sessionId === state.sessionId;
    const task = sender.tab.id === state.currentTabId && message.sessionId === state.sessionId
      && message.taskId === state.taskId;
    if (!source && !task) return { success: false, error: '任务已失效' };
    if (message.action === 'stopProcess') {
      await stop();
    } else if (message.action === 'appendLinks' && source && state.running) {
      const added = appendLinks(message.links);
      if (added) {
        if (state.phase === 'draining') await scheduleNext();
        else { await persist(); await publish(); }
      }
      return { success: true, added };
    } else if (message.action === 'pauseProcess' && task && state.running) {
      await stop('检测到验证码，请在动态页完成验证，然后在来源页点击“继续”', 'paused');
    } else if (message.action === 'notifyInteractionComplete' && task && state.running
      && state.phase === 'interacting') {
      await finish(message.outcome === 'clicked' ? 'clicked' : 'skipped', message.reason);
    } else { return { success: false, error: '当前状态不接受此操作' }; }
    return { success: true };
  }).then(respond, error => respond({ success: false, error: error.message }));
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== 'complete') return;
  void enqueue(async () => {
    if (state.running && tabId === state.currentTabId && state.phase === 'loading') await pageLoaded(tab);
  });
});
chrome.tabs.onRemoved.addListener(tabId => {
  void enqueue(async () => {
    if (tabId === state.sourceTabId) await stop('来源页已关闭');
    else if (tabId === state.currentTabId) {
      if (state.running) await finish('skipped', '动态页已手动关闭', false);
      else { state.currentTabId = null; state.taskId = null; await persist(); }
    }
  });
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM_NAME) void enqueue(drive);
});
chrome.action.onClicked.addListener(tab => {
  if (isBiliPage(tab.url)) void send(tab.id, { action: 'togglePanel' });
});

// Restore the short timer when the worker wakes up.
void enqueue(async () => {
  if (!state.running) return;
  try { await chrome.tabs.get(state.sourceTabId); } catch { await stop('来源页已关闭'); return; }
  if (Number.isInteger(state.currentTabId)) {
    try {
      const tab = await chrome.tabs.get(state.currentTabId);
      if (state.phase === 'loading' && tab.status === 'complete') await pageLoaded(tab);
    } catch { await finish('skipped', '动态页已关闭', false); return; }
  }
  await arm();
});
