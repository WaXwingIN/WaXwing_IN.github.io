self.addEventListener('notificationclick',event=>{
    event.notification.close();
    const target=event.notification.data?.url||'./index.html#d2-alert';
    event.waitUntil((async()=>{
        const windows=await clients.matchAll({type:'window',includeUncontrolled:true});
        const current=windows.find(client=>new URL(client.url).origin===self.location.origin);
        if(current){await current.focus();current.postMessage({type:'open-d2-alert'});return}
        await clients.openWindow(target);
    })());
});
