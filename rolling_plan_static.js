(function () {
  'use strict';
  if (!document.documentElement.hasAttribute('data-rolling-static')) return;
  const storageKey = 'waxwing_rolling_browser_books_v1', settingKey = 'waxwing_rolling_browser_settings_v1';
  let worker, sequence = 0, release, releaseAt=0, releasePending;
  const pending = new Map();
  async function currentRelease(){
    if(release&&Date.now()-releaseAt<60000)return release;
    if(!releasePending)releasePending=window.WaXwingRollingLoader.release().then(value=>{release=value;releaseAt=Date.now();return value;}).finally(()=>{releasePending=null;});
    return releasePending;
  }
  async function calendarOptions(){
    const selected=await currentRelease(), expected=selected.files['data/rolling_calendar.json'];
    if(!expected)return null; // Old published snapshots retain the worker path.
    const raw=await window.WaXwingRollingLoader.verified('data/rolling_calendar.json',expected);
    const calendar=JSON.parse(new TextDecoder().decode(raw));
    if(calendar.schema!=='rolling-calendar-v1'||calendar.source_version!==selected.source_version||calendar.date!==selected.date)throw new Error('公开交易日历版本不一致，请刷新重试');
    const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    const dates=calendar.dates.filter(day=>day>='2026-08-27'&&day<=today).sort();
    if(!dates.length)throw new Error('交易日历未覆盖可选起点');
    return {dates,default_start:dates.at(-1)};
  }
  function createWorker() {
    worker = new Worker('rolling_plan_worker.js');
    worker.onmessage = ({data}) => {
      if (data.progress) {
        if(pending.size){const historyOnly=[...pending.values()].every(task=>task.route==='history');document.getElementById(historyOnly?'historyBasis':'notice').textContent=data.progress;}
        return;
      }
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
    if(route.pathname==='/api/options'&&window.WaXwingRollingLoader){const value=await calendarOptions();if(value)return value;}
    if (!worker) createWorker();
    if (route.searchParams.has('capital')) payload.capital = Number(route.searchParams.get('capital'));
    if (route.searchParams.has('model')) payload.model = route.searchParams.get('model');
    const id = ++sequence;
    return new Promise((resolve, reject) => { pending.set(id, {resolve, reject,route:route.pathname.split('/').at(-1)});
      worker.postMessage({id, route: route.pathname.split('/').at(-1), payload,
        books: localStorage.getItem(storageKey) || '{}',
        release:release&&Date.now()-releaseAt<60000?release:null});
    });
  }};
})();
