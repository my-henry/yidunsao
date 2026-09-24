(function() {
  const presetGrammars = [
    'body="vless://"&&title="Index of /"',
    'body="vless://"&&title="Directory listing for /"',
    'body="sub.txt"&&title="Index of /"',
    'body="sub.txt"&&title="Directory listing for /"',
    'body="vless://"&&title="Subscription"',
    'body="vless://"&&title="sub"',
    'body="vless://"&&title="xray"',
    'body="vless://"&&title="Manager"',
    'body="vless://"&&body="&encryption="&&body="&sni"&&body="&type="'
  ];

  const grammarInput = document.getElementById('customGrammar');
  const grammarMenu = document.getElementById('grammarMenu');
  const dropdown = grammarMenu.closest('mdui-dropdown');
  function renderMenu() {
    grammarMenu.innerHTML = '';
    presetGrammars.forEach(grammar => {
      const item = document.createElement('mdui-menu-item');
      item.textContent = grammar;
      item.classList.add('grammar-menu-item');
      item.addEventListener('click', function(e) {
        grammarInput.value = grammar;
        grammarInput.dispatchEvent(new Event('input', { bubbles: true }));
        if (dropdown) dropdown.open = false;
      });
      grammarMenu.appendChild(item);
    });
  }
  renderMenu();
  const syntaxHelpBtn = document.getElementById('syntaxHelpBtn');
  const syntaxDialog = document.getElementById('syntaxHelpDialog');
  const closeSyntaxHelp = document.getElementById('closeSyntaxHelp');

  syntaxHelpBtn.addEventListener('click', function() {
    syntaxDialog.open = true;
  });
  closeSyntaxHelp.addEventListener('click', function() {
    syntaxDialog.open = false;
  });

  function getCurrentGrammar() {
    return grammarInput.value.trim();
  }

  document.getElementById('searchFofa').addEventListener('click', function() {
    const grammar = getCurrentGrammar();
    if (!grammar) {
      mdui.snackbar({ message: '请输入或选择搜索语法', placement: 'top' });
      return;
    }
    const base64 = btoa(unescape(encodeURIComponent(grammar)));
    const url = `https://fofa.info/result?qbase64=${encodeURIComponent(base64)}`;
    window.open(url, '_blank');
  });

  document.getElementById('searchThreatbook').addEventListener('click', function() {
    const grammar = getCurrentGrammar();
    if (!grammar) {
      mdui.snackbar({ message: '请输入或选择搜索语法', placement: 'top' });
      return;
    }
    const url = `https://x.threatbook.com/v5/survey?q=${encodeURIComponent(grammar)}`;
    window.open(url, '_blank');
  });

  const depthSlider = document.getElementById('depthSlider');
  const timeoutSlider = document.getElementById('timeoutSlider');
  const concurrencySlider = document.getElementById('concurrencySlider');
  const depthValue = document.getElementById('depthValue');
  const timeoutValue = document.getElementById('timeoutValue');
  const concurrencyValue = document.getElementById('concurrencyValue');

  function syncSliderDisplay(slider, displaySpan) {
    if (!slider || !displaySpan) return;
    const update = () => { displaySpan.innerText = slider.value; };
    slider.addEventListener('input', update);
    slider.addEventListener('change', update);
    update();
  }
  syncSliderDisplay(depthSlider, depthValue);
  syncSliderDisplay(timeoutSlider, timeoutValue);
  syncSliderDisplay(concurrencySlider, concurrencyValue);

  function getSliderValue(slider) {
    return parseInt(slider.value, 10);
  }

  let totalUrls = 0;
  let isScanning = false;
  let isPaused = false;
  let currentFileBlob = null;
  let currentFileOriginal = null;

  let currentSessionId = null;
  let currentWs = null;
  let abortController = null;

  const progressContainer = document.getElementById('progressContainer');
  const scanProgress = document.getElementById('scanProgress');
  const progressPercent = document.getElementById('progressPercent');
  const statScanned = document.getElementById('statScanned');
  const statSuccess = document.getElementById('statSuccess');
  const statFailed = document.getElementById('statFailed');
  const statNodes = document.getElementById('statNodes');
  const logField = document.getElementById('log');
  const resultField = document.getElementById('result');
  const foundNodes = new Set();

  const startBtn = document.getElementById('startBtn');
  const pauseBtn = document.getElementById('pauseBtn');
  const stopBtn = document.getElementById('stopBtn');

  let currentSubUrl = '';

  function setButtonsEnabled(scanning) {
    startBtn.disabled = scanning;
    pauseBtn.disabled = !scanning;
    stopBtn.disabled = !scanning;
    if (!scanning) {
      if (isPaused) {
        isPaused = false;
        pauseBtn.icon = 'pause';
        pauseBtn.textContent = '暂停';
      }
    }
  }

  function appendToTextField(field, text) {
    if (!field) return;
    let current = field.value || '';
    field.value = current + text + '\n';
    
    const innerTextarea = field.shadowRoot?.querySelector('textarea');
    if (innerTextarea) {
      innerTextarea.scrollTo({ top: innerTextarea.scrollHeight, behavior: 'smooth' });
    }
    
    field.classList.remove('flash-animation');
    void field.offsetWidth;
    field.classList.add('flash-animation');
    setTimeout(() => field.classList.remove('flash-animation'), 400);
  }

  function updateStatsUI(data) {
    statScanned.innerText = data.scanned ?? 0;
    statSuccess.innerText = data.success ?? 0;
    statFailed.innerText = data.failed ?? 0;
    statNodes.innerText = data.nodes ?? 0;
  }

  function generateSessionId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return 'id-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
  }

  function connectWebSocket(sessionId) {
    return new Promise((resolve, reject) => {
      if (currentWs && currentWs.readyState === WebSocket.OPEN) {
        currentWs.close();
      }
      const ws = new WebSocket(`ws://${location.host}?sessionId=${sessionId}`);
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('WebSocket 连接超时'));
      }, 5000);
      ws.onopen = () => {
        clearTimeout(timeout);
        currentWs = ws;
        resolve(ws);
      };
      ws.onerror = (err) => {
        clearTimeout(timeout);
        reject(err);
      };
      ws.onclose = () => {
        clearTimeout(timeout);
        if (currentWs === ws) currentWs = null;
        if (isScanning) {
          finishScan('WebSocket 连接已断开，扫描终止');
        }
      };
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'log') {
          appendToTextField(logField, msg.data);
        }
        if (msg.type === 'node') {
          if (!foundNodes.has(msg.data)) {
            foundNodes.add(msg.data);
            appendToTextField(resultField, msg.data);
          }
        }
        if (msg.type === 'stats') {
          updateStatsUI(msg.data);
          if (totalUrls > 0) {
            const scanned = msg.data.scanned || 0;
            const percent = Math.min(100, Math.floor((scanned / totalUrls) * 100));
            if (scanProgress) scanProgress.value = percent;
            if (progressPercent) progressPercent.innerText = `${percent}%`;
          }
        }
      };
    });
  }

  function showProgressWithTotal(total) {
    if (!scanProgress) return;
    scanProgress.removeAttribute('indeterminate');
    scanProgress.max = 100;
    scanProgress.value = 0;
    progressPercent.innerText = '0%';
    progressContainer.style.display = 'block';
  }

  function hideProgress() {
    progressContainer.style.display = 'none';
    if (scanProgress) scanProgress.value = 0;
    if (progressPercent) progressPercent.innerText = '0%';
  }

  function finishScan(message) {
    if (!isScanning) return;
    isScanning = false;
    isPaused = false;
    setButtonsEnabled(false);
    hideProgress();
    if (currentWs) {
      currentWs.close();
      currentWs = null;
    }
    appendToTextField(logField, `[系统] ${message}`);
    mdui.snackbar({ message: message, placement: 'top' });
  }

  function extractUrlsFromJson(obj, collected = new Set()) {
    if (obj === null || typeof obj !== 'object') return collected;
    if (Array.isArray(obj)) {
      for (const item of obj) extractUrlsFromJson(item, collected);
    } else {
      for (const [key, value] of Object.entries(obj)) {
        if ((key === 'URL' || key === 'host') && typeof value === 'string' && value.trim().length > 0) {
          collected.add(value.trim());
        }
        if (value && typeof value === 'object') extractUrlsFromJson(value, collected);
      }
    }
    return collected;
  }

  function urlsToText(urlsSet) {
    return Array.from(urlsSet).join('\n');
  }

  const fileInput = document.getElementById('fileInput');
  const selectFileBtn = document.getElementById('selectFileBtn');
  const fileNameDisplay = document.getElementById('fileNameDisplay');

  selectFileBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) {
      fileNameDisplay.innerText = '未选择任何文件';
      currentFileBlob = null;
      currentFileOriginal = null;
      totalUrls = 0;
      return;
    }
    fileNameDisplay.innerText = file.name;
    currentFileOriginal = file;

    const isJson = file.name.toLowerCase().endsWith('.json') || file.type === 'application/json';
    if (!isJson) {
      currentFileBlob = file;
      const text = await file.text();
      const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
      totalUrls = lines.length;
      console.log(`[TXT] 有效 URL 数量: ${totalUrls}`);
      return;
    }

    try {
      const text = await file.text();
      let jsonObj;
      try {
        jsonObj = JSON.parse(text);
      } catch (parseErr) {
        mdui.snackbar({ message: 'JSON 解析失败，将作为纯文本处理', placement: 'top' });
        currentFileBlob = file;
        const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
        totalUrls = lines.length;
        return;
      }
      const urlsSet = extractUrlsFromJson(jsonObj);
      if (urlsSet.size === 0) {
        mdui.snackbar({ message: '未找到 "URL" 或 "host" 字段，将作为纯文本处理', placement: 'top' });
        currentFileBlob = file;
        const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
        totalUrls = lines.length;
        return;
      }
      const textContent = urlsToText(urlsSet);
      const blob = new Blob([textContent], { type: 'text/plain' });
      currentFileBlob = new File([blob], file.name.replace(/\.json$/i, '.txt'), { type: 'text/plain' });
      totalUrls = urlsSet.size;
      console.log(`[JSON] 提取到 ${totalUrls} 个 URL/host 条目`);
      mdui.snackbar({ message: `从 JSON 中提取到 ${totalUrls} 个地址`, placement: 'top' });
    } catch (err) {
      console.error(err);
      mdui.snackbar({ message: '读取文件失败，回退文本模式', placement: 'top' });
      currentFileBlob = file;
      const text = await file.text();
      const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
      totalUrls = lines.length;
    }
  });

  async function startScan() {
    if (isScanning) {
      mdui.snackbar({ message: '扫描进行中，请稍后', placement: 'top' });
      return;
    }
    if (!currentFileBlob) {
      mdui.snackbar({ message: '请先选择一个文件（.txt 或 .json）', placement: 'top' });
      return;
    }
    if (totalUrls === 0) {
      mdui.snackbar({ message: '文件中没有有效的 URL 条目', placement: 'top' });
      return;
    }

    foundNodes.clear();
    if (logField) logField.value = '';
    if (resultField) resultField.value = '';
    updateStatsUI({ scanned: 0, success: 0, failed: 0, nodes: 0 });
    showProgressWithTotal(totalUrls);
    isScanning = true;
    isPaused = false;
    setButtonsEnabled(true);
    pauseBtn.icon = 'pause';
    pauseBtn.textContent = '暂停';
    currentSubUrl = '';

    const sessionId = generateSessionId();
    console.log('[DEBUG] 生成 sessionId:', sessionId);

    abortController = new AbortController();

    try {
      await connectWebSocket(sessionId);
      console.log('[DEBUG] WebSocket 连接成功');
    } catch (err) {
      console.error('[DEBUG] WebSocket 连接失败:', err);
      mdui.snackbar({ message: 'WebSocket 连接失败: ' + err.message, placement: 'top' });
      finishScan('WebSocket 连接失败');
      return;
    }

    const formData = new FormData();
    formData.append('file', currentFileBlob);
    formData.append('subscription', document.getElementById('subscription').checked);
    formData.append('html', document.getElementById('html').checked);
    formData.append('traverse', document.getElementById('traverse').checked);
    formData.append('extensions', document.getElementById('extensions').value);
    formData.append('depth', getSliderValue(depthSlider));
    formData.append('timeout', getSliderValue(timeoutSlider));
    formData.append('concurrency', getSliderValue(concurrencySlider));
    formData.append('ignoreSSL', document.getElementById('ignoreSSL').checked);

    try {
      const resp = await fetch(`/scan?sessionId=${encodeURIComponent(sessionId)}`, {
        method: 'POST',
        body: formData,
        signal: abortController.signal
      });
      const json = await resp.json();

      if (json.subUrl) {
        currentSubUrl = json.subUrl;
        appendToTextField(logField, `[订阅链接] ${currentSubUrl}`);
        console.log('[订阅链接]', currentSubUrl);
      } else {
        console.warn('后端未返回 subUrl');
      }

      if (!json.success) {
        mdui.snackbar({ message: json.error || '扫描失败', placement: 'top' });
        appendToTextField(logField, `[错误] ${json.error || '扫描失败'}`);
        finishScan('扫描失败');
        return;
      }
      finishScan('扫描完成');
    } catch (err) {
      if (err.name === 'AbortError') {
        console.log('Fetch 请求被用户中止');
      } else {
        mdui.snackbar({ message: err.message, placement: 'top' });
        appendToTextField(logField, `[请求错误] ${err.message}`);
        finishScan('请求错误: ' + err.message);
      }
    }
  }

  function togglePause() {
    if (!isScanning) return;
    isPaused = !isPaused;
    if (isPaused) {
      pauseBtn.icon = 'play_arrow';
      pauseBtn.textContent = '继续';
      if (currentWs && currentWs.readyState === WebSocket.OPEN) {
        currentWs.send(JSON.stringify({ type: 'control', action: 'pause' }));
        mdui.snackbar({ message: '已发送暂停指令，后端将暂停新任务', placement: 'top' });
      } else {
        mdui.snackbar({ message: 'WebSocket 未连接，无法暂停', placement: 'top' });
      }
    } else {
      pauseBtn.icon = 'pause';
      pauseBtn.textContent = '暂停';
      if (currentWs && currentWs.readyState === WebSocket.OPEN) {
        currentWs.send(JSON.stringify({ type: 'control', action: 'resume' }));
        mdui.snackbar({ message: '已发送恢复指令，扫描将继续', placement: 'top' });
      } else {
        mdui.snackbar({ message: 'WebSocket 未连接，无法继续', placement: 'top' });
      }
    }
  }

  function stopScan() {
    if (!isScanning) return;
    if (currentWs && currentWs.readyState === WebSocket.OPEN) {
      currentWs.send(JSON.stringify({ type: 'control', action: 'stop' }));
    }
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    if (currentWs) {
      currentWs.close();
      currentWs = null;
    }
    finishScan('用户终止扫描');
  }

  startBtn.addEventListener('click', startScan);
  pauseBtn.addEventListener('click', togglePause);
  stopBtn.addEventListener('click', stopScan);

  const copyBtn = document.getElementById('copyBtn');
  copyBtn.addEventListener('click', async () => {
    const text = resultField.value;
    if (!text.trim()) {
      mdui.snackbar({ message: '暂无节点内容', placement: 'top' });
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      mdui.snackbar({ message: '已复制到剪贴板', placement: 'top' });
    } catch (err) {
      mdui.snackbar({ message: '复制失败，请手动复制', placement: 'top' });
    }
  });

  const exportBtn = document.getElementById('exportBtn');
  exportBtn.addEventListener('click', () => {
    const content = resultField.value;
    if (!content.trim()) {
      mdui.snackbar({ message: '无数据可导出', placement: 'top' });
      return;
    }
    const blob = new Blob([content], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `nodes_${new Date().toISOString().slice(0,19).replace(/:/g, '-')}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
    mdui.snackbar({ message: '导出成功', placement: 'top' });
  });

  const copySubUrlBtn = document.getElementById('copySubUrlBtn');
  copySubUrlBtn.addEventListener('click', async () => {
    if (!currentSubUrl) {
      mdui.snackbar({ message: '暂无订阅链接，请先完成一次扫描', placement: 'top' });
      return;
    }

    const copyToClipboard = (text) => {
      return new Promise((resolve, reject) => {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(resolve).catch(reject);
        } else {
          reject(new Error('Clipboard API not available'));
        }
      });
    };

    const fallbackCopy = (text) => {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.top = '-9999px';
      textarea.style.left = '-9999px';
      document.body.appendChild(textarea);
      textarea.select();
      let success = false;
      try {
        success = document.execCommand('copy');
      } catch (err) {
        console.error('execCommand 复制失败', err);
      }
      document.body.removeChild(textarea);
      return success;
    };

    try {
      await copyToClipboard(currentSubUrl);
      mdui.snackbar({ message: '订阅链接已复制', placement: 'top' });
    } catch (err) {
      console.warn('Clipboard API 复制失败，尝试降级方案', err);
      const success = fallbackCopy(currentSubUrl);
      if (success) {
        mdui.snackbar({ message: '订阅链接已复制', placement: 'top' });
      } else {
        mdui.dialog({
          title: '复制失败',
          content: `无法自动复制到剪贴板，请手动复制以下链接：<br><br><code style="word-break:break-all;">${escapeHtml(currentSubUrl)}</code>`,
          buttons: [{ text: '关闭' }]
        });
      }
    }
  });

  const importClashBtn = document.getElementById('importClashBtn');
  if (importClashBtn) {
    importClashBtn.addEventListener('click', function() {
      if (!currentSubUrl) {
        mdui.snackbar({ message: '暂无订阅链接，请先完成一次扫描', placement: 'top' });
        return;
      }

      const encodedSubUrl = encodeURIComponent(currentSubUrl);
      const convertedUrl = `https://sub.id9.cc/sub?target=clash&url=${encodedSubUrl}&insert=false&config=https%3A%2F%2Fraw.githubusercontent.com%2FACL4SSR%2FACL4SSR%2Fmaster%2FClash%2Fconfig%2FACL4SSR_Online.ini&emoji=true&list=false&tfo=false&scv=true&fdn=false&expand=true&sort=false&new_name=true`;

      const clashProtocolUrl = `clash://install-config?url=${encodeURIComponent(convertedUrl)}`;
      window.open(clashProtocolUrl, '_blank');

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(convertedUrl).then(() => {
          mdui.snackbar({
            message: '已尝试自动导入，同时转换后的订阅链接已复制，若未自动弹出请手动添加',
            placement: 'top',
            duration: 5000
          });
        }).catch(() => {
          mdui.snackbar({ message: '已尝试自动导入，若未弹出请手动复制链接添加', placement: 'top' });
        });
      } else {
        mdui.snackbar({ message: '已尝试自动导入，若未弹出请手动复制链接添加', placement: 'top' });
      }
    });
  }

  function escapeHtml(str) {
    return str.replace(/[&<>]/g, function(m) {
      if (m === '&') return '&amp;';
      if (m === '<') return '&lt;';
      if (m === '>') return '&gt;';
      return m;
    }).replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, function(c) {
      return c;
    });
  }

  const versionBadge = document.getElementById('versionBadge');
  const versionDialog = document.getElementById('versionDialog');
  const closeVersionDialog = document.getElementById('closeVersionDialog');
  if (versionBadge && versionDialog) {
    versionBadge.addEventListener('click', () => {
      versionDialog.open = true;
    });
    if (closeVersionDialog) {
      closeVersionDialog.addEventListener('click', () => {
        versionDialog.open = false;
      });
    }
  }

  setButtonsEnabled(false);
})();