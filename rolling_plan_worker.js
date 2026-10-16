'use strict';
let engine, release, marketDate, marketHash, checkedAt = 0, initialized = false;
let queue = Promise.resolve();
let quoteIndex, loadedQuotes = new Set(), loadedGroups = new Set();
const progress = text => self.postMessage({progress: text});
async function digest(raw) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', raw))].map(b => b.toString(16).padStart(2, '0')).join(''); }
importScripts('rolling_plan_loader.js');
const assetLoader = self.WaXwingRollingLoader;
assetLoader.progress(progress);
function unpack(raw) { return Uint8Array.from(atob(raw), c => c.charCodeAt(0)); }
async function readQuotes(books, selected, route, payload, reset) {
  if(!selected.files['data/rolling_quote_index.json'])return null;
  const index=!reset&&quoteIndex||JSON.parse(new TextDecoder().decode(await assetLoader.verified('data/rolling_quote_index.json',selected.files['data/rolling_quote_index.json'])));
  if(index.schema!=='rolling-quote-index-v1'||index.source_version!==selected.source_version||index.date!==selected.date)throw new Error('公开行情分包版本不一致，请刷新重试');
  const labels=route==='history'?['history']:[payload.model||'low_volatility'];
  if(route==='plan'&&payload.start_date<'2026-10-16')labels.push('history');
  const requests=[], covered=new Set(reset?[]:loadedQuotes), selectedGroups=[];
  for(const label of labels){
    const group=index.groups[label];
    if(!group)throw new Error('公开行情缺少当前模型数据，请刷新重试');
    group.codes.forEach(code=>covered.add(code));
    if(reset||!loadedGroups.has(label)){requests.push({...group});selectedGroups.push(label);}
  }
  const savedCodes=new Set();
  function visit(value){
    if(Array.isArray(value))value.forEach(visit);
    else if(value&&typeof value==='object'){if(/^\d{6}$/.test(String(value.code||'')))savedCodes.add(String(value.code));Object.values(value).forEach(visit);}
  }
  // Book values are JSON text. Only public stock-resource paths leave here.
  for(const text of Object.values(JSON.parse(books||'{}')))visit(typeof text==='string'?JSON.parse(text):text);
  for(const code of savedCodes){if(!covered.has(code)&&index.stocks[code]){requests.push({...index.stocks[code]});covered.add(code);}}
  if(requests.length)progress('正在读取当前模型及已有模拟持仓的行情…');
  let next=0;
  await Promise.all(Array.from({length:Math.min(4,requests.length)},async()=>{
    while(next<requests.length){
      const item=requests[next++];
      if(!/^data\/rolling_quotes\/[a-z0-9_]+\.json$/.test(item.path))throw new Error('公开行情分包路径无效');
      const raw=await assetLoader.verified(item.path,item.sha256);
      item.raw=new TextDecoder().decode(raw);
    }
  }));
  return {index,requests,covered,selectedGroups};
}
async function prepare(books, selectedRelease, route, payload) {
  const boot = engine ? Promise.resolve(engine) : assetLoader.engine().then(value => { engine = value; });
  const refresh = !release || Date.now() - checkedAt > 60000 || (selectedRelease && selectedRelease.source_version !== release.source_version);
  const reading = refresh ? (async () => {
    const selected = selectedRelease || await assetLoader.release();
    const marketName = selected.files['data/rolling_browser_market.json'] ? 'data/rolling_browser_market.json' : 'data/rolling_market.json';
    const nextHash = selected.files[marketName];
    const [runtime, market] = await Promise.all([
      initialized ? null : assetLoader.verified('data/rolling_runtime.json', selected.files['data/rolling_runtime.json']),
      marketHash === nextHash ? null : assetLoader.verified(marketName, nextHash)
    ]);
    return {selected, runtime, market, nextHash};
  })() : Promise.resolve(null);
  // Read the selected model while Python starts, rather than after it boots.
  const quotes = reading.then(assets=>readQuotes(books,assets?.selected||release,route,payload,!!assets?.market));
  const [assets, quoteAssets] = await Promise.all([reading, quotes, boot]);
  if (assets) release = assets.selected;
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
  if (assets?.market) {
    progress('行情已校验，正在载入本机计算…');
    engine.globals.set('market_wrapper', new TextDecoder().decode(assets.market));
    engine.globals.set('source_version', release.source_version);
    // Remove previous-version public quotes, preserving private paper books.
    await engine.runPythonAsync("import shutil; shutil.rmtree('/waxwing/cache/hist', ignore_errors=True); shutil.rmtree('/waxwing/cache/minute', ignore_errors=True)");
    marketDate = await engine.runPythonAsync('bridge.load_market(market_wrapper, source_version)');
    marketHash = assets.nextHash;
    quoteIndex = null; loadedQuotes.clear(); loadedGroups.clear();
  }
  if(quoteAssets){
    // Python operations stay serialized; the public downloads ran in parallel.
    for(const item of quoteAssets.requests){engine.globals.set('market_wrapper',item.raw);await engine.runPythonAsync('bridge.load_market(market_wrapper, source_version)');}
    quoteIndex=quoteAssets.index;
    quoteAssets.selectedGroups.forEach(label=>loadedGroups.add(label));loadedQuotes=quoteAssets.covered;
  }
  checkedAt = Date.now();
}
self.onmessage = ({data}) => { queue = queue.catch(() => {}).then(async () => {
  try {
    await prepare(data.books,data.release,data.route,data.payload);
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
