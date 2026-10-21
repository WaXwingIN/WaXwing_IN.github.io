/* Shared ES5 controls for model, holding and history pages. */
(function () {
    if (window.__waxwingStockCodeCopy) return;
    window.__waxwingStockCodeCopy = true;
    function closest(node, selector) {
        while (node && node.nodeType === 1) {
            var matches = node.matches || node.msMatchesSelector || node.webkitMatchesSelector;
            if (matches && matches.call(node, selector)) return node;
            if (!matches) {
                var candidates = document.querySelectorAll(selector);
                for (var i = 0; i < candidates.length; i++) if (candidates[i] === node) return node;
            }
            node = node.parentElement;
        }
        return null;
    }
    function enhance(root) {
        var walker = document.createTreeWalker(root, 4, null, false), nodes = [], node, parent, i;
        while ((node = walker.nextNode())) {
            parent = node.parentElement;
            if (!parent || closest(parent, '[data-copy-stock-code],[data-no-stock-code-copy],script,style,svg,pre,textarea,input,select,option,#privateScanStatus,#privateModelStatus')) continue;
            if (/(^|[^\w.\/-])[012345689]\d{5}(?![\w.\/-])/.test(node.nodeValue)) nodes.push(node);
        }
        for (i = 0; i < nodes.length; i++) {
            node = nodes[i];
            var text = node.nodeValue, pattern = /(^|[^\w.\/-])([012345689]\d{5})(?![\w.\/-])/g;
            var fragment = document.createDocumentFragment(), cursor = 0, match;
            while ((match = pattern.exec(text))) {
                var start = match.index + match[1].length, code = match[2];
                fragment.appendChild(document.createTextNode(text.slice(cursor, start)));
                var nested = closest(node.parentElement, 'button,a,summary,label');
                var control = document.createElement(nested ? 'span' : 'button');
                if (nested) { control.setAttribute('role', 'button'); control.tabIndex = 0; }
                else control.type = 'button';
                control.className = 'stock-code-copy';
                control.setAttribute('data-copy-stock-code', code);
                control.setAttribute('aria-label', '复制股票代码 ' + code);
                control.title = '点击复制股票代码 ' + code;
                control.textContent = code;
                fragment.appendChild(control);
                cursor = start + code.length;
            }
            fragment.appendChild(document.createTextNode(text.slice(cursor)));
            node.parentNode.replaceChild(fragment, node);
        }
    }
    function copy(control) {
        var code = control.getAttribute('data-copy-stock-code');
        if (!/^\d{6}$/.test(code)) return;
        function feedback(ok) {
            var original = control.getAttribute('data-stock-copy-original-title') || control.title;
            control.setAttribute('data-stock-copy-original-title', original);
            var label = document.getElementById('stockCopyFeedback');
            if (!label) {
                label = document.createElement('div'); label.id = 'stockCopyFeedback';
                label.setAttribute('data-no-stock-code-copy', '');
                label.setAttribute('role', 'status'); label.setAttribute('aria-live', 'polite');
                label.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);padding:8px 16px;background:#203247;color:white;border-radius:6px;z-index:10000;pointer-events:none';
                document.body.appendChild(label);
            }
            label.hidden = false;
            control.title = ok ? '已复制 ' + code : '复制失败，请手动复制 ' + code;
            label.textContent = ok ? '已复制代码 ' + code : '复制失败，请手动复制 ' + code;
            control.className = control.className.replace(/\s*\bcopied\b/g, '') + (ok ? ' copied' : '');
            window.clearTimeout(label.__waxwingCopyTimer);
            label.__waxwingCopyTimer = window.setTimeout(function () { label.hidden = true; }, 1200);
            window.setTimeout(function () { control.title = original; control.className = control.className.replace(/\s*\bcopied\b/g, ''); }, 1200);
        }
        function fallback() {
            var field = document.createElement('textarea'), ok = false;
            field.value = code; field.setAttribute('readonly', '');
            field.style.cssText = 'position:fixed;left:-9999px;top:0';
            document.body.appendChild(field); field.select();
            try { ok = document.execCommand('copy'); } catch (e) {}
            document.body.removeChild(field); feedback(ok);
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
            try { navigator.clipboard.writeText(code).then(function () { feedback(true); }, fallback); } catch (e) { fallback(); }
        } else fallback();
    }
    function handle(event) {
        var control = closest(event.target, '[data-copy-stock-code]');
        if (!control || (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault(); event.stopImmediatePropagation(); copy(control);
    }
    document.addEventListener('click', handle, true);
    document.addEventListener('keydown', handle, true);
    var style = document.createElement('style');
    style.textContent = '.stock-code-copy{cursor:copy;color:inherit;font:inherit;background:transparent;border:0;padding:0}.stock-code-copy:hover,.stock-code-copy:focus{color:#1d4ed8;text-decoration:underline}.stock-code-copy.copied{color:#15803d}';
    document.head.appendChild(style);
    if (document.body) enhance(document.body);
    document.addEventListener('DOMContentLoaded', function () { enhance(document.body); });
    if (window.MutationObserver) {
        var pending = false;
        new MutationObserver(function () {
            // Chart/table rendering can add thousands of descendants in one
            // batch. Walk once per batch instead of once per inserted node.
            if (pending) return;
            pending = true;
            window.setTimeout(function () { pending = false; enhance(document.body); }, 0);
        }).observe(document.body, {childList:true, subtree:true, characterData:true});
    } else window.setInterval(function () { if (document.body) enhance(document.body); }, 1000);
}());
