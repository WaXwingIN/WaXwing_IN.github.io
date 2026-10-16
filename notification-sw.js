/* System notifications only. Market data and pages are never cached here. */
self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('notificationclick',event=>{
    event.notification.close();
    const target=new URL(event.notification.data?.url||'./#d2-ideal',self.registration.scope);
    const scope=new URL(self.registration.scope);
    if(target.origin!==scope.origin||!target.pathname.startsWith(scope.pathname))return;
    event.waitUntil((async()=>{
        const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
        const existing=windows.find(client=>{
            const url=new URL(client.url);
            return url.origin===target.origin&&url.pathname===target.pathname;
        });
        if(existing){await existing.navigate(target.href);await existing.focus()}
        else await self.clients.openWindow(target.href);
    })());
});
