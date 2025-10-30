// ========== 全局状态 ==========
let intervalId = null;
let currentIndex = 0;
let links = [];              // ✅ 真正存页面上找到的所有 /opus/ 链接
let isRunning = false;

// ========== 创建悬浮面板 ==========
function createFloatingPanel() {
  if (document.getElementById('bili-floating-panel')) return;

  // 样式
  const style = document.createElement('style');
  style.textContent = `
    #bili-floating-panel {
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: #fff;
      color: #212121;
      padding: 0;
      border-radius: 8px;
      font-size: 14px;
      z-index: 99999;
      font-family: "Microsoft YaHei", "Segoe UI", sans-serif;
      box-shadow: 0 2px 10px rgba(0,0,0,0.15);
      width: 240px;
      transition: all 0.3s ease;
      overflow: hidden;
      border: 1px solid #e3e5e7;
    }
    #bili-panel-header {
      background: #FB7299;
      color: white;
      padding: 8px 12px;
      font-weight: bold;
      display: flex;
      justify-content: space-between;
      align-items: center;
      cursor: move;
      user-select: none;
      border-top-left-radius: 8px;
      border-top-right-radius: 8px;
    }
    #bili-panel-content {
      padding: 12px;
    }
    #bili-counter {
      background: #f4f4f4;
      border-radius: 4px;
      padding: 8px;
      margin: 8px 0;
      font-size: 13px;
      text-align: center;
    }
    #bili-status {
      font-size: 12px;
      margin-top: 8px;
      color: #6d757a;
      text-align: center;
      height: 16px;
    }
    .bili-btn {
      border: none;
      padding: 8px 0;
      margin: 0;
      cursor: pointer;
      background: #fff;
      color: #212121;
      font-size: 14px;
      border-radius: 4px;
      transition: all 0.2s;
      font-weight: bold;
      width: 49%;
      border: 1px solid #e3e5e7;
    }
    .bili-btn:hover {
      background: #f4f4f4;
    }
    #bili-start-btn {
      background: #FB7299;
      color: white;
      border: 1px solid #FB7299;
    }
    #bili-start-btn:hover {
      background: #fc85a8;
    }
    #bili-start-btn:disabled {
      background: #ffb6c9;
      cursor: not-allowed;
    }
    #bili-stop-btn:hover {
      color: #FB7299;
    }
    #bili-control-buttons {
      display: flex;
      justify-content: space-between;
      width: 100%;
    }
    #bili-close-btn {
      background: none;
      border: none;
      color: white;
      cursor: pointer;
      font-size: 16px;
      padding: 0;
      margin: 0;
      width: 24px;
      height: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    #bili-close-btn:hover {
      background: rgba(255,255,255,0.2);
      border-radius: 50%;
    }
    .progress-bar {
      height: 4px;
      background: #e3e5e7;
      border-radius: 2px;
      margin-top: 6px;
      overflow: hidden;
    }
    .progress-fill {
      height: 100%;
      background: #FB7299;
      width: 0%;
      transition: width 0.3s;
    }
  `;
  document.head.appendChild(style);

  // 面板
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
      <div class="progress-bar">
        <div class="progress-fill" id="bili-progress"></div>
      </div>
      <div id="bili-status">准备就绪</div>
    </div>
  `;

  document.body.appendChild(panel);

  // 事件
  document.getElementById('bili-start-btn').onclick = () => {
    startClicking();
  };
  
  document.getElementById('bili-stop-btn').onclick = () => {
    stopClicking();
  };
  
  document.getElementById('bili-close-btn').onclick = () => {
    panel.style.display = 'none';
  };

  // 拖动
  makeDraggable(panel);
}

// ========== 面板可拖动 ==========
function makeDraggable(element) {
  const header = document.getElementById('bili-panel-header');
  let isDragging = false;
  let offsetX, offsetY;

  header.addEventListener('mousedown', (e) => {
    isDragging = true;
    offsetX = e.clientX - element.getBoundingClientRect().left;
    offsetY = e.clientY - element.getBoundingClientRect().top;
  });

  document.addEventListener('mousemove', (e) => {
    if (isDragging) {
      element.style.left = (e.clientX - offsetX) + 'px';
      element.style.top = (e.clientY - offsetY) + 'px';
      element.style.right = 'auto';
      element.style.bottom = 'auto';
    }
  });

  document.addEventListener('mouseup', () => {
    isDragging = false;
  });
}

// ========== 更新面板 ==========
function updateFloatingPanel(val) {
  const counter = document.getElementById('bili-counter');
  const progress = document.getElementById('bili-progress');
  if (!counter) return;

  counter.textContent = `已执行：${val} 个`;
  
  if (links && links.length > 0) {
    const percentage = (val / links.length) * 100;
    progress.style.width = `${percentage}%`;
    
    const status = document.getElementById('bili-status');
    if (status) {
      if (val >= links.length) {
        status.textContent = '任务已完成！';
      } else if (isRunning) {
        status.textContent = `进行中 (${val}/${links.length})`;
      }
    }
  }
}

// ========== 开始抽奖 ==========
function startClicking() {
  if (isRunning) return;
  isRunning = true;

  // ✅ 只抓形如 https://www.bilibili.com/opus/123456789 的链接
  links = Array.from(document.querySelectorAll('a'))
    .map(a => a.href)
    .filter(href => {
      if (!href) return false;
      // 严格一点：域名 + /opus/ + 数字
      const opusRegex = /^https:\/\/www\.bilibili\.com\/opus\/\d+/;
      return opusRegex.test(href);
    });

  if (links.length === 0) {
    alert('未找到形如 https://www.bilibili.com/opus/... 的抽奖链接');
    isRunning = false;
    return;
  }

  // 通知 background 开始处理
  chrome.runtime.sendMessage({
    action: "startProcess",
    links: links
  });

  // 更新状态
  const status = document.getElementById('bili-status');
  if (status) status.textContent = `已发现 ${links.length} 条抽奖入口，开始处理...`;
  const startBtn = document.getElementById('bili-start-btn');
  if (startBtn) startBtn.disabled = true;
}

// ========== 停止抽奖 ==========
function stopClicking() {
  if (!isRunning) return;
  
  chrome.runtime.sendMessage({
    action: "stopProcess"
  });
  
  isRunning = false;
  updateFloatingPanel(0);

  const status = document.getElementById('bili-status');
  if (status) status.textContent = '已停止';
  const startBtn = document.getElementById('bili-start-btn');
  if (startBtn) startBtn.disabled = false;
}

// ========== 点“互动抽奖”入口 ==========
function clickInteractiveLotteryButton() {
  console.log("正在查找互动抽奖按钮...");

  // 1. 尝试标准类名
  const lotteryLinks = Array.from(document.querySelectorAll('a[data-type="lottery"], a.lottery'));

  // 2. 文本兜底
  const textLinks = Array.from(document.querySelectorAll('a, span, div'))
    .filter(el => el.textContent &&
           el.textContent.includes('互动抽奖') &&
           el.offsetParent !== null);

  const allButtons = [...lotteryLinks, ...textLinks];
  console.log(`找到 ${allButtons.length} 个可能的互动抽奖按钮`);

  if (allButtons.length > 0) {
    const randomDelay = Math.floor(Math.random() * 500) + 300;
    console.log(`将在${randomDelay}ms后点击互动抽奖按钮`);
    
    setTimeout(() => {
      allButtons[0].click();
      console.log('已点击互动抽奖按钮');
    }, randomDelay);
    
    return true;
  } else {
    // 没找到 → 稍微重试一次
    const retryDelay = Math.floor(Math.random() * 400) + 300;
    console.log(`未找到互动抽奖按钮，将在${retryDelay}ms后重试`);
    
    setTimeout(() => {
      const retryClassLinks = document.querySelectorAll('a[data-type="lottery"], a.lottery');
      const retryTextLinks = Array.from(document.querySelectorAll('a, span, div'))
        .filter(el => el.textContent && el.textContent.includes('互动抽奖') && el.offsetParent !== null);
      
      const retryButtons = [...Array.from(retryClassLinks), ...retryTextLinks];
      
      if (retryButtons.length > 0) {
        retryButtons[0].click();
        console.log('重试：已点击互动抽奖按钮');
        const nextDelay = Math.floor(Math.random() * 400) + 600;
        console.log(`将在${nextDelay}ms后查找关注按钮`);
        setTimeout(performLotteryAction, nextDelay);
      } else {
        console.log('重试仍未找到互动抽奖按钮，跳过当前页面');
        chrome.runtime.sendMessage({ action: "notifyInteractionComplete" });
      }
    }, retryDelay);
    
    return false;
  }
}

// ========== 弹窗里“关注并转发” ==========
function performLotteryAction(retryCount = 0) {
  console.log(`尝试查找关注并转发按钮... (尝试 ${retryCount + 1}/3)`);
  
  let buttons = [];
  
  // 1) iframe 里找
  const iframe = document.querySelector('iframe.bili-popup__content__browser');
  if (iframe) {
    try {
      const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
      const iframeButtons = [
        ...Array.from(iframeDoc.querySelectorAll('.join-button')),
        ...Array.from(iframeDoc.querySelectorAll('button, a, div')).filter(el =>
          el.textContent &&
          el.textContent.includes('关注UP主并转发抽奖动态') &&
          el.offsetParent !== null
        )
      ];
      buttons = iframeButtons;
    } catch (e) {
      console.error("访问iframe内容时出错:", e);
    }
  }
  
  // 2) 普通弹窗里找
  if (buttons.length === 0) {
    const popupWrap = document.querySelector('.bili-popup__wrap');
    if (popupWrap) {
      const popupButtons = [
        ...Array.from(popupWrap.querySelectorAll('.join-button')),
        ...Array.from(popupWrap.querySelectorAll('button, a, div')).filter(el =>
          el.textContent &&
          el.textContent.includes('关注UP主并转发抽奖动态') &&
          el.offsetParent !== null
        )
      ];
      buttons = popupButtons;
    }
  }
  
  if (buttons.length > 0) {
    const clickDelay = Math.floor(Math.random() * 600) + 600;
    console.log(`找到关注并转发按钮，将在${clickDelay}ms后点击`);
    
    setTimeout(() => {
      buttons[0].click();
      console.log('已点击关注并转发按钮');
      
      const completeDelay = Math.floor(Math.random() * 800) + 1200;
      console.log(`将在${completeDelay}ms后关闭页面`);
      
      setTimeout(() => {
        chrome.runtime.sendMessage({
          action: "notifyInteractionComplete"
        });
      }, completeDelay);
    }, clickDelay);
    
    return true;
  } else {
    // 没找到，最多 3 次
    if (retryCount < 2) {
      console.log(`未找到关注并转发按钮，将在1500ms后重试 (${retryCount + 1}/3)`);
      setTimeout(() => {
        performLotteryAction(retryCount + 1);
      }, 1500);
      return false;
    } else {
      console.log('重试3次后仍未找到关注并转发按钮，关闭页面返回合集');
      setTimeout(() => {
        chrome.runtime.sendMessage({
          action: "notifyInteractionComplete"
        });
      }, 800);
      return false;
    }
  }
}

// ========== 消息监听 ==========
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "updateCounter") {
    // 后台说：已经完成了第 message.count 个
    updateFloatingPanel(message.count);
    sendResponse({success: true});
  }
  else if (message.action === "performLotteryInteraction") {
    // 后台说：当前这个 tab 是真正的抽奖页，让你去点
    const startDelay = Math.floor(Math.random() * 500) + 500;
    console.log(`页面加载完成，将在${startDelay}ms后开始互动`);
    
    setTimeout(() => {
      if (clickInteractiveLotteryButton()) {
        const popupDelay = Math.floor(Math.random() * 500) + 1000;
        console.log(`已点击互动抽奖按钮，将在${popupDelay}ms后查找关注转发按钮`);
        
        setTimeout(performLotteryAction, popupDelay);
      } else {
        chrome.runtime.sendMessage({
          action: "notifyInteractionComplete"
        });
      }
    }, startDelay);
    sendResponse({success: true});
  }
  else if (message.action === "processComplete") {
    isRunning = false;
    alert('所有抽奖链接处理完成！');
    const startBtn = document.getElementById('bili-start-btn');
    if (startBtn) startBtn.disabled = false;
    const status = document.getElementById('bili-status');
    if (status) status.textContent = '任务已完成！';
    sendResponse({success: true});
  }
  return true;
});

// ========== 页面加载时插入面板 ==========
window.addEventListener('load', createFloatingPanel);
