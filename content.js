/** ========== 可配置项（集中管理） ========== */
const CONFIG = {
  // 抓取规则
  supportTLinks: true,               // 支持 t.bilibili.com/<id>
  onlyViewport: false,                // 是否只采集“当前视口内可见”的链接
  autoScrollLoad: true,              // 采集中自动轻缓滚动以触发懒加载（合集页更有用）
  autoScrollStep: 600,               // 每次滚动步长(px)
  autoScrollInterval: 1200,          // 滚动间隔(ms)

  // 延时（人类化抖动）
  delayClickEntry: [300, 800],       // 点击“互动抽奖”按钮前抖动
  delayFindPopup: [1000, 1500],      // 点击入口后，等待弹窗稳定再找按钮
  delayClickJoin: [600, 1200],       // 点击“关注并转发”前抖动
  delayAfterJoin: [1200, 2000],      // 点击后通知完成前的等待

  // 重试与等待
  popupAppearTimeout: 5000,          // 等待弹窗出现的最长时间
  maxFindJoinRetries: 3,             // 查找“关注并转发”最大重试次数
  moThrottle: 500,                   // MutationObserver 触发节流(ms)

  // 验证码关键字
  captchaKeywords: ['验证码','安全验证','请完成验证','点击验证','机器人验证'],

  // 文本关键词（可拓展）
  entryTexts: ['互动抽奖','参与抽奖','立即参与','去参与'],
  joinTexts: [
    '关注up主并转发抽奖动态',
    '关注并转发','一键参与','参与并转发',
    '关注UP主并转发抽奖动态'
  ],
};

/** ========== 工具 ==========
 * 注意：尽量只用轻量工具避免触发站点风控
 */
