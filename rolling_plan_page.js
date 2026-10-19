'use strict';
(function () {
  const costs = {slippage: .0005, commission: .0003, transfer: .00001};
  function sizePurchase(price, budget, code) {
    if (![price, budget].every(v => Number.isFinite(v) && v > 0)) return {qty: 0, cost: 0};
    const fill = price * (1 + costs.slippage);
    let qty = Math.floor(budget / (fill * 100)) * 100;
    for (; qty > 0; qty -= 100) {
      const amount = qty * fill, fee = Math.max(5, amount * costs.commission) + amount * costs.transfer;
      if (amount + fee <= budget) return qty < (/^68[89]/.test(code) ? 200 : 100) ? {qty: 0, cost: 0} : {qty, cost: amount + fee};
    }
    return {qty: 0, cost: 0};
  }
  function account(capital, trades) {
    let cash = capital;
    const positions = new Map();
    for (const t of trades) {
      if (!/^\d{6}$/.test(t.code) || !Number.isSafeInteger(t.qty) || t.qty <= 0 || !Number.isFinite(t.price) || t.price <= 0 || !Number.isFinite(t.fee) || t.fee < 0) throw new Error('成交记录无效');
      const position = positions.get(t.code);
      if (t.side === 'buy') {
        if (position) throw new Error('同一只股票已有持仓，请核对成交流水');
        cash -= t.qty * t.price + t.fee;
        positions.set(t.code, {code: t.code, name: t.name || t.code, qty: t.qty, entry_day: t.day,
          entry_price: t.price, model: t.model, signal_day: t.signal_day || t.day, signal_price: t.signal_price || t.price});
      } else if (t.side === 'sell') {
        if (!position || position.qty < t.qty) throw new Error('卖出股数超过实际持仓');
        if (t.day <= position.entry_day) throw new Error('当日买入须遵守T+1');
        cash += t.qty * t.price - t.fee;
        position.qty -= t.qty;
        if (!position.qty) positions.delete(t.code);
      } else throw new Error('买卖方向无效');
      if (cash < -.000001) throw new Error('成交后现金不足，请核对本金、价格和费用');
    }
    return {cash, positions: [...positions.values()]};
  }
  function buyPlan(plan, cap, book, prices={}) {
    if (!plan || plan.market.allow_buy !== true || !plan.complete) return [];
    if(plan.simulation?.opened_days?.includes(plan.trade_date))return [];
    let cash = book.cash;
    const held = new Set(book.positions.map(p => p.code));
    const marks = new Map(plan.positions.map(p => [p.code, p]));
    if (book.positions.some(p => !marks.get(p.code)?.sizing_price || marks.get(p.code)?.quote_fresh === false)) return [];
    const equity = cash + book.positions.reduce((sum, p) => sum + p.qty * marks.get(p.code).sizing_price, 0);
    const free = Math.max(0, cap - held.size), result = [];
    for (const row of plan.candidates.slice(0, cap).filter(p => !held.has(p.code)).slice(0, free)) {
      const price = prices[row.code] ?? row.reference_price;
      const limit = /^(300|301|688|689)/.test(row.code) ? .20 : /^[489]/.test(row.code) ? .30 : .10;
      const blocked = price >= row.reference_price * (1 + limit - .002);
      const size = blocked ? {qty:0,cost:0} : sizePurchase(price, Math.min(cash, equity / cap), row.code);
      result.push({...row, ...size, evaluation_price:price, blocked}); cash -= size.cost;
    }
    return result;
  }
  function afternoonRows(plan, prices={}) {
    const batch=plan?.afternoon;
    if(plan?.model!=='weekly_low_2_stress'||batch?.state!=='ready'||!plan.complete||plan.market.allow_buy!==true)return [];
    let cash=batch.available_cash;
    return batch.candidates.map(row=>{
      const price=prices[row.code]??row.evaluation_price;
      const limit=/^(688|689)/.test(row.code) ? .20 : .10;
      const blocked=price>=row.reference_price*(1+limit-.002);
      const size=blocked?{qty:0,cost:0}:sizePurchase(price,Math.min(cash,batch.budget),row.code);
      cash-=size.cost;
      return {...row,...size,evaluation_price:price,blocked};
    });
  }
  function afternoonReason(plan) {
    if(plan?.afternoon?.state==='missed' && plan.market?.allow_buy===false)
      return '最新补仓试算：13:00补仓0只；沿用前一交易日大盘判断，急跌暂停新买';
    return plan?.afternoon?.reason || '等待午盘行情核验';
  }
  function activePendingAlerts(events) {
    return (events||[]).map(event=>({...event,rows:(event.rows||[]).filter(row=>
      row.recorded||row.side!=='模拟买入'||['09:30','13:00'].includes(row.execution_at?.slice(11,16)))}))
      .filter(event=>event.rows.length);
  }
  function newestFirst(rows, field='day') {
    return [...(rows||[])].sort((a,b)=>String(b[field]||'').localeCompare(String(a[field]||'')));
  }
  function chinaTimestamp(value) {
    const text=String(value||'').trim().replace(' ','T');
    if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text))return NaN;
    return Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)?text:text+'+08:00');
  }
  function todayActions(plan, clock) {
    return newestFirst((plan?.simulation?.ledger||[]).filter(e=>e.at?.slice(0,10)===clock.day),'at');
  }
  function todayActionNotice(plan, clock) {
    const actions=todayActions(plan,clock);
    return actions.length?'今日模拟操作：'+actions.map(e=>`${e.at.slice(11,16)} ${e.side} ${e.code} ${e.name||''} ${e.qty}股${e.reason?' · '+e.reason:''}${e.observed_at?'（'+e.observed_at.slice(11,16)+'核验）':''}`).join('；'):'';
  }
  function reminderEvents(plan, cap, book, clock) {
    if (!plan?.live) return [];
    const events = [], knownGate = typeof plan.market.allow_buy === 'boolean';
    const buys = buyPlan(plan,cap,book).filter(r=>r.qty>0);
    const summary = buys.length ? buys.map(r=>`${r.code} ${r.name||''}（参考${r.qty}股）`).join('、') : '无可新增股票，继续等待';
    const ready = knownGate && (!plan.market.allow_buy || plan.complete);
    if (clock.day === plan.signal_date && clock.time >= '15:05' && ready) events.push({
      id: `close:${cap}:${plan.signal_date}`, title: '模拟方案：下一交易日计划已更新',
      body: `${cap}只方案 · ${plan.trade_date}：${plan.market.allow_buy ? summary : '大盘暂停新买，持币等待'}`});
    if (clock.day === plan.trade_date && clock.time >= '09:20' && clock.time < '09:30' && ready) events.push({
      id: `open:${cap}:${plan.trade_date}`, title: '模拟方案：开盘计划提醒',
      body: `${cap}只方案：${plan.market.allow_buy ? summary+'；09:30按实际价格评估' : '今日暂停新买，已有持仓继续跟踪卖出信号'}`});
    if(clock.day===plan.trade_date&&clock.time>='09:30'&&clock.time<'09:35'&&buys.length){
      events.push({id:`buy:${cap}:${clock.day}:09:30`,title:'买入时段已到 · 09:30',
        body:summary+'；请核对实际价格、预算与买入条件',requiresConfirmation:true,
        alertRows:buys.map(r=>({...r,side:'模拟买入',execution_at:clock.day+' 09:30',price:r.evaluation_price}))});
    }
    const batch=plan.afternoon;
    const stamp=String(plan.generated_at||'').slice(0,19).replace('T',' ');
    const age=(Date.parse(clock.day+'T'+clock.time+':00+08:00')-Date.parse(stamp.replace(' ','T')+'+08:00'))/1000;
    if(plan.model==='weekly_low_2_stress'&&cap===2&&clock.day===plan.trade_date&&
       clock.time>='11:30'&&clock.time<'13:05'&&batch?.day===clock.day&&batch.state==='ready'&&
       batch.known_at===clock.day+' 11:30:00'&&batch.prepared_at?.slice(0,19)<clock.day+'T13:00:00'&&
       age>=-60&&age<=90&&plan.complete&&plan.market.allow_buy===true){
      const rows=afternoonRows(plan).filter(r=>r.qty>0);
      if(rows.length)events.push({id:`afternoon:${cap}:${clock.day}:${clock.time<'13:00'?'ready':'due'}`,
        title:clock.time<'13:00'?'周线计划：13:00补仓名单已就绪':'周线计划：13:00补仓时段已到',requiresConfirmation:clock.time>='13:00',
        alertRows:rows.map(r=>({...r,side:'模拟买入',execution_at:clock.day+' 13:00',price:r.evaluation_price})),
        body:rows.map(r=>`${r.code} ${r.name||''}（参考${r.qty}股）`).join('、')+'；沿用收盘判断，13:00按实际价格评估，卖出未成交则不占用其资金和空位'});
    }
    const completed=todayActions(plan,clock).filter(e=>e.side==='模拟卖出');
    for (const row of plan.positions) {
      const sell = row.sell;
      const holding=book.positions.find(p=>p.code===row.code&&p.entry_day===row.entry_day&&
        (p.entry_price==null||p.entry_price===row.entry_price));
      if (!sell || !holding || !/^\d{4}-\d{2}-\d{2}$/.test(holding.entry_day||'') || !sell.execution_at || clock.day<=holding.entry_day ||
          sell.confirmed_at<holding.entry_day+' 09:30:00') continue;
      if(completed.some(e=>e.code===row.code&&e.confirmed_at===sell.confirmed_at))continue;
      const now=chinaTimestamp(clock.day+' '+clock.time+':00');
      const confirmed=chinaTimestamp(sell.confirmed_at),execution=chinaTimestamp(sell.execution_at);
      const due=Number.isFinite(execution)&&execution<=now;
      const fresh = row.quote_fresh !== false && row.last_bar>=sell.confirmed_at &&
        (row.last_bar?.slice(0,10)===clock.day ||
          (due&&clock.time>='09:30'&&clock.time<'09:35'&&sell.execution_at.slice(0,10)===clock.day));
      if (!fresh||!Number.isFinite(confirmed)||!Number.isFinite(execution)||confirmed>now)continue;
      events.push({id: `sell:${cap}:${row.code}:${sell.confirmed_at}:${due ? 'due' : 'confirmed'}`,
        title: due ? '模拟卖出时段已到' : '模拟持仓：严格卖出信号已确认',
        requiresConfirmation:due,alertRows:[{...row,side:'模拟卖出',execution_at:sell.execution_at,confirmed_at:sell.confirmed_at,reason:sell.reason}],
        body: `${row.code} ${row.name} · ${sell.reason}；最早${sell.execution_at}模拟卖出，仅用于方案跟踪，不代表实际成交`});
    }
    const now=chinaTimestamp(clock.day+' '+clock.time+':00');
    const fills=todayActions(plan,clock).filter(e=>['模拟买入','模拟卖出'].includes(e.side));
    for(const event of fills){
      if(event.historical_reference||event.mode==='paper_trial'||!event.observed_at)continue;
      const observed=chinaTimestamp(event.observed_at),executed=chinaTimestamp(event.at);
      const age=(now-observed)/1000;
      if(!Number.isFinite(age)||!Number.isFinite(executed)||age < -60||age>90||executed>now+60000)continue;
      if(plan.simulation?.created_at&&observed<chinaTimestamp(plan.simulation.created_at))continue;
      const delayed=observed-executed>90000;
      const selling=event.side==='模拟卖出';
      events.push({id:`${selling?'sell':'buy-fill'}:${cap}:${event.code}:${event.confirmed_at||event.at}:due`,
        title:event.side+'已记录'+(delayed?'（延迟核验）':''),requiresConfirmation:true,
        alertRows:[{...event,execution_at:event.at,recorded:true}],
        body:`${event.code} ${event.name||''} · ${event.qty}股${event.reason?' · '+event.reason:''}；模拟执行${event.at}，本次核验${event.observed_at.slice(0,19).replace('T',' ')}；仅为模拟记录`});
    }
    return events;
  }
  function historicalTradeTimes(result) {
    const positions = new Map([...result.closed,...result.opened].map(p=>[p.id,p]));
    return result.ledger.filter(e=>e.side==='买入').map(buy=>{
      const p=positions.get(buy.id),sell=result.ledger.find(e=>e.id===buy.id&&e.side==='卖出');
      return {code:buy.code,name:buy.name,model:buy.model,qty:buy.qty,
        buy_confirmed:p?.confirmed_at||null,buy_at:buy.at,
        sell_confirmed:sell?p?.confirmed||null:null,sell_at:sell?.at||null,
        pnl:p?.pnl,net_pct:p?.net_pct};
    });
  }
  function returnTone(value) { return Number.isFinite(value) ? (Math.abs(value)<.005?'flat':value>0?'up':'down') : ''; }
  function profitMarkup(amount, percent) {
    if(!Number.isFinite(amount)&&!Number.isFinite(percent))return '—';
    const signed=(value,currency=false)=>{
      if(!Number.isFinite(value))return '—';
      const n=Math.abs(value)<.005?0:value;
      return (n>0?'+':'')+(currency?new Intl.NumberFormat('zh-CN',{style:'currency',currency:'CNY'}).format(n):n.toFixed(2)+'%');
    };
    return `<span class="profit ${returnTone(Number.isFinite(amount)?amount:percent)}">${signed(amount,true)}${Number.isFinite(percent)?`<small>${signed(percent)}</small>`:''}</span>`;
  }
  function stockCode(code) {
    const value=String(code??'').padStart(6,'0');
    return /^\d{6}$/.test(value)?`<span class="stock-code-copy" role="button" tabindex="0" data-copy-stock-code="${value}" title="点击复制股票代码 ${value}" aria-label="复制股票代码 ${value}">${value}</span>`:'—';
  }
  function escapeText(value) {
    return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function dailyActionMarkup(event) {
    const kind=event.side==='模拟卖出'?'sell':event.side==='模拟买入'?'buy':'other';
    const shares=Number.isFinite(event.qty)?new Intl.NumberFormat('zh-CN').format(event.qty)+' 股':'';
    return `<div class="daily-action daily-action--${kind}"><span class="daily-action-badge">${escapeText(event.side)}</span><strong class="daily-action-stock">${stockCode(event.code)} ${escapeText(event.name)}</strong><div class="daily-action-size"><strong>${escapeText(shares)}</strong>${Number.isFinite(event.price)?`<span> × ${event.price.toFixed(3)} 元</span>`:''}</div>${event.reason?`<div class="daily-action-reason">${escapeText(event.reason)}</div>`:''}<div class="daily-action-meta"><span>模拟执行 ${escapeText(event.at?.slice(11,16)||'待核验')}</span>${event.observed_at?`<span>实际核验 ${escapeText(event.observed_at.slice(11,16))}</span>`:''}</div></div>`;
  }
  function marketDecision(plan) {
    const market=plan?.market;
    if(!market)return {summary:'大盘条件待核验',html:''};
    const weekly=plan.model==='weekly_low_2_stress',proxies=market.proxies||[];
    const names={'510300':'沪深300','510500':'中证500','159915':'创业板'};
    const complete=proxies.length===3&&proxies.every(p=>weekly?Number.isFinite(p.ret5):[p.close,p.ma20,p.slope5].every(Number.isFinite));
    const weak=complete?proxies.filter(p=>weekly?p.ret5<-.03:p.close<p.ma20&&p.slope5<0).length:null;
    const breadth=Number.isFinite(market.breadth)?(market.breadth*100).toFixed(2)+'%':'待核验';
    const rule=weekly?'三只宽基中，至少2只近5个交易日跌幅严格超过3%，暂停新买；未触发则通过大盘这一关。':
      '至少2只宽基同时满足“收盘价低于20日均线、20日均线较5个交易日前下降”，且主板站上20日均线比例≤40%，判为下跌并暂停新买。';
    let summary;
    if(plan.read_only)summary=plan.no_buy_reason||'公开行情尚未更新，暂停新增模拟成交';
    else if(market.allow_buy==null||!complete||(!weekly&&!Number.isFinite(market.breadth)))summary='大盘条件尚未核验完整：'+(market.reason||'缺少完整行情');
    else if(market.allow_buy===false)summary=weekly?`暂停新买：${weak}/3只宽基近5日跌幅超过3%（门槛≥2只）`:
      `暂停新买：${weak}/3只宽基满足下跌条件（门槛≥2只），主板站上20日均线比例${breadth}（门槛≤40%）`;
    else summary=weekly?`大盘未触发暂停：${weak}/3只宽基近5日跌幅超过3%（暂停门槛≥2只）`:
      `大盘未触发下跌暂停：宽基下跌${weak}/3只，主板站上20日均线比例${breadth}；两项暂停条件须同时满足`;
    const rows=proxies.map(p=>{
      const known=weekly?Number.isFinite(p.ret5):[p.close,p.ma20,p.slope5].every(Number.isFinite);
      const met=known&&(weekly?p.ret5<-.03:p.close<p.ma20&&p.slope5<0);
      const value=weekly?`近5日涨跌 ${Number.isFinite(p.ret5)?(p.ret5*100).toFixed(3)+'%':'待核验'}`:
        `收盘 ${Number.isFinite(p.close)?p.close.toFixed(3):'待核验'} / 20日均线 ${Number.isFinite(p.ma20)?p.ma20.toFixed(5):'待核验'} / 均线5日变化 ${Number.isFinite(p.slope5)?(p.slope5*100).toFixed(3)+'%':'待核验'}`;
      return `<li>${escapeText(names[p.code]||p.code)}：${value} · ${known?met?'满足暂停子条件':'未满足暂停子条件':'待核验'}</li>`;
    }).join('');
    const basis=`依据 ${plan.signal_date||'待核验'} 收盘数据，判断 ${plan.trade_date||'待核验'} 的计划`;
    const html=`<p><strong>大盘判断依据</strong> · ${escapeText(basis)}</p><p><strong>暂停条件：</strong>${rule}</p><p><strong>本次结论：</strong>${escapeText(summary)}。</p>${rows?`<ul>${rows}</ul>`:''}<p>${weekly?'近5日涨跌=信号日收盘÷5个交易日前收盘−1。':'主板宽度按已核验的主板样本统计'+(Number.isInteger(market.members)?`（${market.members}只）`:'')+'；均线5日变化=信号日MA20÷5个交易日前MA20−1。'}大盘暂停只限制新买，已有持仓继续按原严格卖出条件管理。</p>`;
    return {summary,html};
  }
  const api = {sizePurchase, account, buyPlan, afternoonRows, afternoonReason, activePendingAlerts, newestFirst, todayActions, todayActionNotice, reminderEvents, historicalTradeTimes, profitMarkup, stockCode, returnTone, marketDecision};
  if (typeof module !== 'undefined') module.exports = api;
  if (typeof document === 'undefined') return;

  const $ = id => document.getElementById(id), escape = escapeText;
  const money = n => new Intl.NumberFormat('zh-CN', {style:'currency', currency:'CNY'}).format(n);
  const pct = n => n == null ? '—' : (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
  const cls = returnTone;
  const key = 'waxwing_position_plan_v2';
  const defaultModel='low_volatility', weeklyModel='weekly_low_2_stress';
  const defaultRule=$('modelRule').textContent, defaultHistoryRule=$('historyRule').textContent, defaultPriceNote=$('buyPriceNote').textContent;
  const modelPrefix=()=>state.model===defaultModel?'':state.model+':';
  const bookKey=()=>`${modelPrefix()}${state.capital}:${state.cap}:${state.startDate}`;
  const executionPolicy='weekly-open-and-1300-20261019-v3';
  const priceKey=()=>`${modelPrefix()}${state.startDate}:${state.cap}:${plan?.trade_date}${state.model===weeklyModel&&plan?.trade_date===chinaClock().day&&chinaClock().time>='11:30'?':13:00':''}`;
  let state = {capital:50000, cap:2, model:defaultModel, desktop:false, seen:[],alertSeen:[],pendingAlerts:[],startMode:'latest',startDate:null};
  try { const value = JSON.parse(localStorage.getItem(key)||localStorage.getItem('waxwing_position_plan_v1')); if (value && Number.isFinite(value.capital) && value.capital >= 100) state = {capital:value.capital,cap:value.cap,model:value.model===weeklyModel?weeklyModel:defaultModel,desktop:Boolean(value.desktop),seen:Array.isArray(value.seen)?value.seen:[],alertSeen:Array.isArray(value.alertSeen)?value.alertSeen:[],pendingAlerts:Array.isArray(value.pendingAlerts)?value.pendingAlerts:[],startMode:value.startMode==='manual'?'manual':'latest',startDate:value.startDate||null}; } catch (_) {}
  const entryPolicy='active-models-20261016-v1';
  try {
    if(localStorage.getItem('waxwing_rolling_entry_policy')!==entryPolicy){
      for(let i=localStorage.length-1;i>=0;i--){const name=localStorage.key(i);if(name?.startsWith('waxwing_plan_view_v1:'))localStorage.removeItem(name);}
      state.pendingAlerts=[];localStorage.setItem('waxwing_rolling_entry_policy',entryPolicy);
    }
  }catch(_){}
  try {
    if(localStorage.getItem('waxwing_rolling_execution_policy')!==executionPolicy){
      for(let i=localStorage.length-1;i>=0;i--){const name=localStorage.key(i);if(name?.startsWith('waxwing_plan_view_v1:'+weeklyModel+':'))localStorage.removeItem(name);}
      localStorage.setItem('waxwing_rolling_execution_policy',executionPolicy);
    }
  }catch(_){}
  state.pendingAlerts=activePendingAlerts(state.pendingAlerts);
  if(state.model===weeklyModel)state.cap=2;
  let historyData, plan, busy = false, lastRequest = 0, tab = 'plan', priceInputs={}, paperBooks={};
  function currentPrices(){return priceInputs[priceKey()]||{};}
  function save() { try { localStorage.setItem(key, JSON.stringify(state)); } catch (_) { $('status').textContent = '浏览器未允许保存设置；模拟记录仍保存在本机服务中。'; } }
  function chinaClock() { const parts = new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date()).split(' '); return {day:parts[0],time:parts[1]}; }
  function book() { return paperBooks[bookKey()]||{cash:state.capital,positions:[],ledger:[],unloaded:true}; }
  function readOnlyView(value,reason) {
    return {...value,live:false,read_only:true,complete:false,candidates:[],afternoon:null,no_buy_reason:reason,
      market:{...value.market,allow_buy:false,reason}};
  }
  function restoreSavedView(reason='正在更新行情，显示上次已核验的模拟记录；暂停新增买入。') {
    try {
      const value=JSON.parse(localStorage.getItem('waxwing_plan_view_v1:'+bookKey())||'null');
      if(!value?.simulation||value.simulation.capital!==state.capital||value.simulation.cap!==state.cap||value.simulation.start_date!==state.startDate)return false;
      plan=readOnlyView(value,reason);paperBooks[bookKey()]=plan.simulation;return true;
    }catch(_){return false;}
  }
  function rememberView() {
    if(!plan?.simulation)return;
    try{localStorage.setItem('waxwing_plan_view_v1:'+bookKey(),JSON.stringify(plan));}catch(_){}
  }
  function metric(label, value, tone='') { return `<div class="metric"><span>${escape(label)}</span><strong class="${tone}">${escape(value)}</strong></div>`; }
  function empty(columns, text) { return `<tr><td colspan="${columns}" class="empty">${escape(text)}</td></tr>`; }
  let loadingDepth=0;
  function loadingProgress(text){if(loadingDepth)$('globalLoadingMessage').textContent=text;}
  function beginLoading(text){
    loadingDepth++;$('globalLoading').hidden=false;$('planPageContent').inert=true;
    $('planPageContent').setAttribute?.('aria-busy','true');loadingProgress(text);
  }
  function endLoading(){
    loadingDepth=Math.max(0,loadingDepth-1);
    if(!loadingDepth){$('globalLoading').hidden=true;$('planPageContent').inert=false;$('planPageContent').setAttribute?.('aria-busy','false');}
  }
  async function withLoading(operation,text){beginLoading(text);try{return await operation();}finally{endLoading();}}
  async function foregroundRefresh(){while(busy)await new Promise(resolve=>setTimeout(resolve,100));await refresh();}
  if(typeof window!=='undefined')window.WaXwingRollingProgress=loadingProgress;
  function showNotice(text, error=false) { $('notice').textContent = text; $('notice').classList.toggle('error', error);loadingProgress(text); }
  async function request(url, options={}) { if(globalThis.WaXwingRollingStatic)return globalThis.WaXwingRollingStatic.request(url,options);const response = await fetch(url, {...options, cache:'no-store'}), value = await response.json(); if (!response.ok || value.error) throw new Error(value.error || '读取失败'); return value; }

  function tradeAlertKey(row) {
    return `${bookKey()}:${row.side}:${row.code}:${row.execution_at?.slice(0,16)}`;
  }
  function showTradeAlerts() {
    const dialog=$('tradeAlertDialog');
    if(!state.pendingAlerts.length||!dialog?.showModal)return;
    const pending=state.pendingAlerts;
    const pushEnabled=state.desktop&&typeof Notification!=='undefined'&&Notification.permission==='granted';
    $('enableTradePush').hidden=pushEnabled;
    $('tradeAlertPushHint').textContent=pushEnabled?'浏览器推送已开启。':'页面弹窗已启用；允许浏览器通知后，可同时收到系统推送。';
    $('tradeAlertTitle').textContent=pending.some(e=>e.rows.some(r=>r.side==='模拟卖出'))?'买卖操作提醒':'买入时段提醒';
    $('tradeAlertItems').innerHTML=pending.map(event=>`<div class="trade-alert-group"><p class="trade-alert-context">${escape(event.context)}</p>${event.rows.map(row=>`<article class="trade-alert-item ${row.side==='模拟卖出'?'trade-alert-item--sell':''}"><span class="daily-action-badge">${escape(event.title)}</span><h3 class="trade-alert-stock">${stockCode(row.code)} ${escape(row.name)}</h3><p class="trade-alert-quantity">${escape(Number.isFinite(row.qty)?new Intl.NumberFormat('zh-CN').format(row.qty)+' 股':'按持仓核对股数')}${Number.isFinite(row.price)?`<small>${row.recorded?'模拟记录价':'参考价'} ${row.price.toFixed(3)} 元</small>`:''}</p>${row.reason?`<p>${escape(row.reason)}</p>`:''}<dl><dt>${row.recorded?'模拟记录时间':'最早模拟执行'}</dt><dd>${escape(row.execution_at||'待核验')}</dd>${row.confirmed_at?`<dt>信号确认</dt><dd>${escape(row.confirmed_at)}</dd>`:''}${row.observed_at?`<dt>实际核验</dt><dd>${escape(row.observed_at.slice(0,19).replace('T',' '))}</dd>`:''}</dl></article>`).join('')}</div>`).join('');
    if(!dialog.open)dialog.showModal();
  }
  function queueTradeAlerts(events) {
    const known=new Set([...state.alertSeen,...state.pendingAlerts.flatMap(e=>e.keys)]);
    for(const event of events.filter(e=>e.requiresConfirmation)){
      const rows=(event.alertRows||[]).filter(row=>!known.has(tradeAlertKey(row)));
      if(!rows.length)continue;
      const keys=rows.map(tradeAlertKey);keys.forEach(value=>known.add(value));
      state.pendingAlerts.push({title:event.title,rows,keys,context:`${state.model===weeklyModel?'周线低波动':'低波动滚动'} · ${state.cap}只方案 · 本金${money(state.capital)} · 起点${state.startDate}`});
    }
    save();showTradeAlerts();
  }
  let notificationWorker,desktopSending=new Set();
  async function sendBrowserNotification(event) {
    const options={body:event.body,tag:event.id,requireInteraction:true,data:{url:globalThis.location?.href||'rolling-plan.html'}};
    if(typeof navigator!=='undefined'&&navigator.serviceWorker){
      try{
        notificationWorker ||= navigator.serviceWorker.register('notification-sw.js',{scope:'./'});
        const registration=await notificationWorker;
        if(!registration.active){
          await new Promise((resolve,reject)=>{
            const worker=registration.installing||registration.waiting;
            if(!worker)return reject(new Error('通知服务尚未就绪'));
            const timer=setTimeout(()=>{worker.removeEventListener('statechange',changed);reject(new Error('通知服务启动超时'));},4000);
            function changed(){if(worker.state==='activated'){clearTimeout(timer);worker.removeEventListener('statechange',changed);resolve();}}
            worker.addEventListener('statechange',changed);changed();
          });
        }
        await registration.showNotification(event.title,options);return;
      }catch(_){notificationWorker=null;}
    }
    const notice=new Notification(event.title,options);
    notice.onclick=()=>{window.focus();notice.close();showTradeAlerts();};
  }
  async function pushDesktopEvents(events) {
    for(const event of events){
      if(!state.desktop||typeof Notification==='undefined'||Notification.permission!=='granted')return;
      const keys=event.noticeKeys?.length?event.noticeKeys:[event.id];
      if(state.seen.includes(event.id)||keys.every(value=>state.seen.includes(value))||keys.some(value=>desktopSending.has(value)))continue;
      keys.forEach(value=>desktopSending.add(value));
      try{await sendBrowserNotification(event);state.seen.push(...keys);state.seen=state.seen.slice(-1000);save();}
      catch(_){$('notifyStatus').textContent='浏览器推送未能显示，下次检查会重试；页面确认弹窗仍然保留。';}
      finally{keys.forEach(value=>desktopSending.delete(value));}
    }
  }

  function draw() {
    const weekly=state.model===weeklyModel;
    $('rollingModel').value=state.model;
    $('rollingModel').title=$('rollingModel').selectedOptions?.[0]?.textContent||'';
    $('modelReturn').hidden=!weekly;
    const modelReturn=historyData?.results?.[state.cap]?.net_pct;
    $('modelReturnValue').textContent=pct(modelReturn);
    $('modelReturnValue').className=cls(modelReturn);
    $('modelReturn').title=weekly&&historyData?`${historyData.from}—${historyData.through} · ${historyData.results[state.cap].curve.length}个交易日 · 本金${money(state.capital)} · 累计净收益`:'';
    $('schemeRow').hidden=weekly||!historyData;
    $('modelRule').textContent=weekly?'选股：仅周线模型的当日已确认买入提醒，排除创业板（300、301），ATR14/收盘价≤6%，波动从低到高。最多2只，每笔预算为前收盘资产的1/2；至少两只宽基近5个交易日跌幅超过3%时暂停新买。沿用前一日收盘判断，09:30开盘及13:00补仓均考察原前两名，不作午间大盘重新判断；严格卖出信号保留至下一个可执行时点，不设信号超时，仍须遵守T+1及行情核验。':defaultRule;
    $('historyTitle').textContent=weekly?'历史推算 · 周线低波动两只':'历史推算 · 收益前二与三只方案';
    $('historyRule').textContent=weekly?'排除创业板，最多2只，按前一日收盘判断，09:30开盘买入并增加13:00补仓，严格卖出在下一个可执行时点处理。未卖持仓浮盈亏、费用及滑点均已计入；已有模拟流水保留，过去日期不补发提醒。':defaultHistoryRule;
    $('afternoonSchedule').hidden=!weekly;
    $('accountNote').textContent = `起点 ${state.startDate||'待读取'} · ${state.model===weeklyModel?'周线低波动 · ':''}当前${state.cap}只方案 · 模拟本金${money(state.capital)}`;
    $('schemes').innerHTML = historyData&&!weekly ? historyData.selected_caps.map(cap => `<button data-cap="${cap}" class="${state.cap===cap?'active':''}" aria-pressed="${state.cap===cap}"><span class="scheme-choice"><span class="scheme-title">最多${cap}只</span><small>${historyData.top_two.includes(cap)?'历史前二':'保留方案'}</small></span><span class="scheme-performance"><span class="return-chip ${cls(historyData.results[cap].net_pct)}">${pct(historyData.results[cap].net_pct)}</span><small>历史累计</small></span></button>`).join('') : '';
    $('accountNote').textContent = `起点 ${state.startDate||'待读取'} · ${state.model===weeklyModel?'周线低波动 · ':''}当前${state.cap}只方案 · 模拟本金${money(state.capital)}`;
    const b = book(), valuation=plan?.valuation, summary=valuation?.summary;
    const valued=(valuation?.days||[]).filter(row=>row.complete).at(-1);
    const equity=summary?.equity??valued?.equity??null;
    const valuedDay=summary?.equity!=null?summary.day:valued?.day;
    const marks = new Map((plan?.positions || []).map(p => [p.code,p]));
    const priced = !b.unloaded && b.positions.every(p => marks.get(p.code)?.reference_price);
    $('accountMetrics').innerHTML = metric('模拟可用现金',b.unloaded?'待同步':money(b.cash))+
      metric('模拟持有 / 上限',b.unloaded?'待同步':`${b.positions.length} / ${state.cap}只`)+
      metric('参考资产'+(valuedDay?' · '+valuedDay:''),equity==null?'待行情核验':money(equity))+
      `<div class="metric"><span>当日收益 · ${summary?.day||chinaClock().day}</span><strong>${profitMarkup(summary?.daily_pnl,summary?.daily_pct)}</strong></div>`+
      `<div class="metric"><span>累计收益${valued?' · '+valued.day:''}</span><strong>${profitMarkup(valued?.total_pnl,valued?.total_pct)}</strong></div>`;
    const clock=chinaClock(), afternoon=weekly&&plan?.trade_date===clock.day&&clock.time>='11:30';
    const rows = afternoon ? afternoonRows(plan,currentPrices()) : buyPlan(plan,state.cap,b,currentPrices());
    $('buyPriceNote').textContent=afternoon?'评估价默认取11:30收盘价，可输入13:00实际价格重算股数。接近涨停、买入前已确认卖出或行情不可核验时跳过；卖出未成交则不使用其资金和空位。参考股数不代表成交。':defaultPriceNote;
    $('planTitle').textContent = plan ? `${state.startDate} 起 · ${afternoon?'13:00补仓计划':'买入计划'}` : '买入计划';
    $('marketBadge').textContent = plan ? `当前大盘：${plan.market.state}` : '';
    const decision=marketDecision(plan);
    $('marketDecision').hidden=!plan;$('marketDecision').innerHTML=decision.html;
    $('planReason').textContent = !plan ? '数据尚未核验，暂停新增模拟买入。' : afternoon ? afternoonReason(plan) : plan.no_buy_reason || (plan.simulation?.opened_days?.includes(plan.trade_date)?weekly?'本日开盘模拟已完成，午休核验13:00补仓机会':'本日开盘模拟已完成，盘中空位等待下一交易日':!priced?'模拟持仓行情未核验，暂停新买预算计算':!rows.length?'没有可新增的空位或当日新提醒':'开盘按下列顺序评估模拟新买');
    $('buyBasis').textContent = plan ? `当前计划交易日 ${plan.trade_date} · 信号日 ${plan.signal_date} · 最多考察排序前${state.cap}名 · 每笔预算为前收盘参考资产的1/${state.cap}` : '';
    $('holdingTitle').textContent = b.unloaded?'当前模拟持仓 · 待读取':`当前模拟持仓 · ${b.positions.length}只`;
    $('simulationBasis').textContent = `从 ${state.startDate||'所选交易日'} 起，以${money(state.capital)}按${weekly?'周线低波动两只':'低波动滚动'+state.cap+'只'}方案持续模拟。下表仅列出模拟账本中尚未卖出的股票，不代表实际账户持仓。`;
    const holdingValues=b.positions.map(p=>valuation?.positions?.[p.code]);
    const cutoffs=[...new Set(holdingValues.map(v=>v?.asof).filter(Boolean))].sort();
    const missingMarks=holdingValues.filter(v=>!v?.asof).length;
    const oldMarks=holdingValues.some(v=>v?.day&&v.day<clock.day);
    const cutoffText=cutoffs.length>1?`${cutoffs[0]} 至 ${cutoffs.at(-1)}（各股不同，详见表格）`:cutoffs[0];
    $('holdingAsOf').textContent=b.unloaded?'模拟账本待读取，暂不能确认持仓':!b.positions.length?'模拟账本当前为空仓':`估值行情：${cutoffText?cutoffText+'（北京时间）':'待核验'}${missingMarks?' · '+missingMarks+'只行情待核验':''}${oldMarks?' · 今日行情待更新':''}${plan?.read_only?' · 当前显示上次保存的模拟记录':''}`;
    const firstBuys=(b.ledger||[]).filter(e=>e.side==='模拟买入'&&e.at.slice(0,10)===state.startDate);
    $('startPurchases').hidden=state.startDate===chinaClock().day||b.unloaded;
    $('startPurchasesTitle').textContent=`起点当日模拟买入 · ${state.startDate}`;
    $('startPurchaseRows').innerHTML=firstBuys.map(e=>`<tr><td>${escape(e.at)}</td><td>${stockCode(e.code)} ${escape(e.name)}<small>${escape(e.model)}</small></td><td>${e.qty}</td><td>${e.price.toFixed(3)}</td><td>${money(-e.cash_change)}</td></tr>`).join('')||empty(5,'起点当日未模拟买入，从现金开始继续按规则等待');
    $('buyRows').innerHTML = rows.length ? rows.map(r => `<tr><td>${stockCode(r.code)} ${escape(r.name)}<small>${escape(r.model)}</small></td><td>${escape(r.signal_day)}</td><td>${(r.atr_fraction*100).toFixed(2)}%</td><td><input style="width:110px" type="number" min="0.001" step="any" value="${r.evaluation_price}" data-price="${escape(r.code)}" aria-label="${escape(r.name)}评估买入价"><small>信号收盘 ${r.reference_price.toFixed(3)}</small></td><td>${r.qty ? r.qty+'股':r.blocked?'接近涨停，跳过':'预算不足最小买入量'}</td><td>${money(r.cost)}</td></tr>`).join('') : empty(6,plan?.market?.allow_buy===false?decision.summary:plan?.no_buy_reason || '暂无可执行买入名单');
    $('holdingRows').innerHTML = b.positions.length ? b.positions.map(p => {
      const q=marks.get(p.code),v=valuation?.positions?.[p.code],sell=q?.sell;
      return `<tr><td>${stockCode(p.code)} ${escape(p.name)}</td><td>${escape(p.entry_day)}<small>信号 ${escape(p.signal_day)} · ${escape(p.model)}</small></td><td>${p.qty}股<small>含费成本 ${v?money(v.cost_price):'待核验'}</small></td><td>${v?v.price.toFixed(3):'—'}</td><td>${profitMarkup(v?.daily_pnl,v?.daily_pct)}${v?`<small>${escape(v.day)}${v.day!==chinaClock().day?' · 今日待更新':''}</small>`:''}</td><td>${profitMarkup(v?.holding_pnl,v?.holding_pct)}</td><td>${escape(v?.asof||q?.last_bar||'待核验')}</td><td>${sell?`${escape(sell.reason)}<small>确认 ${escape(sell.confirmed_at)}<br>最早模拟执行 ${escape(sell.execution_at)}</small>`:escape(q?.status||'严格卖出待30分钟行情核验')}</td></tr>`;
    }).join('') : empty(8,b.unloaded?'模拟持仓待同步':'当前模拟空仓，按当日方案持币等待');
    $('dailyBasis').textContent=valuation?.days?.length?`${valuation.from}—${valuation.through} · ${valuation.days.length}个交易日，包含继续持有和空仓日。${valuation.basis}`:valuation?.error||'逐日模拟记录待读取；没有买卖的交易日也会显示。';
    $('dailyRows').innerHTML=newestFirst(valuation?.days).map(row=>`<tr${row.day===clock.day?' class="daily-row--today"':''}><td>${escape(row.day)}${row.day===clock.day?'<small class="daily-today-label">今日</small>':''}</td><td>${row.actions.length?newestFirst(row.actions,'at').map(dailyActionMarkup).join(''):row.state==='持有'?'继续持有':'空仓等待'}</td><td>${row.positions.length?row.positions.map(p=>`<div class="daily-position">${stockCode(p.code)} ${escape(p.name)} · ${p.qty}股${p.valuation?`<small>核验价 ${p.valuation.price.toFixed(3)} · ${profitMarkup(p.valuation.daily_pnl,p.valuation.daily_pct)}</small>`:'<small>当日行情待核验</small>'}</div>`).join(''):'空仓 · 持币'}</td><td>${row.equity==null?'当日行情待核验':money(row.equity)}<small>现金 ${money(row.cash)}</small></td><td>${profitMarkup(row.daily_pnl,row.daily_pct)}</td><td>${profitMarkup(row.total_pnl,row.total_pct)}</td></tr>`).join('')||empty(6,'逐日模拟记录待读取');
    $('simulationRows').innerHTML = newestFirst(valuation?.trades||b.ledger,'at').map(t=>`<tr><td>${escape(t.at)}</td><td>${escape(t.side)}</td><td>${stockCode(t.code)} ${escape(t.name)}</td><td>${t.qty} × ${t.price}</td><td>${money(t.fee)}</td><td>${profitMarkup(t.pnl,t.net_pct)}</td><td>${escape(t.confirmed_at||t.signal_day)}</td></tr>`).join('')||empty(7,'尚无模拟买卖记录；持有与空仓日见上方逐日记录');
    $('metadata').textContent = plan ? `行情信号日 ${plan.signal_date} · 计划交易日 ${plan.trade_date} · 数据读取 ${plan.generated_at.slice(0,19).replace('T',' ')}（北京时间）` : '当前数据不可用，本机模拟记录保留';
    $('notify').textContent = state.desktop ? '关闭桌面提醒' : '开启桌面提醒';
    $('notifyStatus').textContent = `${state.desktop?'浏览器推送已开启':'浏览器推送未开启'}。买卖到时弹出大窗口，须点击确认关闭；页面须保持打开，浏览器休眠、系统免打扰或断网可能延迟通知。`;
    $('status').textContent = plan ? `来源：${plan.source}。${plan.complete?'收盘模型已齐。':'部分收盘模型未完成，买入名单暂不可执行。'}每30秒检查，当前数据最多缓存60秒。未安装定时任务、未连接券商。` : '数据读取失败后暂停新买；页面每30秒重试。';
    drawHistory();
  }
  function drawHistory() {
    if(!historyData){
      $('historyBasis').textContent=`本金${money(state.capital)} · 历史推算待读取`;
      for(const id of ['historyMetrics','chart','historyDetail'])$(id).innerHTML='';
      $('historyRows').innerHTML=empty(5,'历史推算待读取');
      $('historyTradeTimes').innerHTML=empty(7,'历史推算待读取');return;
    }
    const r=historyData.results[state.cap];
    if(!r)return;
    $('historyBasis').textContent=`${historyData.from}—${historyData.through} · ${r.curve.length}个交易日 · 本金${money(state.capital)} · 只投入一次，逐日滚动。当前本金已重新计算整手及费用。`;
    $('historyMetrics').innerHTML=metric('累计净收益',pct(r.net_pct),cls(r.net_pct))+metric('最大收盘回撤',pct(-Math.abs(r.dd_pct)),cls(-Math.abs(r.dd_pct)))+metric('已卖笔数 / 胜率',`${r.closed_n}笔 / ${pct(r.closed_win_pct)}`);
    const prior=$('historyDay').value;
    $('historyDay').innerHTML=newestFirst(r.curve).map(d=>`<option value="${d.day}">${d.day}</option>`).join('');
    $('historyDay').value=r.curve.some(d=>d.day===prior)?prior:r.curve.at(-1).day;
    $('historyRows').innerHTML=newestFirst(r.curve).map(d=>`<tr><td>${d.day}</td><td>${money(d.equity)}</td><td>${money(d.cash)}</td><td class="${cls(d.net_pct)}">${pct(d.net_pct)}</td><td>${escape(d.holdings)}</td></tr>`).join('');
    $('historyTradeTimes').innerHTML=newestFirst(historicalTradeTimes(r),'buy_at').map(t=>`<tr><td>${stockCode(t.code)} ${escape(t.name)}<small>${escape(t.model)}</small></td><td>${escape(t.buy_confirmed||'未保存确认时刻')}</td><td>${escape(t.buy_at)}</td><td>${escape(t.sell_confirmed||'截至'+historyData.through+'未触发')}</td><td>${escape(t.sell_at||'仍持有')}</td><td>${t.qty}</td><td>${profitMarkup(t.pnl,t.net_pct)}<small>${t.sell_at?'已卖出':'截至'+historyData.through+'持有浮盈亏'}</small></td></tr>`).join('')||empty(7,'该本金下没有历史买入');
    const curves=historyData.selected_caps.map(c=>historyData.results[c].curve),values=curves.flatMap(c=>c.map(d=>d.net_pct)),colors=['#2563eb','#17645e','#6976a5'];
    const lo=Math.min(0,...values)-.3, hi=Math.max(0,...values)+.3, x=i=>50+i*800/Math.max(1,curves[0].length-1), y=v=>205-(v-lo)/(hi-lo)*165;
    $('chart').innerHTML=`<svg viewBox="0 0 900 250" role="img" aria-label="历史收益曲线"><line x1="50" y1="${y(0)}" x2="850" y2="${y(0)}" stroke="#ccd8e4"/><text x="2" y="${y(0)+4}" fill="#64758a" font-size="12">0%</text>${curves.map((c,i)=>`<polyline points="${c.map((d,j)=>x(j)+','+y(d.net_pct)).join(' ')}" fill="none" stroke="${colors[i]}" stroke-width="2.5"/><text x="${50+i*240}" y="22" fill="${c[c.length-1].net_pct>0?'#c62828':c[c.length-1].net_pct<0?'#16803e':'#64758a'}" font-size="13">${historyData.selected_caps[i]}只方案 · ${pct(c[c.length-1].net_pct)}</text>`).join('')}<text x="50" y="235" fill="#64758a" font-size="12">${historyData.from}</text><text x="770" y="235" fill="#64758a" font-size="12">${historyData.through}</text></svg>`;
    drawHistoryDay();
  }
  function drawHistoryDay() {
    if(!historyData)return;
    const r=historyData.results[state.cap],day=$('historyDay').value,d=r.curve.find(x=>x.day===day),events=r.ledger.filter(e=>e.at.slice(0,10)===day);
    $('historyDetail').innerHTML=`<p>${escape(d.holdings)} · 期末资产${money(d.equity)} · 累计<span class="${cls(d.net_pct)}">${pct(d.net_pct)}</span></p><div class="scroll"><table><thead><tr><th>时间</th><th>买卖</th><th>股票 / 来源模型</th><th>股数</th><th>基准价</th><th>现金变动</th></tr></thead><tbody>${newestFirst(events,'at').map(e=>`<tr><td>${escape(e.at)}</td><td>${escape(e.side)}</td><td>${stockCode(e.code)} ${escape(e.name)}<small>${escape(e.model)}</small></td><td>${e.qty}</td><td>${e.price.toFixed(3)}</td><td>${money(e.cash_change)}</td></tr>`).join('')||empty(6,'该日没有买卖，继续持有或持币')}</tbody></table></div>`;
  }
  async function loadHistory() {
    $('applyPlan').disabled=true;
    const capital=state.capital,model=state.model;
    try {
      const value=await request('/api/history?capital='+encodeURIComponent(capital)+(model===defaultModel?'':'&model='+encodeURIComponent(model)+'&execution_policy='+encodeURIComponent(executionPolicy)));
      if(capital!==state.capital||model!==state.model)return;
      if(model===weeklyModel&&value.execution_policy!==executionPolicy)throw new Error('周线规则版本未更新，请更新网页计算资源后重试；模拟记录保留');
      historyData=value;
      const oldCap=state.cap;
      if(!historyData.selected_caps.includes(state.cap))state.cap=historyData.selected_caps[0];
      if(oldCap!==state.cap){lastRequest++;plan=null;}
      save();draw();
      if(oldCap!==state.cap)await refresh();
    }
    finally{$('applyPlan').disabled=false;}
  }
  async function loadStartOptions(){
    const value=await request('/api/options');
    if(state.startMode==='latest'||!value.dates.includes(state.startDate)){state.startMode='latest';state.startDate=value.default_start;}
    const html=`<option value="latest">${value.default_start} · 最近</option>`+value.dates.slice().reverse().map(d=>`<option value="${d}">${d}</option>`).join('');
    if($('startDate').innerHTML!==html)$('startDate').innerHTML=html;
    $('startDate').value=state.startMode==='latest'?'latest':state.startDate;
    $('startDate').disabled=false;save();
  }
  async function refresh() {
    if(busy)return;busy=true;const id=++lastRequest,cap=state.cap,capital=state.capital,model=state.model;
    let startDate=state.startDate;
    $('refresh').disabled=true;
    try {
      await loadStartOptions();startDate=state.startDate;if(id!==lastRequest)return;
      const value=await request('/api/plan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({capital,cap,model,start_date:startDate,...(model===weeklyModel?{execution_policy:executionPolicy}:{})})});
      if(id!==lastRequest||cap!==state.cap||capital!==state.capital||model!==state.model||startDate!==state.startDate)return;
      if(model===weeklyModel&&value.execution_policy!==executionPolicy)throw new Error('周线规则版本未更新，请更新网页计算资源后重试；模拟记录保留');
      plan=value;if(plan.simulation)paperBooks[`${model===defaultModel?'':model+':'}${capital}:${cap}:${startDate}`]=plan.simulation;rememberView();draw();
      const current=chinaClock();
      if(plan.trade_date<current.day){plan=readOnlyView(plan,'计划已过期，显示已有模拟记录，等待完整的最新收盘数据。');draw();showNotice(plan.no_buy_reason,true);return;}
      if(plan.read_only)showNotice(plan.no_buy_reason,true);
      else if(!plan.live)showNotice('固定快照预览：仅核对页面，不发送桌面交易提醒。');
      else if(plan.no_buy_reason)showNotice(`起点 ${startDate} · 当前 ${plan.trade_date}：${plan.no_buy_reason}。${book().positions.length?'已有模拟持仓继续按严格卖出信号跟踪。':'当前模拟空仓，持币等待。'}`);
      else showNotice(`${plan.trade_date}模拟计划已更新，持仓和买卖记录将自动跟踪，不代表实际成交。`);
      tick();
    } catch(error){if(id===lastRequest&&model===state.model){if(!restoreSavedView(error.message+'；显示上次已核验的模拟记录，暂停新增买入。'))plan=null;draw();showNotice(plan?.no_buy_reason||error.message,true);}}
    finally{busy=false;$('refresh').disabled=false;if(id!==lastRequest||cap!==state.cap||capital!==state.capital||model!==state.model||startDate!==state.startDate)setTimeout(refresh,0);}
  }
  function tick() {
    if(!plan||!plan.live||plan.read_only)return;
    const events=reminderEvents(plan,state.cap,book(),chinaClock()).map(e=>({...e,id:modelPrefix()+e.id,noticeKeys:e.requiresConfirmation?(e.alertRows||[]).map(tradeAlertKey):[]}));
    const sell=events.filter(e=>e.id.startsWith(modelPrefix()+'sell:'));
    if(sell.length)showNotice(sell.map(e=>e.body).join('；'));
    else if(events.length)showNotice(events.map(e=>e.body).join('；'));
    else if(todayActionNotice(plan,chinaClock()))showNotice(todayActionNotice(plan,chinaClock()));
    queueTradeAlerts(events);
    void pushDesktopEvents(events);
  }
  $('capital').value=state.capital;
  $('capitalForm').addEventListener('submit',async event=>{
    event.preventDefault();const next=Number($('capital').value);
    if(!Number.isFinite(next)||next<100||next>100000000){showNotice('本金须在100元至1亿元之间',true);return;}
    state.capital=next;lastRequest++;plan=null;historyData=null;save();draw();
    $('schemes').innerHTML='';$('historyDetail').textContent='正在按新本金重算';
    showNotice('正在保存本金并重算当前模型的股数与费用…');
    beginLoading('正在保存本金并重算当前模型的股数与费用…');
    try{await request('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({capital:next})});await loadHistory();await foregroundRefresh();}
    catch(error){restoreSavedView(error.message+'；显示上次已核验记录，暂停新增买入。');draw();showNotice(error.message+'；当前本金保留为'+money(state.capital),true);}
    finally{endLoading();}
  });
  $('rollingModel').addEventListener('change',async event=>{
    state.model=event.target.value===weeklyModel?weeklyModel:defaultModel;state.cap=2;lastRequest++;plan=null;historyData=null;save();draw();
    showNotice('正在按所选模型重新计算…');
    beginLoading('正在按所选模型重新计算…');
    try{await loadHistory();await foregroundRefresh();}catch(error){showNotice(error.message,true);}finally{endLoading();}
  });
  $('schemes').addEventListener('click',event=>{const button=event.target.closest('[data-cap]');if(!button)return;state.cap=Number(button.dataset.cap);plan=null;lastRequest++;save();draw();void withLoading(async()=>{while(busy)await new Promise(resolve=>setTimeout(resolve,100));await refresh();},'正在切换持仓方案并重算…');});
  $('refresh').addEventListener('click',()=>withLoading(foregroundRefresh,'正在刷新行情并核验模拟记录…'));
  $('startDate').addEventListener('change',event=>{state.startMode=event.target.value==='latest'?'latest':'manual';if(state.startMode==='manual')state.startDate=event.target.value;lastRequest++;plan=null;save();draw();showNotice('正在从所选交易日重新计算模拟账户…');void withLoading(foregroundRefresh,'正在从所选交易日重新计算模拟账户…');});
  $('buyRows').addEventListener('change',event=>{const code=event.target.dataset.price;if(!code||!plan)return;const price=Number(event.target.value);if(!Number.isFinite(price)||price<=0){showNotice('请输入有效的评估价格。',true);return;}const key=priceKey();priceInputs[key]={...(priceInputs[key]||{}),[code]:price};draw();});
  function setTab(value){tab=value;$('planTab').setAttribute('aria-selected',String(tab==='plan'));$('historyTab').setAttribute('aria-selected',String(tab==='history'));$('planPanel').hidden=tab!=='plan';$('historyPanel').hidden=tab!=='history';}
  $('planTab').addEventListener('click',()=>setTab('plan'));$('historyTab').addEventListener('click',()=>setTab('history'));$('historyDay').addEventListener('change',drawHistoryDay);
  async function enableBrowserPush(){
    if(typeof Notification==='undefined'){showNotice('当前浏览器不支持桌面通知，页面提醒仍可用。',true);return;}
    const granted=Notification.permission==='granted'?'granted':await Notification.requestPermission();
    if(granted==='granted'){state.desktop=true;save();draw();tick();return true;}
    showNotice('桌面通知未获允许，请在浏览器站点设置中开启；页面提醒保持可用。',true);return false;
  }
  $('notify').addEventListener('click',async()=>{
    if(state.desktop){state.desktop=false;save();draw();return;}
    await enableBrowserPush();
  });
  $('enableTradePush')?.addEventListener('click',async()=>{
    const enabled=await enableBrowserPush();
    if(!enabled)$('tradeAlertPushHint').textContent='浏览器通知未获允许，请在站点设置中开启；此窗口仍须点击确认关闭。';
    if($('tradeAlertDialog').open)$('confirmTradeAlert').focus();
  });
  $('tradeAlertDialog')?.addEventListener('cancel',event=>event.preventDefault());
  $('tradeAlertDialog')?.addEventListener('close',()=>{if(state.pendingAlerts.length)showTradeAlerts();});
  $('confirmTradeAlert')?.addEventListener('click',()=>{
    state.alertSeen=[...new Set([...state.alertSeen,...state.pendingAlerts.flatMap(e=>e.keys)])].slice(-1000);
    state.pendingAlerts=[];save();$('tradeAlertDialog').close();
  });
  async function initialize(){
    showTradeAlerts();
    if(restoreSavedView())draw();
    beginLoading('正在读取计划所需数据，已有模拟记录会保留…');
    try{
      try{const value=await request('/api/settings');state.capital=value.capital;$('capital').value=state.capital;restoreSavedView();save();draw();}
      catch(error){showNotice('本机本金设置读取失败：'+error.message,true);return;}
      // The current plan must not queue behind all five historical comparisons.
      await refresh();
    }finally{endLoading();}
    await loadHistory().catch(error=>{$('historyBasis').textContent='历史推算读取失败：'+error.message;});
  }
  initialize();
  setInterval(refresh,30000);setInterval(tick,15000);
})();
