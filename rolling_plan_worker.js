'use strict';
let engine, release, marketDate, marketHash, checkedAt = 0, initialized = false;
let queue = Promise.resolve();
const progress = text => self.postMessage({progress: text});
async function digest(raw) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', raw))].map(b => b.toString(16).padStart(2, '0')).join(''); }
importScripts('rolling_plan_loader.js');
const assetLoader = self.WaXwingRollingLoader;
assetLoader.progress(progress);
function unpack(raw) { return Uint8Array.from(atob(raw), c => c.charCodeAt(0)); }
async function prepare(books) {
  const boot = engine ? Promise.resolve(engine) : assetLoader.engine().then(value => { engine = value; });
  const refresh = !release || Date.now() - checkedAt > 60000;
  const reading = refresh ? (async () => {
    const selected = await assetLoader.release();
    const marketName = selected.files['data/rolling_browser_market.json'] ? 'data/rolling_browser_market.json' : 'data/rolling_market.json';
    const nextHash = selected.files[marketName];
    const [runtime, market] = await Promise.all([
      initialized ? null : assetLoader.verified('data/rolling_runtime.json', selected.files['data/rolling_runtime.json']),
      marketHash === nextHash ? null : assetLoader.verified(marketName, nextHash)
    ]);
    return {selected, runtime, market, nextHash};
  })() : Promise.resolve(null);
  const [assets] = await Promise.all([reading, boot]);
  if (!assets) return;
  release = assets.selected;
  if (!initialized) {
    progress('正在校验计算规则与本机模拟记录…');
    const runtime = JSON.parse(new TextDecoder().decode(assets.runtime));
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
  if (assets.market) {
    progress('行情已校验，正在载入本机计算…');
    engine.globals.set('market_wrapper', new TextDecoder().decode(assets.market));
    engine.globals.set('source_version', release.source_version);
    marketDate = await engine.runPythonAsync('bridge.load_market(market_wrapper, source_version)');
    marketHash = assets.nextHash;
  }
  checkedAt = Date.now();
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
