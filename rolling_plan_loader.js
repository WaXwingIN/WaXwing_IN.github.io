/* Public, hash-verified browser assets; paper accounts never leave this browser. */
(function () {
  'use strict';
  const files = {"pyodide-lock.json":{"sha256":"9c45b916001a750f4102fc287494f3eab215909c7535c626a20db80fd6333e2c","size":112205},"pyodide.js":{"sha256":"b4cb23a53aba19c221659b9fb40a2f18281d685691dc06647fb0afd0681baf98","size":14913},"pyodide.asm.js":{"sha256":"6b4c90de5b7172873f04f21884d0e9d2274e305fe32116558fe3e4fbe3618d51","size":1255688,"gzip":"0eadbe9df958acb8b2b6c628c8c75f73a448d66ae9febd80b6e3f52b6321e2da"},"pyodide.asm.wasm":{"sha256":"a50dd1843f805a0b7c45b61037ee0d7b26dfe85efe0e18ef95a34ad24e401f5f","size":10105545,"gzip":"eb4da3ce7f3d4aea84ef266a0c68dbf9491394967e7721ea13013972dd2713ab"},"python_stdlib.zip":{"sha256":"16611534726e5d8ac2bd8f926410b2dcb8d6f49aa24913463533b457a2115c16","size":2360737},"pandas-2.2.3-cp312-cp312-pyodide_2024_0_wasm32.whl":{"sha256":"5502f0f94f93a482b851d0b8ca43be692c1b8d20215a168313656847ff74d63a","size":5707178},"numpy-2.0.2-cp312-cp312-pyodide_2024_0_wasm32.whl":{"sha256":"ebb61241d962b98b21597d7ce43b67668a6d5bab3acec4fbe958657320d7cd08","size":3061133},"python_dateutil-2.9.0.post0-py2.py3-none-any.whl":{"sha256":"02811ea3714f6697d639c07dc5ec63f5774dc7a688e4e1cbbe9beb2f33c3e6c9","size":229892},"pytz-2024.1-py2.py3-none-any.whl":{"sha256":"fcfc168155da8d19057b17bee735fef71dc3a39f1dccd83514e16ecc6abaddc4","size":505474},"six-1.16.0-py2.py3-none-any.whl":{"sha256":"f61235bc3a15086f0369585e5071ae9ba0bd244a111d12b37f683862e6850c0a","size":11053}};
  const originalFetch = self.fetch.bind(self), base = new URL('./', self.location.href);
  const cacheName = 'waxwing-rolling-components-v1', inflight = new Map(), bytesLoaded = new Map();
  let enginePromise, report = () => {}, lastReport = 0;
  const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
  const mime = name => name.endsWith('.wasm') ? 'application/wasm' : name.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
  function downloaded(name, size) {
    bytesLoaded.set(name, Math.max(bytesLoaded.get(name) || 0, size));
    if (Date.now() - lastReport < 250) return;
    lastReport = Date.now();
    const loaded = [...bytesLoaded.values()].reduce((a, b) => a + b, 0) / 1048576;
    report(`正在准备网页计算，已读取 ${loaded.toFixed(1)} MB，完成的组件会保存在浏览器…`);
  }
  async function cacheRead(name, expected) {
    try {
      const cache = await caches.open(cacheName), key = new URL('rolling-cache/' + expected + '/' + name, base).href;
      const response = await cache.match(key);
      if (!response) return null;
      const raw = new Uint8Array(await response.arrayBuffer());
      if (await hash(raw) === expected) { downloaded(name, raw.length); return raw; }
      await cache.delete(key);
    } catch (_) { /* Storage restrictions do not prevent calculation. */ }
    return null;
  }
  async function cacheWrite(name, expected, raw) {
    try {
      const cache = await caches.open(cacheName), key = new URL('rolling-cache/' + expected + '/' + name, base).href;
      await cache.put(key, new Response(raw, {headers: {'Content-Type': mime(name)}}));
      const versions = (await cache.keys()).filter(request => new URL(request.url).pathname.endsWith('/' + name));
      for (const old of versions.slice(0, -2)) await cache.delete(old);
    } catch (_) { /* The verified bytes remain usable without persistent storage. */ }
  }
  async function candidate(item, expected, name, controller) {
    let idle;
    const reset = () => { clearTimeout(idle); idle = setTimeout(() => controller.abort(), 15000); };
    const deadline = setTimeout(() => controller.abort(), 45000);
    reset();
    try {
      const response = await originalFetch(item.url, {cache: 'force-cache', credentials: 'omit', signal: controller.signal});
      if (!response.ok) throw new Error('资源请求失败');
      const reader = response.body.getReader(), chunks = []; let size = 0;
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        reset(); chunks.push(part.value); size += part.value.byteLength; downloaded(name, size);
      }
      let raw = new Uint8Array(size), at = 0;
      for (const part of chunks) { raw.set(part, at); at += part.byteLength; }
      if (item.gzip && await hash(raw) !== expected) {
        if (await hash(raw) !== item.gzip) throw new Error('压缩资源校验失败');
        raw = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
      }
      if (expected && await hash(raw) !== expected) throw new Error('资源版本校验失败');
      return raw;
    } finally { clearTimeout(idle); clearTimeout(deadline); }
  }
  async function race(name, expected, sources) {
    const key = name + ':' + expected;
    if (inflight.has(key)) return inflight.get(key);
    const promise = (async () => {
      const cached = expected && await cacheRead(name, expected);
      if (cached) return cached;
      const controllers = sources.map(() => new AbortController()); let complete = false;
      try {
        const raw = await Promise.any(sources.map(async (item, index) => {
          if (index) await new Promise(resolve => setTimeout(resolve, index * 400));
          if (complete) throw new Error('已有可用资源');
          return candidate(item, expected, name, controllers[index]);
        }));
        complete = true;
        controllers.forEach(c => c.abort());
        if (expected) await cacheWrite(name, expected, raw);
        return raw;
      } catch (_) { throw new Error('网页计算资源下载超时或校验失败，请点击“刷新数据”重试；本金和模拟记录已保留'); }
      finally { complete = true; controllers.forEach(c => c.abort()); }
    })();
    inflight.set(key, promise);
    try { return await promise; } finally { inflight.delete(key); }
  }
  function publicSources(name, expected) {
    const suffix = expected ? '?sha256=' + expected : '?v=' + Date.now();
    return [new URL(name + suffix, base).href,
      'https://raw.githubusercontent.com/WaXwingIN/WaXwing_IN.github.io/live-data/' + name + suffix,
      'https://cdn.jsdelivr.net/gh/WaXwingIN/WaXwing_IN.github.io@live-data/' + name + suffix].map(url => ({url}));
  }
  function runtime(name) {
    const info = files[name];
    if (!info) throw new Error('未知计算组件');
    let sources;
    if (info.gzip && typeof DecompressionStream !== 'undefined') {
      sources = publicSources('rolling-runtime/' + name + '.gz', info.gzip).map(item => ({...item, gzip: info.gzip}));
    } else {
      sources = [{url: new URL('rolling-runtime/' + name, base).href},
        {url: 'https://cdn.jsdelivr.net/pyodide/v0.27.7/full/' + name}];
    }
    return race('rolling-runtime/' + name, info.sha256, sources);
  }
  async function script(name) {
    const bytes = await runtime(name), url = URL.createObjectURL(new Blob([bytes], {type: 'text/javascript'}));
    try { importScripts(url); } finally { URL.revokeObjectURL(url); }
  }
  async function engine() {
    if (enginePromise) return enginePromise;
    enginePromise = (async () => {
      // Start packages during interpreter download, rather than after it.
      const names = Object.keys(files); let next = 0;
      const warm = Promise.all(Array.from({length: 4}, async () => {
        while (next < names.length) await runtime(names[next++]);
      }));
      warm.catch(() => {});
      await script('pyodide.js'); await script('pyodide.asm.js');
      report('正在启动网页计算，行情与依赖继续在后台读取…');
      const value = await loadPyodide({indexURL: new URL('rolling-runtime/', base).href});
      await value.loadPackage('pandas'); await warm;
      return value;
    })();
    try { return await enginePromise; } catch (error) { enginePromise = null; throw error; }
  }
  self.fetch = function (input, options) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, base);
    const prefix = new URL('rolling-runtime/', base).href;
    if (url.href.startsWith(prefix)) {
      const name = url.pathname.split('/').at(-1);
      if (files[name]) return runtime(name).then(raw => new Response(raw, {headers: {'Content-Type': mime(name)}}));
    }
    return originalFetch(input, options);
  };
  self.WaXwingRollingLoader = {engine, verified: (name, expected) => {
    if (!/^[0-9a-f]{64}$/.test(expected || '')) return Promise.reject(new Error('公开资源版本清单不完整，请重试'));
    return race(name, expected, publicSources(name, expected));
  },
    release: () => originalFetch(new URL('data/cloud_static_release.json', base), {cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(15000)}).then(async response => {
      if (!response.ok) throw new Error('公开行情版本读取失败，请重试');
      return response.json();
    }), progress: callback => { report = callback; }};
})();
