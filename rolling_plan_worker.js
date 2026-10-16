'use strict';
let engine, release, marketDate, marketHash, checkedAt = 0, initialized = false;
let queue = Promise.resolve();
const progress = text => self.postMessage({progress: text});
async function digest(raw) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', raw))].map(b => b.toString(16).padStart(2, '0')).join(''); }
async function fetchBytes(name, cached = false) { const response = await fetch(name, {cache: cached ? 'force-cache' : 'no-store'}); if (!response.ok) throw new Error('公开数据读取失败，请稍后刷新'); return new Uint8Array(await response.arrayBuffer()); }
async function verified(name) { const bytes = await fetchBytes(name + '?sha256=' + release.files[name], true); if (await digest(bytes) !== release.files[name]) throw new Error('公开资源版本尚未一致，请稍后刷新'); return bytes; }
function unpack(raw) { return Uint8Array.from(atob(raw), c => c.charCodeAt(0)); }
async function prepare(books) {
  if (!engine) {
    progress('首次打开正在准备网页计算，完成后会保留本金与模拟记录…');
    importScripts('rolling-runtime/pyodide.js');
    engine = await loadPyodide({indexURL: new URL('rolling-runtime/', self.location.href).href});
    await engine.loadPackage('pandas');
  }
  if (!release || Date.now() - checkedAt > 60000) {
    progress('正在核验 GitHub 行情与计算资源…');
    release = JSON.parse(new TextDecoder().decode(await fetchBytes('data/cloud_static_release.json')));
    if (!initialized) {
      const runtime = JSON.parse(new TextDecoder().decode(await verified('data/rolling_runtime.json')));
      for (const item of runtime.files) {
        const name = item.path, encoded = item.content;
        if (!/^(?:[a-z0-9_]+\.py|research\/[a-z0-9_]+\.py|research\/reports\/[a-zA-Z0-9_\u4e00-\u9fff/]+\.(?:json|csv))$/.test(name)) throw new Error('计算资源路径无效');
        const raw = unpack(encoded);
        if (await digest(raw) !== item.sha256) throw new Error('计算资源哈希核验失败');
        const path = '/waxwing/' + name; engine.FS.mkdirTree(path.slice(0, path.lastIndexOf('/'))); engine.FS.writeFile(path, raw);
      }
      await engine.runPythonAsync("import sys; sys.path.insert(0, '/waxwing'); import rolling_plan_browser_bridge as bridge");
      engine.globals.set('saved_books', books);
      await engine.runPythonAsync('bridge.initialize(saved_books)');
      initialized = true;
    }
    const nextMarketHash = release.files['data/rolling_browser_market.json'];
    if (marketHash !== nextMarketHash) {
      const raw = await verified('data/rolling_browser_market.json');
      engine.globals.set('market_wrapper', new TextDecoder().decode(raw));
      engine.globals.set('source_version', release.source_version);
      marketDate = await engine.runPythonAsync('bridge.load_market(market_wrapper, source_version)');
      marketHash = nextMarketHash;
    }
    checkedAt = Date.now();
  }
}
self.onmessage = ({data}) => { queue = queue.catch(() => {}).then(async () => {
  try {
    await prepare(data.books);
    progress(data.route === 'history' ? '正在按本金核算历史股数、费用和收益…' : '正在核算模拟计划与逐日记录…');
    engine.globals.set('request_route', data.route);
    engine.globals.set('request_payload', JSON.stringify({...data.payload, market_date: marketDate}));
    const result = JSON.parse(await engine.runPythonAsync('bridge.handle(request_route, request_payload)'));
    self.postMessage({id: data.id, ...result});
  } catch (error) {
    const message = String(error.message || error).trim().split('\n').at(-1).replace(/^(?:ValueError|RuntimeError):\s*/, '');
    self.postMessage({id: data.id, error: message});
  }
}); };
