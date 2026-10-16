(function () {
  'use strict';
  if (!document.documentElement.hasAttribute('data-rolling-static')) return;
  const storageKey = 'waxwing_rolling_browser_books_v1', settingKey = 'waxwing_rolling_browser_settings_v1';
  let worker, sequence = 0;
  const pending = new Map();
  function createWorker() {
    worker = new Worker('rolling_plan_worker.js');
    worker.onmessage = ({data}) => {
      if (data.progress) { document.getElementById('notice').textContent = data.progress; return; }
      const task = pending.get(data.id); if (!task) return;
      pending.delete(data.id);
      if (data.error) { task.reject(new Error(data.error)); return; }
      try { if (data.books) localStorage.setItem(storageKey, JSON.stringify(data.books)); }
      catch (_) { task.reject(new Error('浏览器未允许保存模拟记录，请允许此网站存储后重试')); return; }
      task.resolve(data.value);
    };
    worker.onerror = () => { for (const task of pending.values()) task.reject(new Error('网页计算未能加载，请刷新重试')); pending.clear(); worker.terminate(); worker = null; };
  }
  window.WaXwingRollingStatic = {async request(url, options = {}) {
    const route = new URL(url, location.href), payload = JSON.parse(options.body || '{}');
    if (route.pathname === '/api/settings') {
      if (options.method === 'POST') localStorage.setItem(settingKey, JSON.stringify({capital: payload.capital}));
      const stored = JSON.parse(localStorage.getItem(settingKey) || 'null');
      return stored && Number.isFinite(stored.capital) && stored.capital >= 100 ? stored : {capital: 50000};
    }
    if (!worker) createWorker();
    if (route.searchParams.has('capital')) payload.capital = Number(route.searchParams.get('capital'));
    if (route.searchParams.has('model')) payload.model = route.searchParams.get('model');
    const id = ++sequence;
    return new Promise((resolve, reject) => { pending.set(id, {resolve, reject});
      worker.postMessage({id, route: route.pathname.split('/').at(-1), payload,
        books: localStorage.getItem(storageKey) || '{}'});
    });
  }};
})();
