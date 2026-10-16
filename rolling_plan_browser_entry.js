(function () {
    'use strict';
    const host = location.hostname.toLowerCase();
    if (!['localhost', '127.0.0.1', '[::1]', 'waxwingin.github.io'].includes(host)) return;
    if (window.__waxwingLocalRollingPlanEntry) return;
    window.__waxwingLocalRollingPlanEntry = true;
    function mount() {
        const title = [...document.querySelectorAll('h1')].find(node => /市场观察|行情模型/.test(node.textContent));
        if (!title) return;
        let row = title.closest('.market-title-row');
        if (!row) {
            row = document.createElement('div');
            row.className = 'market-title-row';
            row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin:24px 0 18px';
            title.before(row);
            row.append(title);
        }
        let heading = title.closest('.market-title-heading');
        if (!heading) {
            heading = document.createElement('div');
            heading.className = 'market-title-heading';
            title.before(heading);
            heading.append(title);
            title.style.margin = '0';
        }
        if (!document.getElementById('localRollingPlanEntry')) {
            const link = document.createElement('a');
            link.id = 'localRollingPlanEntry';
            link.className = 'market-rolling-plan-link';
            link.href = host === 'waxwingin.github.io' ? 'rolling-plan.html' : 'http://localhost:8016/rolling-plan.html';
            link.textContent = '低波动滚动计划';
            link.title = '打开低波动滚动计划';
            heading.append(link);
        }
        if (!document.getElementById('localRollingPlanEntryStyle')) {
            const style = document.createElement('style');
            style.id = 'localRollingPlanEntryStyle';
            style.textContent = '.market-title-heading{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;min-width:0}.market-rolling-plan-link{display:inline;padding:0;border:0;border-radius:0;background:none;color:#1d4ed8;font:14px/1.5 system-ui,"Microsoft YaHei",sans-serif;text-decoration:underline;text-underline-offset:3px;white-space:nowrap}.market-rolling-plan-link:hover{color:#1e40af}.market-rolling-plan-link:focus-visible{outline:2px solid #2563eb;outline-offset:3px}@media(max-width:640px){.market-title-heading{gap:10px}}';
            document.head.append(style);
        }
    }
    function start() {
        mount();
        new MutationObserver(mount).observe(document.body, {childList:true, subtree:true});
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once:true});
    else start();
})();