const OPUS_RE  = /^https:\/\/www\.bilibili\.com\/opus\/(\d+)(?:[?#].*)?$/;
const TDYN_RE  = /^https:\/\/t\.bilibili\.com\/(\d+)(?:[?#].*)?$/;
const JITTER = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const VISIBLE = (el) => el && el.offsetParent !== null;
const normText = (s) => (s || "").replace(/\s+/g, "").trim();

function normalizeLink(url) {
  const m1 = url.match(OPUS_RE);
  if (m1) return `https://www.bilibili.com/opus/${m1[1]}`;
  if (!CONFIG.supportTLinks) return null;
  const m2 = url.match(TDYN_RE);
  if (m2) return `https://www.bilibili.com/opus/${m2[1]}`;
  return null;
}

function inViewport(el) {
  if (!el || !el.getBoundingClientRect) return false;
  const r = el.getBoundingClientRect();
  const vw = window.innerWidth || document.documentElement.clientWidth;
  const vh = window.innerHeight || document.documentElement.clientHeight;
  return r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
}

function waitFor(predicate, { timeout = 3000, interval = 100 } = {}) {
  return new Promise((resolve) => {
    const start = performance.now();
    const timer = setInterval(() => {
      if (predicate()) { clearInterval(timer); resolve(true); return; }
      if (performance.now() - start > timeout) { clearInterval(timer); resolve(false); }
    }, interval);
  });
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));

/** ========== 全局状态 ========== */
let isRunning = false;
let hasAlerted = false;
let links = [];             // 统一存 opus 链接
const seenIds = new Set();  // 去重（按 opus id）
let mo = null;              // MutationObserver
let io = null;              // IntersectionObserver（仅用于 onlyViewport）
let autoScrollTimer = null;

/** ========== 面板 UI ========== */
function createFloatingPanel() {
  if (document.getElementById('bili-floating-panel')) return;

  const style = document.createElement('style');
  style.textContent = `
    #bili-floating-panel{position:fixed;bottom:20px;right:20px;background:#fff;color:#212121;padding:0;border-radius:8px;font-size:14px;z-index:99999;font-family:"Microsoft YaHei","Segoe UI",sans-serif;box-shadow:0 2px 10px rgba(0,0,0,0.15);width:240px;transition:all .3s ease;overflow:hidden;border:1px solid #e3e5e7}
    #bili-panel-header{background:#FB7299;color:#fff;padding:8px 12px;font-weight:700;display:flex;justify-content:space-between;align-items:center;cursor:move;user-select:none;border-top-left-radius:8px;border-top-right-radius:8px}
    #bili-panel-content{padding:12px}
    #bili-counter{background:#f4f4f4;border-radius:4px;padding:8px;margin:8px 0;font-size:13px;text-align:center}
    #bili-status{font-size:12px;margin-top:8px;color:#6d757a;text-align:center;min-height:16px}
    .bili-btn{border:none;padding:8px 0;margin:0;cursor:pointer;background:#fff;color:#212121;font-size:14px;border-radius:4px;transition:all .2s;font-weight:700;width:49%;border:1px solid #e3e5e7}
    .bili-btn:hover{background:#f4f4f4}
    #bili-start-btn{background:#FB7299;color:#fff;border:1px solid #FB7299}
    #bili-start-btn:hover{background:#fc85a8}
    #bili-start-btn:disabled{background:#ffb6c9;cursor:not-allowed}
    #bili-stop-btn:hover{color:#FB7299}
    #bili-control-buttons{display:flex;justify-content:space-between;width:100%}
    #bili-close-btn{background:none;border:none;color:#fff;cursor:pointer;font-size:16px;padding:0;margin:0;width:24px;height:24px;display:flex;align-items:center;justify-content:center}
    #bili-close-btn:hover{background:rgba(255,255,255,.2);border-radius:50%}
    .progress-bar{height:4px;background:#e3e5e7;border-radius:2px;margin-top:6px;overflow:hidden}
    .progress-fill{height:100%;background:#FB7299;width:0%;transition:width .3s}
  `;
  document.head.appendChild(style);

  const panel = document.createElement('div');
  panel.id = 'bili-floating-panel';
  panel.innerHTML = `
    <div id="bili-panel-header">
      <span>B站抽奖助手</span>
      <button id="bili-close-btn">✕</button>
    </div>
    <div id="bili-panel-content">
      <div id="bili-control-buttons">
        <button id="bili-start-btn" class="bili-btn">开始</button>
        <button id="bili-stop-btn" class="bili-btn">停止</button>
      </div>
      <div id="bili-counter">已执行：0 个</div>
      <div class="progress-bar"><div class="progress-fill" id="bili-progress"></div></div>
      <div id="bili-status">准备就绪</div>
    </div>
  `;
  document.body.appendChild(panel);

  // 恢复位置
  const savedPos = localStorage.getItem('blc-panel-pos');
  if (savedPos) {
    try {
      const { left, top } = JSON.parse(savedPos);
      if (Number.isFinite(left) && Number.isFinite(top)) {
        panel.style.left = `${left}px`;
        panel.style.top = `${top}px`;
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
      }
    } catch {}
  }

  document.getElementById('bili-start-btn').onclick = startClicking;
  document.getElementById('bili-stop-btn').onclick = stopClicking;
  document.getElementById('bili-close-btn').onclick = () => (panel.style.display = 'none');
  makeDraggable(panel);
}

function makeDraggable(element) {
  const header = document.getElementById('bili-panel-header');
  let isDragging = false, offsetX = 0, offsetY = 0;
  header.addEventListener('mousedown', (e) => {
    isDragging = true;
    const rect = element.getBoundingClientRect();
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;
  });
  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const left = e.clientX - offsetX, top = e.clientY - offsetY;
    element.style.left = `${left}px`;
    element.style.top  = `${top}px`;
    element.style.right = 'auto';
    element.style.bottom = 'auto';
  });
  document.addEventListener('mouseup', () => {
    if (!isDragging) return;
    isDragging = false;
    const rect = element.getBoundingClientRect();
    localStorage.setItem('blc-panel-pos', JSON.stringify({ left: rect.left, top: rect.top }));
  });
}

function setStatus(text) {
  const el = document.getElementById('bili-status');
  if (el) el.textContent = text;
}

function updateFloatingPanel(done) {
  const counter  = document.getElementById('bili-counter');
  const progress = document.getElementById('bili-progress');
  if (counter) counter.textContent = `已执行：${done} 个`;
  if (links && links.length > 0 && progress) {
    const pct = Math.min(100, (done / links.length) * 100);
    progress.style.width = `${pct}%`;
    if (done >= links.length) setStatus('任务已完成！');
    else if (isRunning) setStatus(`进行中 (${done}/${links.length})`);
  }
}

/** ========== 采集：支持视口过滤与自动滚动加载 ========== */
function captureFromAnchors() {
  const anchors = document.querySelectorAll('a[href]');
  const hereNorm = normalizeLink(location.href);
  let added = 0;

  anchors.forEach(a => {
    const href = a.href;
    if (!href) return;
    const norm = normalizeLink(href);
    if (!norm) return;
    if (hereNorm && hereNorm === norm) return; // 排除当前页
    if (CONFIG.onlyViewport && !inViewport(a)) return; // 仅视口

    const idMatch = norm.match(/\/opus\/(\d+)/);
    const id = idMatch ? idMatch[1] : null;
    if (id && !seenIds.has(id)) {
      seenIds.add(id);
      links.push(norm);
      added++;
    }
  });

  return added;
}

let moTimer = null;
function startObservers() {
  // MutationObserver（懒加载/无限流）
  if (!mo) {
    mo = new MutationObserver(() => {
      if (!isRunning) return;
      if (moTimer) return;
      moTimer = setTimeout(() => {
        moTimer = null;
        const n = captureFromAnchors();
        if (n > 0) setStatus(`已发现 ${links.length} 条抽奖入口…`);
      }, CONFIG.moThrottle);
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  // IntersectionObserver（仅在只采视口时，选择性增强）
  if (CONFIG.onlyViewport && !io) {
    io = new IntersectionObserver((entries) => {
      if (!isRunning) return;
      let added = 0;
      for (const e of entries) {
        if (e.isIntersecting && e.target.href) {
          const norm = normalizeLink(e.target.href);
          if (!norm) continue;
          const id = (norm.match(/\/opus\/(\d+)/) || [])[1];
          if (id && !seenIds.has(id)) {
            seenIds.add(id);
            links.push(norm);
            added++;
          }
        }
      }
      if (added > 0) setStatus(`已发现 ${links.length} 条抽奖入口…`);
    }, { rootMargin: '0px 0px 100px 0px' });

    document.querySelectorAll('a[href]').forEach(a => io.observe(a));
  }

  // 自动轻滚触发懒加载（更像真人）
  if (CONFIG.autoScrollLoad && !autoScrollTimer) {
    autoScrollTimer = setInterval(() => {
      if (!isRunning) return;
      window.scrollBy({ top: CONFIG.autoScrollStep, left: 0, behavior: 'smooth' });
    }, CONFIG.autoScrollInterval);
  }
}

function stopObservers() {
  if (mo) { mo.disconnect(); mo = null; }
  if (io) { io.disconnect(); io = null; }
  if (autoScrollTimer) { clearInterval(autoScrollTimer); autoScrollTimer = null; }
}

/** ========== 验证码检测与暂停 ========== */
function detectCaptcha() {
  const hitText = CONFIG.captchaKeywords.some(k => (document.body.innerText || '').includes(k));
  const geetest =
    document.querySelector('.geetest_panel') ||
    document.querySelector('iframe[src*="geetest"]') ||
    document.querySelector('iframe[src*="captcha"]');
  return Boolean(hitText || geetest);
}

function handleCaptchaPause() {
  setStatus('检测到验证码，已暂停。请先完成验证，再点击“开始”继续。');
  const startBtn = document.getElementById('bili-start-btn');
  if (startBtn) startBtn.disabled = false;
  isRunning = false;
  chrome.runtime.sendMessage({ action: "stopProcess" });
}

/** ========== 任务控制：开始/停止 ========== */
function startClicking() {
  if (isRunning) return;
  isRunning = true;
  hasAlerted = false;
  links = [];
  seenIds.clear();

  const added = captureFromAnchors();
  startObservers();

  if ((added + links.length) === 0) {
    setStatus('未找到 https://www.bilibili.com/opus/... 或 https://t.bilibili.com/... 链接');
    isRunning = false;
    stopObservers();
    return;
  }

  chrome.runtime.sendMessage({ action: "startProcess", links });
  setStatus(`已发现 ${links.length} 条抽奖入口，开始处理…`);
  const startBtn = document.getElementById('bili-start-btn');
  if (startBtn) startBtn.disabled = true;
}

function stopClicking() {
  if (!isRunning) return;
  chrome.runtime.sendMessage({ action: "stopProcess" });
  isRunning = false;
  stopObservers();
  updateFloatingPanel(0);
  setStatus('已停止');
  const startBtn = document.getElementById('bili-start-btn');
  if (startBtn) startBtn.disabled = false;
}

/** ========== 元素定位 ========== */
function findInteractiveButtons(root = document) {
  // 结构/属性优先
  const structural = root.querySelectorAll('a[data-type="lottery"], a.lottery, button.lottery');
  const byText = Array.from(root.querySelectorAll('button, a, div'))
    .filter(el => VISIBLE(el) && CONFIG.entryTexts.some(k => normText(el.textContent).includes(k)));
  return Array.from(new Set([...Array.from(structural), ...byText]));
}

function findFollowRepostButtons(root = document) {
  const joinClass = root.querySelectorAll('.join-button');
  const byText = Array.from(root.querySelectorAll('button, a, div'))
    .filter(el => VISIBLE(el) && CONFIG.joinTexts.some(k => normText(el.textContent).includes(k)));
  return Array.from(new Set([...Array.from(joinClass), ...byText]));
}

/** ========== 点击“互动抽奖”入口 ========== */
async function clickInteractiveLotteryButton() {
  if (detectCaptcha()) { handleCaptchaPause(); return false; }

  // 先找，再做一次短时间等待（防止动画/延迟渲染）
  let candidates = findInteractiveButtons(document);
  if (candidates.length === 0) {
    const wrap = document.querySelector('.bili-popup__wrap') || document.body;
    candidates = findInteractiveButtons(wrap);
  }
  if (candidates.length === 0) {
    // 兜底：可见文本扫描
    const textLinks = Array.from(document.querySelectorAll('a, span, div'))
      .filter(el => VISIBLE(el) && CONFIG.entryTexts.some(k => (el.textContent || '').includes(k)));
    candidates = textLinks;
  }

  if (candidates.length === 0) return false;

  // 滚到视口中心，提高“人类化”
  candidates[0].scrollIntoView({ block: 'center', behavior: 'smooth' });

  const delay = JITTER(...CONFIG.delayClickEntry);
  setStatus('正在进入抽奖弹窗…');
  await wait(delay);
  if (detectCaptcha()) { handleCaptchaPause(); return false; }

  candidates[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  return true;
}

/** ========== 弹窗里的“关注并转发” ========== */
async function performLotteryAction(retryCount = 0) {
  if (detectCaptcha()) { handleCaptchaPause(); return false; }

  // 等弹窗出现
  const popupOk = await waitFor(() => {
    return document.querySelector('.bili-popup__wrap')
      || document.querySelector('iframe.bili-popup__content__browser, .bili-popup__content iframe');
  }, { timeout: CONFIG.popupAppearTimeout, interval: 150 });

  if (!popupOk) {
    if (retryCount < CONFIG.maxFindJoinRetries - 1) {
      await wait(500);
      return performLotteryAction(retryCount + 1);
    }
    // 弹窗都没出现，直接跳过
    chrome.runtime.sendMessage({ action: "notifyInteractionComplete" });
    return false;
  }

  // 在弹窗内找按钮（iframe 优先）
  let buttons = [];
  const iframe = document.querySelector('iframe.bili-popup__content__browser, .bili-popup__content iframe');
  if (iframe) {
    try {
      const doc = iframe.contentDocument || iframe.contentWindow?.document;
      if (doc) buttons = findFollowRepostButtons(doc);
    } catch (e) { /* 跨域则忽略，走外层 */ }
  }
  if (buttons.length === 0) {
    const wrap = document.querySelector('.bili-popup__wrap') || document;
    buttons = findFollowRepostButtons(wrap);
  }

  if (buttons.length === 0) {
    if (retryCount < CONFIG.maxFindJoinRetries - 1) {
      await wait(800);
      return performLotteryAction(retryCount + 1);
    }
    // 仍没找到，温柔跳过
    chrome.runtime.sendMessage({ action: "notifyInteractionComplete" });
    return false;
  }

  // 滚动至按钮 → 抖动 → 点击
  buttons[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
  const clickDelay = JITTER(...CONFIG.delayClickJoin);
  setStatus('即将关注并转发…');
  await wait(clickDelay);
  if (detectCaptcha()) { handleCaptchaPause(); return false; }

  buttons[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

  const completeDelay = JITTER(...CONFIG.delayAfterJoin);
  await wait(completeDelay);

  chrome.runtime.sendMessage({ action: "notifyInteractionComplete" });
  return true;
}

/** ========== 与 background 通信 ========== */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "updateCounter") {
    updateFloatingPanel(message.count);
    sendResponse?.({ success: true });
  }
  else if (message.action === "performLotteryInteraction") {
    (async () => {
      const startDelay = JITTER(500, 1000);
      setStatus('页面已加载，准备开始互动…');
      await wait(startDelay);

      if (detectCaptcha()) { handleCaptchaPause(); return sendResponse?.({ success: true }); }

      const entered = await clickInteractiveLotteryButton();
      if (!entered) {
        // 未找到入口，直接跳过
        chrome.runtime.sendMessage({ action: "notifyInteractionComplete" });
        return sendResponse?.({ success: true });
      }

      const popupDelay = JITTER(...CONFIG.delayFindPopup);
      await wait(popupDelay);
      await performLotteryAction(0);

      sendResponse?.({ success: true });
    })();
    return true; // 异步响应
  }
  else if (message.action === "processComplete") {
    isRunning = false;
    stopObservers();
    if (!hasAlerted) {
      hasAlerted = true;
      // 仅做状态提示，不打断用户
      setStatus('任务已完成！');
    }
    const startBtn = document.getElementById('bili-start-btn');
    if (startBtn) startBtn.disabled = false;
    sendResponse?.({ success: true });
  }
});

/** ========== 启动 ========== */
window.addEventListener('load', () => {
  createFloatingPanel();
});
