(() => {
  'use strict';
  const CONFIG = {
    supportTLinks: true, onlyViewport: false, autoScrollLoad: true,
    autoScrollStep: 600, autoScrollInterval: 1200, moThrottle: 500,
    delayClickEntry: [300, 800], delayFindPopup: [1000, 1500],
    delayClickJoin: [600, 1200], delayAfterJoin: [1200, 2000],
    entryTimeout: 5000, popupAppearTimeout: 5000, joinTimeout: 7000,
    captchaKeywords: ['验证码', '安全验证', '请完成验证', '点击验证', '机器人验证'],
    entryTexts: ['互动抽奖', '参与抽奖', '立即参与', '去参与'],
    joinTexts: ['关注up主并转发抽奖动态', '关注并转发', '一键参与', '参与并转发'],
  };
  const { normalizeLink, jitter } = BiliLottery;
  const normalize = value => (value || '').replace(/\s+/g, '').toLowerCase();
  const linkSelector = new URL(location.href).hostname === 't.bilibili.com'
    ? 'a[href]' : 'a[href*="/opus/"], a[href*="t.bilibili.com/"]';
  const popupSelector = '.bili-popup__wrap, [role="dialog"]';
  const frameSelector = 'iframe.bili-popup__content__browser, .bili-popup__content iframe';
  let processState = null;
  let collecting = false;
  let observer = null, intersection = null, scrollTimer = null, flushTimer = null, viewportTimer = null;
  let activeTask = null, lastTaskId = null, joinAttempted = false;
  let starting = false, stopping = false;
  const seen = new Set();
  const pending = new Set();

  async function message(payload) {
    const response = await chrome.runtime.sendMessage(payload);
    if (!response?.success) throw new Error(response?.error || '扩展后台未响应，请刷新页面');
    return response;
  }

  function setStatus(text) {
    const element = document.getElementById('bili-status');
    if (element) element.textContent = text;
  }

  function visible(element) {
    if (!element?.isConnected || element.closest?.('#bili-floating-panel')) return false;
    if (!element.getClientRects().length) return false;
    const style = element.ownerDocument.defaultView.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse'
      && style.opacity !== '0';
  }

  function inViewport(element) {
    if (!visible(element)) return false;
    const rect = element.getBoundingClientRect();
    return rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
  }

  function createFloatingPanel() {
    if (document.getElementById('bili-floating-panel')) return;
    const style = document.createElement('style');
    style.textContent = `
      #bili-floating-panel{position:fixed;bottom:20px;right:20px;background:#fff;color:#212121;border-radius:8px;font:14px "Microsoft YaHei","Segoe UI",sans-serif;z-index:99999;box-shadow:0 2px 10px #0002;width:260px;max-width:100vw;overflow:hidden;border:1px solid #e3e5e7}
      #bili-floating-panel[hidden]{display:none!important}
      #bili-panel-header{background:#FB7299;color:#fff;padding:8px 12px;font-weight:700;display:flex;justify-content:space-between;align-items:center;cursor:move;user-select:none}
      #bili-panel-content{padding:12px}
      #bili-counter{background:#f4f4f4;border-radius:4px;padding:8px;margin:8px 0;font-size:12px;text-align:center}
      #bili-status{font-size:12px;margin-top:8px;color:#6d757a;text-align:center;min-height:16px;overflow-wrap:anywhere}
      #bili-floating-panel .bili-btn{padding:8px 0;cursor:pointer;background:#fff;color:#212121;border-radius:4px;font-size:14px;font-weight:700;width:49%;border:1px solid #e3e5e7}
      #bili-floating-panel .bili-btn:hover{background:#f4f4f4}
      #bili-floating-panel #bili-start-btn{background:#FB7299;color:#fff}
      #bili-floating-panel .bili-btn:disabled{opacity:.5;cursor:not-allowed}
      #bili-control-buttons{display:flex;justify-content:space-between}
      #bili-close-btn{background:none;border:none;color:#fff;cursor:pointer;font-size:16px;width:24px;height:24px}
      #bili-floating-panel .progress-bar{height:4px;background:#e3e5e7;border-radius:2px;overflow:hidden}
      #bili-progress{height:100%;background:#FB7299;width:0%;transition:width .3s}
    `;
    document.head.appendChild(style);
    const panel = document.createElement('div');
    panel.id = 'bili-floating-panel';
    panel.innerHTML = `
      <div id="bili-panel-header"><span>B站抽奖助手</span><button type="button" id="bili-close-btn" aria-label="隐藏面板">✕</button></div>
      <div id="bili-panel-content">
        <div id="bili-control-buttons"><button type="button" id="bili-start-btn" class="bili-btn">开始</button><button type="button" id="bili-stop-btn" class="bili-btn" disabled>停止</button></div>
        <div id="bili-counter">已处理：0 / 0 · 已点击：0 · 跳过：0</div>
        <div class="progress-bar"><div id="bili-progress"></div></div>
        <div id="bili-status" role="status" aria-live="polite">准备就绪</div>
      </div>`;
    document.body.appendChild(panel);
    document.getElementById('bili-start-btn').onclick = () => { void startClicking(); };
    document.getElementById('bili-stop-btn').onclick = () => { void stopClicking(); };
    document.getElementById('bili-close-btn').onclick = () => { panel.hidden = true; };
    makeDraggable(panel);
    if (processState) renderState();
    chrome.storage.local.get('panelPosition').then(data => {
      const { left, top } = data.panelPosition || {};
      if (Number.isFinite(left) && Number.isFinite(top) && !panel.dataset.moved) positionPanel(panel, left, top);
    }).catch(() => {});
  }

  function positionPanel(panel, left, top) {
    const rect = panel.getBoundingClientRect();
    panel.style.left = `${Math.max(0, Math.min(left, window.innerWidth - rect.width))}px`;
    panel.style.top = `${Math.max(0, Math.min(top, window.innerHeight - rect.height))}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  }

  function makeDraggable(panel) {
    const header = document.getElementById('bili-panel-header');
    let offset = null;
    header.addEventListener('mousedown', event => {
      if (event.button !== 0 || event.target.closest('button')) return;
      const rect = panel.getBoundingClientRect();
      offset = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      panel.dataset.moved = 'true';
      event.preventDefault();
    });
    document.addEventListener('mousemove', event => {
      if (offset) positionPanel(panel, event.clientX - offset.x, event.clientY - offset.y);
    });
    const endDrag = () => {
      if (!offset) return;
      offset = null;
      const { left, top } = panel.getBoundingClientRect();
      void chrome.storage.local.set({ panelPosition: { left, top } }).catch(() => {});
    };
    document.addEventListener('mouseup', endDrag);
    window.addEventListener('blur', endDrag);
    window.addEventListener('resize', () => {
      if (panel.hidden) return;
      const { left, top } = panel.getBoundingClientRect();
      positionPanel(panel, left, top);
    });
  }

  function renderState() {
    if (!processState) return;
    const state = processState;
    const belongs = state.isSource || state.isTask;
    const start = document.getElementById('bili-start-btn');
    const stop = document.getElementById('bili-stop-btn');
    if (start) {
      start.disabled = starting || (state.running && belongs) || (state.phase === 'paused' && state.isTask);
      start.textContent = state.phase === 'paused' && state.isSource ? '继续' : '开始';
    }
    if (stop) stop.disabled = stopping || !belongs || (!state.running && state.phase !== 'paused');
    const counter = document.getElementById('bili-counter');
    const progress = document.getElementById('bili-progress');
    if (counter) counter.textContent = `已处理：${state.count} / ${state.total} · 已点击：${state.clicked} · 跳过：${state.skipped}`;
    if (progress) progress.style.width = `${state.total ? Math.min(100, state.count / state.total * 100) : 0}%`;
    if (!belongs && (state.running || state.phase === 'paused')) setStatus('其他页面有任务正在运行或暂停');
    else if (state.phase === 'paused') setStatus(state.reason);
    else if (state.running) setStatus(state.phase === 'draining' ? '等待懒加载的新链接…' : `进行中 (${state.count}/${state.total})`);
    else if (belongs) setStatus(state.reason || '准备就绪');
  }

  function applyState(state) {
    processState = state;
    if (state.running && state.isSource) {
      if (!collecting) startObservers();
    } else { stopObservers(); }
    renderState();
  }

  function collectAnchor(anchor) {
    const link = normalizeLink(anchor.href, CONFIG.supportTLinks);
    if (!link || link === normalizeLink(location.href) || (CONFIG.onlyViewport && !inViewport(anchor))) return;
    if (seen.has(link)) return;
    seen.add(link);
    pending.add(link);
    scheduleFlush();
  }

  function captureFromAnchors(root = document) {
    const anchors = [];
    if (root.matches?.(linkSelector)) anchors.push(root);
    if (root.querySelectorAll) anchors.push(...root.querySelectorAll(linkSelector));
    for (const anchor of anchors) {
      if (CONFIG.onlyViewport && collecting) intersection?.observe(anchor);
      collectAnchor(anchor);
    }
  }

  function scheduleFlush() {
    if (!collecting || flushTimer || !pending.size) return;
    flushTimer = setTimeout(() => { flushTimer = null; void flushLinks(); }, CONFIG.moThrottle);
  }

  async function flushLinks() {
    if (!collecting || !pending.size) return;
    const sessionId = processState.sessionId;
    const batch = [...pending];
    try {
      await message({ action: 'appendLinks', sessionId, links: batch });
      if (processState.sessionId === sessionId) batch.forEach(link => pending.delete(link));
    } catch (error) {
      if (collecting && processState.sessionId === sessionId) {
        stopObservers();
        setStatus(error.message);
      }
    }
    scheduleFlush();
  }

  function captureViewport() {
    if (viewportTimer || !collecting) return;
    viewportTimer = setTimeout(() => {
      viewportTimer = null;
      if (collecting) captureFromAnchors();
    }, CONFIG.moThrottle);
  }

  function startObservers() {
    collecting = true;
    if (CONFIG.onlyViewport) {
      intersection = new IntersectionObserver(entries => {
        if (collecting) entries.forEach(entry => { if (entry.isIntersecting) collectAnchor(entry.target); });
      });
      window.addEventListener('scroll', captureViewport, { passive: true });
    }
    // Inspect only changed subtrees. Panel updates cannot trigger a full-page scan.
    observer = new MutationObserver(records => {
      if (!collecting) return;
      for (const record of records) {
        if (record.target.closest?.('#bili-floating-panel')) continue;
        if (record.type === 'attributes') captureFromAnchors(record.target);
        else record.addedNodes.forEach(node => captureFromAnchors(node));
        if (intersection) record.removedNodes.forEach(node => {
          if (node.matches?.('a[href]')) intersection.unobserve(node);
          node.querySelectorAll?.('a[href]').forEach(anchor => intersection.unobserve(anchor));
        });
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
    captureFromAnchors();
    if (CONFIG.autoScrollLoad) scrollTimer = setInterval(() => {
      if (collecting) window.scrollBy({ top: CONFIG.autoScrollStep, left: 0, behavior: 'smooth' });
    }, CONFIG.autoScrollInterval);
  }

  function stopObservers() {
    collecting = false;
    observer?.disconnect();
    intersection?.disconnect();
    observer = intersection = null;
    clearInterval(scrollTimer);
    clearTimeout(flushTimer);
    clearTimeout(viewportTimer);
    scrollTimer = flushTimer = viewportTimer = null;
    window.removeEventListener('scroll', captureViewport);
  }

  async function startClicking() {
    if (starting || (processState?.running && (processState.isSource || processState.isTask))) return;
    starting = true;
    document.getElementById('bili-start-btn').disabled = true;
    seen.clear(); pending.clear();
    captureFromAnchors();
    try {
      const response = await message({ action: 'startProcess', links: [...pending] });
      applyState(response.state);
    } catch (error) { setStatus(error.message); }
    finally {
      starting = false;
      const button = document.getElementById('bili-start-btn');
      renderState();
      if (!processState) button.disabled = false;
    }
  }

  async function stopClicking() {
    if (stopping || !processState?.sessionId) return;
    stopping = true;
    stopObservers();
    activeTask?.controller.abort();
    try {
      await message({ action: 'stopProcess', sessionId: processState.sessionId, taskId: activeTask?.taskId });
    } catch (error) { setStatus(error.message); }
    finally { stopping = false; renderState(); }
  }

  function wait(ms, signal) {
    return new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  async function waitFor(predicate, timeout, signal) {
    const deadline = performance.now() + timeout;
    do {
      signal.throwIfAborted();
      const found = predicate();
      if (found) return found;
      await wait(Math.min(150, Math.max(1, deadline - performance.now())), signal);
    } while (performance.now() < deadline);
    return null;
  }

  function enabled(element) {
    return visible(element) && !element.disabled && element.getAttribute('aria-disabled') !== 'true'
      && !element.closest('[inert]');
  }

  function findButtons(root, texts, structural) {
    const preferred = [...root.querySelectorAll(structural)].filter(enabled);
    if (preferred.length) return preferred;
    const matches = [...root.querySelectorAll('button, a, [role="button"], div, span')]
      .filter(element => texts.some(text => normalize(element.textContent).includes(normalize(text))) && enabled(element));
    // Discard broad ancestors containing a more specific matching element.
    const ancestors = new Set();
    for (const element of matches) {
      for (let parent = element.parentElement; parent; parent = parent.parentElement) ancestors.add(parent);
    }
    const leaves = matches.filter(element => !ancestors.has(element));
    const clickable = leaves.map(element => element.closest('button, a, [role="button"]') || element).filter(enabled);
    return [...new Set([...preferred, ...clickable])];
  }

  function popupDocuments() {
    const roots = [...document.querySelectorAll(popupSelector)].filter(visible);
    for (const frame of document.querySelectorAll(frameSelector)) {
      if (!visible(frame)) continue;
      try { if (frame.contentDocument) roots.unshift(frame.contentDocument); }
      catch { /* Cross-origin frames require a different integration; do not scan the page instead. */ }
    }
    return roots;
  }

  function detectCaptcha() {
    const roots = [document, ...popupDocuments()];
    for (const root of roots) {
      const widgets = root.querySelectorAll('.geetest_panel, iframe[src*="geetest"], iframe[src*="captcha"]');
      if ([...widgets].some(visible)) return true;
      const candidates = root.querySelectorAll('[role="dialog"], .bili-popup__wrap, [class*="captcha"], [class*="geetest"]');
      if ([...candidates].some(element => visible(element)
        && CONFIG.captchaKeywords.some(keyword => (element.innerText || '').includes(keyword)))) return true;
    }
    return false;
  }

  async function checkCaptcha(task) {
    task.controller.signal.throwIfAborted();
    if (!detectCaptcha()) return false;
    task.paused = true;
    await message({ action: 'pauseProcess', sessionId: task.sessionId, taskId: task.taskId });
    setStatus('已暂停，请先完成验证码，再在来源页点击“继续”');
    return true;
  }

  async function waitForInteraction(predicate, timeout, task) {
    const captcha = Symbol('captcha');
    const result = await waitFor(() => detectCaptcha() ? captcha : predicate(), timeout, task.controller.signal);
    if (result !== captcha) return result;
    await checkCaptcha(task);
    return null;
  }

  async function clickCandidate(element, delays, task) {
    const signal = task.controller.signal;
    element.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await wait(jitter(...delays), signal);
    if (await checkCaptcha(task)) return false;
    signal.throwIfAborted();
    if (!enabled(element)) return false;
    element.click();
    return true;
  }

  async function runInteraction(task) {
    const signal = task.controller.signal;
    let outcome = 'skipped', reason = '未找到可用的抽奖入口';
    try {
      await wait(jitter(500, 1000), signal);
      if (await checkCaptcha(task)) return;
      if (joinAttempted) {
        // Verification may appear after the join click. Do not click again on resume.
        outcome = 'clicked'; reason = '';
      } else {
        if (!popupDocuments().length) {
          const entry = await waitForInteraction(() => findButtons(document, CONFIG.entryTexts,
            'a[data-type="lottery"], a.lottery, button.lottery')[0], CONFIG.entryTimeout, task);
          if (!entry || !await clickCandidate(entry, CONFIG.delayClickEntry, task)) {
            if (signal.aborted || task.paused) return;
            await complete(task, outcome, reason); return;
          }
        }
        await wait(jitter(...CONFIG.delayFindPopup), signal);
        const popup = await waitForInteraction(() => popupDocuments().length, CONFIG.popupAppearTimeout, task);
        if (await checkCaptcha(task)) return;
        reason = popup ? '未找到可用的关注转发按钮（可能已参与或弹窗跨域）' : '抽奖弹窗未出现';
        if (popup) {
          const button = await waitForInteraction(() => popupDocuments().flatMap(root =>
            findButtons(root, CONFIG.joinTexts, '.join-button'))[0], CONFIG.joinTimeout, task);
          if (button && await clickCandidate(button, CONFIG.delayClickJoin, task)) {
            joinAttempted = true;
            await wait(jitter(...CONFIG.delayAfterJoin), signal);
            if (await checkCaptcha(task)) return;
            outcome = 'clicked'; reason = '';
          }
        }
      }
      if (task.paused) return;
      await complete(task, outcome, reason);
    } catch (error) {
      if (!signal.aborted) {
        setStatus(error.message || '互动失败');
        try { await complete(task, 'skipped', '互动脚本发生错误'); } catch { /* Background timeout handles disconnection. */ }
      }
    } finally { if (activeTask === task) activeTask = null; }
  }

  function complete(task, outcome, reason) {
    task.controller.signal.throwIfAborted();
    return message({ action: 'notifyInteractionComplete', sessionId: task.sessionId,
      taskId: task.taskId, outcome, reason });
  }

  chrome.runtime.onMessage.addListener((payload, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (payload.action === 'processState') {
      applyState(payload.state); respond({ success: true });
    } else if (payload.action === 'togglePanel') {
      createFloatingPanel();
      const panel = document.getElementById('bili-floating-panel');
      panel.hidden = !panel.hidden;
      if (!panel.hidden) synchronize();
      respond({ success: true });
    } else if (payload.action === 'cancelInteraction') {
      if (activeTask?.taskId === payload.taskId) activeTask.controller.abort();
      respond({ success: true });
    } else if (payload.action === 'performLotteryInteraction') {
      if (typeof payload.taskId !== 'string' || typeof payload.sessionId !== 'string') {
        respond({ accepted: false }); return false;
      }
      if (payload.taskId !== lastTaskId) {
        activeTask?.controller.abort();
        lastTaskId = payload.taskId;
        const task = { ...payload, controller: new AbortController() };
        activeTask = task;
        processState = { ...processState, sessionId: task.sessionId, isSource: false, isTask: true,
          running: true, phase: 'interacting', count: 0, total: 1, clicked: 0, skipped: 0 };
        renderState();
        void runInteraction(task);
      }
      respond({ accepted: true });
    } else { return false; }
    return false;
  });

  function initialize() {
    createFloatingPanel();
    synchronize();
  }
  function synchronize() {
    void message({ action: 'getProcessState' }).then(response => applyState(response.state)).catch(error => setStatus(error.message));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
  window.addEventListener('focus', synchronize);
  window.addEventListener('pageshow', event => { if (event.persisted) synchronize(); });
  window.addEventListener('pagehide', () => { stopObservers(); activeTask?.controller.abort(); });
})();
