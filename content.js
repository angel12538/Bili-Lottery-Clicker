// ================================
// Bili Lottery Clicker - content.js
// - 同时支持 https://www.bilibili.com/opus/<id>
// - 以及 https://t.bilibili.com/<id>（统一规范化为 opus）
// - 悬浮面板 + 实时采集 + 风控/验证码检测 + 交互重试
// ================================

// ---------- 常量与工具 ----------
const OPUS_RE  = /^https:\/\/www\.bilibili\.com\/opus\/(\d+)(?:[?#].*)?$/;
const TDYN_RE  = /^https:\/\/t\.bilibili\.com\/(\d+)(?:[?#].*)?$/;

const JITTER = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const VISIBLE = (el) => el && el.offsetParent !== null;
const normalizeText = (s) => (s || "").replace(/\s+/g, "").trim();

// 把 t.bilibili.com/<id> 统一成 www.bilibili.com/opus/<id>
function normalizeLink(url) {
  const m1 = url.match(OPUS_RE);
  if (m1) return `https://www.bilibili.com/opus/${m1[1]}`;
  const m2 = url.match(TDYN_RE);
  if (m2) return `https://www.bilibili.com/opus/${m2[1]}`;
  return null;
}

// ---------- 全局状态 ----------
let links = [];          // 已收集的目标链接（统一为 opus 形式）
let isRunning = false;   // 当前是否在跑
let hasAlerted = false;  // 防止重复 alert
let mo = null;           // MutationObserver 用于动态页面持续采集

// ---------- UI：悬浮面板 ----------
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

  // 恢复面板位置（localStorage，不占扩展权限）
  const savedPos = localStorage.getItem('blc-panel-pos');
  if (savedPos) {
    try {
      const { left, top } = JSON.parse(savedPos);
      if (typeof left === 'number' && typeof top === 'number') {
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
    const left = e.clientX - offsetX;
    const top = e.clientY - offsetY;
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
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
  const counter = document.getElementById('bili-counter');
  const progress = document.getElementById('bili-progress');
  if (!counter) return;
  counter.textContent = `已执行：${done} 个`;
  if (links && links.length > 0 && progress) {
    const pct = Math.min(100, (done / links.length) * 100);
    progress.style.width = `${pct}%`;
    if (done >= links.length) setStatus('任务已完成！');
    else if (isRunning) setStatus(`进行中 (${done}/${links.length})`);
  }
}

// ---------- 链接采集 ----------
function collectOpusLinks() {
  const set = new Set(links); // 保留已采集
  const anchors = Array.from(document.querySelectorAll('a[href]'));
  for (const a of anchors) {
    const href = a.href;
    if (!href) continue;
    // 只接受符合规则的链接，然后统一规范化
    if (OPUS_RE.test(href) || TDYN_RE.test(href)) {
      const norm = normalizeLink(href);
      if (!norm) continue;
      // 排除当前页自身（无论当前是 opus 还是 t 链接）
      const hereNorm = normalizeLink(location.href);
      if (hereNorm && hereNorm === norm) continue;
      set.add(norm);
    }
  }
  links = Array.from(set);
}

function startObserver() {
  if (mo) return;
  mo = new MutationObserver(() => {
    if (!isRunning) return;
    collectOpusLinks();
  });
  mo.observe(document.body, { childList: true, subtree: true });
}

function stopObserver() {
  if (mo) {
    mo.disconnect();
    mo = null;
  }
}

// ---------- 验证码 / 安全验证 ----------
function detectCaptcha() {
  const keywords = ['验证码', '安全验证', '请完成验证', '点击验证', '机器人验证'];
  const textHit = keywords.some(k => document.body.innerText.includes(k));
  const geetest =
    document.querySelector('.geetest_panel') ||
    document.querySelector('iframe[src*="geetest"]') ||
    document.querySelector('iframe[src*="captcha"]');
  return Boolean(textHit || geetest);
}

function handleCaptchaPause() {
  setStatus('检测到验证码，已暂停，请手动完成后点“开始”继续');
  const startBtn = document.getElementById('bili-start-btn');
  if (startBtn) startBtn.disabled = false;
  isRunning = false;
  chrome.runtime.sendMessage({ action: "stopProcess" });
}

// ---------- 任务控制 ----------
function startClicking() {
  if (isRunning) return;
  isRunning = true;
  hasAlerted = false;

  collectOpusLinks();
  startObserver(); // 动态页面边跑边补链

  if (links.length === 0) {
    setStatus('未找到 https://www.bilibili.com/opus/... 或 https://t.bilibili.com/... 链接');
    isRunning = false;
    return;
  }

  chrome.runtime.sendMessage({ action: "startProcess", links });
  setStatus(`已发现 ${links.length} 条抽奖入口，开始处理...`);
  const startBtn = document.getElementById('bili-start-btn');
  if (startBtn) startBtn.disabled = true;
}

function stopClicking() {
  if (!isRunning) return;
  chrome.runtime.sendMessage({ action: "stopProcess" });
  isRunning = false;
  stopObserver();
  updateFloatingPanel(0);
  setStatus('已停止');
  const startBtn = document.getElementById('bili-start-btn');
  if (startBtn) startBtn.disabled = false;
}

// ---------- 元素查找 ----------
function findInteractiveButtons(root = document) {
  const list = [
    ...Array.from(root.querySelectorAll('a[data-type="lottery"], a.lottery, button.lottery')),
    ...Array.from(root.querySelectorAll('button, a, div')).filter((el) => {
      if (!VISIBLE(el)) return false;
      const t = normalizeText(el.textContent);
      return (
        t.includes('互动抽奖') ||
        t.includes('参与抽奖') ||
        t.includes('立即参与') ||
        t.includes('去参与')
      );
    })
  ];
  return Array.from(new Set(list));
}

function findFollowRepostButtons(root = document) {
  const list = [
    ...Array.from(root.querySelectorAll('.join-button')),
    ...Array.from(root.querySelectorAll('button, a, div')).filter((el) => {
      if (!VISIBLE(el)) return false;
      const t = normalizeText(el.textContent);
      return (
        t.includes('关注up主并转发抽奖动态') ||
        t.includes('关注并转发') ||
        t.includes('一键参与') ||
        t.includes('参与并转发')
      );
    })
  ];
  return Array.from(new Set(list));
}

// ---------- 点击“互动抽奖”入口 ----------
function clickInteractiveLotteryButton() {
  if (detectCaptcha()) {
    handleCaptchaPause();
    return false;
  }

  console.log("查找互动抽奖按钮...");
  let candidates = findInteractiveButtons(document);

  // 常见弹层容器兜底
  if (candidates.length === 0) {
    const wrap = document.querySelector('.bili-popup__wrap') || document.body;
    candidates = findInteractiveButtons(wrap);
  }

  // 再兜底：全局文本匹配（限制可见）
  if (candidates.length === 0) {
    const textLinks = Array.from(document.querySelectorAll('a, span, div'))
      .filter(el => VISIBLE(el) && /互动抽奖|参与抽奖|立即参与|去参与/.test(el.textContent || ''));
    candidates = textLinks;
  }

  console.log(`互动抽奖候选：${candidates.length} 个`);
  if (candidates.length === 0) return false;

  const delay = JITTER(300, 800);
  console.log(`将在 ${delay}ms 后点击互动抽奖按钮`);
  setTimeout(() => {
    if (detectCaptcha()) return handleCaptchaPause();
    candidates[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    console.log('已点击互动抽奖按钮');
  }, delay);

  return true;
}

// ---------- 弹窗里的“关注并转发” ----------
function performLotteryAction(retryCount = 0) {
  if (detectCaptcha()) {
    handleCaptchaPause();
    return false;
  }

  console.log(`查找关注并转发... (尝试 ${retryCount + 1}/3)`);
  let buttons = [];

  // 1) 弹层 iframe（同源时）
  const iframe = document.querySelector('iframe.bili-popup__content__browser, .bili-popup__content iframe');
  if (iframe) {
    try {
      const doc = iframe.contentDocument || iframe.contentWindow?.document;
      if (doc) {
        buttons = findFollowRepostButtons(doc);
      }
    } catch (e) {
      console.warn("访问 iframe 受限：", e);
    }
  }

  // 2) 普通弹窗容器
  if (buttons.length === 0) {
    const wrap = document.querySelector('.bili-popup__wrap') || document;
    buttons = findFollowRepostButtons(wrap);
  }

  if (buttons.length > 0) {
    const clickDelay = JITTER(600, 1200);
    console.log(`找到关注并转发按钮，将在 ${clickDelay}ms 后点击`);
    setTimeout(() => {
      if (detectCaptcha()) return handleCaptchaPause();
      buttons[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      console.log('已点击关注并转发按钮');
      const completeDelay = JITTER(1200, 2000);
      console.log(`将在 ${completeDelay}ms 后通知完成`);
      setTimeout(() => chrome.runtime.sendMessage({ action: "notifyInteractionComplete" }), completeDelay);
    }, clickDelay);
    return true;
  }

  if (retryCount < 2) {
    const wait = 1500;
    console.log(`未找到，${wait}ms 后重试`);
    setTimeout(() => performLotteryAction(retryCount + 1), wait);
    return false;
  }

  console.log('重试 3 次仍未找到，跳过此页');
  setTimeout(() => chrome.runtime.sendMessage({ action: "notifyInteractionComplete" }), 600);
  return false;
}

// ---------- 与 background 消息通信 ----------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "updateCounter") {
    updateFloatingPanel(message.count);
    sendResponse?.({ success: true });
  }
  else if (message.action === "performLotteryInteraction") {
    const startDelay = JITTER(500, 1000);
    console.log(`页面加载完成，${startDelay}ms 后开始互动`);
    setTimeout(() => {
      if (detectCaptcha()) {
        handleCaptchaPause();
        return sendResponse?.({ success: true });
      }
      if (clickInteractiveLotteryButton()) {
        const popupDelay = JITTER(1000, 1500);
        console.log(`已点击入口，${popupDelay}ms 后查找关注并转发`);
        setTimeout(() => performLotteryAction(0), popupDelay);
      } else {
        chrome.runtime.sendMessage({ action: "notifyInteractionComplete" });
      }
    }, startDelay);
    return true; // 异步响应
  }
  else if (message.action === "processComplete") {
    isRunning = false;
    stopObserver();
    if (!hasAlerted) {
      hasAlerted = true;
      try { alert('所有抽奖链接处理完成！'); } catch {}
    }
    const startBtn = document.getElementById('bili-start-btn');
    if (startBtn) startBtn.disabled = false;
    setStatus('任务已完成！');
    sendResponse?.({ success: true });
  }
});

// ---------- 启动 ----------
window.addEventListener('load', () => {
  createFloatingPanel();
});
