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
  function reminderEvents(plan, cap, book, clock) {
    if (!plan?.live) return [];
    const events = [], knownGate = typeof plan.market.allow_buy === 'boolean';
    const buys = buyPlan(plan,cap,book).filter(r=>r.qty>0);
    const summary = buys.length ? buys.map(r=>`${r.code} ${r.name||''}（参考${r.qty}股）`).join('、') : '无可新增股票，继续等待';
    const ready = knownGate && (!plan.market.allow_buy || plan.complete);
    if (clock.day === plan.signal_date && clock.time >= '15:05' && ready) events.push({
      id: `close:${cap}:${plan.signal_date}`, title: '模拟方案：下一交易日计划已更新',
      body: `${cap}只方案 · ${plan.trade_date}：${plan.market.allow_buy ? summary : '大盘暂停新买，持币等待'}`});
    if (clock.day === plan.trade_date && clock.time >= '09:20' && clock.time < '09:35' && ready) events.push({
      id: `open:${cap}:${plan.trade_date}`, title: '模拟方案：开盘计划提醒',
      body: `${cap}只方案：${plan.market.allow_buy ? summary+'；09:30按实际价格评估' : '今日暂停新买，已有持仓继续跟踪卖出信号'}`});
    for (const row of plan.positions) {
      const sell = row.sell;
      if (!sell || !book.positions.some(p => p.code === row.code) || !sell.execution_at) continue;
      if(plan.simulation?.created_at && sell.confirmed_at < plan.simulation.created_at.slice(0,19).replace('T',' '))continue;
      const pendingToday = sell.execution_at.slice(0, 10) === clock.day;
      const newToday = sell.confirmed_at.slice(0, 10) === clock.day;
      const fresh = row.quote_fresh !== false && (row.last_bar?.slice(0, 10) === clock.day || (pendingToday && clock.time < '09:35' && row.last_bar >= sell.confirmed_at));
      if ((!newToday && !pendingToday) || !fresh) continue;
      const due = pendingToday && clock.time >= sell.execution_at.slice(11, 16);
      events.push({id: `sell:${cap}:${row.code}:${sell.confirmed_at}:${due ? 'due' : 'confirmed'}`,
        title: due ? '模拟卖出时段已到' : '模拟持仓：严格卖出信号已确认',
        body: `${row.code} ${row.name} · ${sell.reason}；最早${sell.execution_at}模拟卖出，仅用于方案跟踪，不代表实际成交`});
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
  const api = {sizePurchase, account, buyPlan, reminderEvents, historicalTradeTimes, profitMarkup, stockCode, returnTone};
  if (typeof module !== 'undefined') module.exports = api;
  if (typeof document === 'undefined') return;

  const $ = id => document.getElementById(id), escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money = n => new Intl.NumberFormat('zh-CN', {style:'currency', currency:'CNY'}).format(n);
  const pct = n => n == null ? '—' : (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
  const cls = returnTone;
  const key = 'waxwing_position_plan_v2';
  let state = {capital:50000, cap:2, desktop:false, seen:[],startMode:'latest',startDate:null};
  try { const value = JSON.parse(localStorage.getItem(key)||localStorage.getItem('waxwing_position_plan_v1')); if (value && Number.isFinite(value.capital) && value.capital >= 100) state = {capital:value.capital,cap:value.cap,desktop:Boolean(value.desktop),seen:value.seen||[],startMode:value.startMode==='manual'?'manual':'latest',startDate:value.startDate||null}; } catch (_) {}
  let historyData, plan, busy = false, lastRequest = 0, tab = 'plan', priceInputs={}, paperBooks={};
  function currentPrices(){return priceInputs[`${state.startDate}:${state.cap}:${plan?.trade_date}`]||{};}
  function save() { try { localStorage.setItem(key, JSON.stringify(state)); } catch (_) { $('status').textContent = '浏览器未允许保存设置；模拟记录仍保存在本机服务中。'; } }
  function chinaClock() { const parts = new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date()).split(' '); return {day:parts[0],time:parts[1]}; }
  function book() { return paperBooks[`${state.capital}:${state.cap}:${state.startDate}`]||{cash:state.capital,positions:[],ledger:[],unloaded:true}; }
  function metric(label, value, tone='') { return `<div class="metric"><span>${escape(label)}</span><strong class="${tone}">${escape(value)}</strong></div>`; }
  function empty(columns, text) { return `<tr><td colspan="${columns}" class="empty">${escape(text)}</td></tr>`; }
  function showNotice(text, error=false) { $('notice').textContent = text; $('notice').classList.toggle('error', error); }
  async function request(url, options={}) { if(globalThis.WaXwingRollingStatic)return globalThis.WaXwingRollingStatic.request(url,options);const response = await fetch(url, {...options, cache:'no-store'}), value = await response.json(); if (!response.ok || value.error) throw new Error(value.error || '读取失败'); return value; }

  function draw() {
    $('accountNote').textContent = `起点 ${state.startDate||'待读取'} · 当前${state.cap}只方案 · 模拟本金${money(state.capital)}`;
    $('schemes').innerHTML = historyData ? historyData.selected_caps.map(cap => `<button data-cap="${cap}" class="${state.cap===cap?'active':''}" aria-pressed="${state.cap===cap}">最多${cap}只<small>${historyData.top_two.includes(cap)?'历史前二':'保留方案'} · <span class="return-chip ${cls(historyData.results[cap].net_pct)}">${pct(historyData.results[cap].net_pct)}</span></small></button>`).join('') : '';
    $('accountNote').textContent = `起点 ${state.startDate||'待读取'} · 当前${state.cap}只方案 · 模拟本金${money(state.capital)}`;
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
    const rows = buyPlan(plan,state.cap,b,currentPrices());
    $('planTitle').textContent = plan ? `${state.startDate} 起 · 买入计划` : '买入计划';
    $('marketBadge').textContent = plan ? `当前大盘：${plan.market.state}` : '';
    $('planReason').textContent = !plan ? '数据尚未核验，暂停新增模拟买入。' : plan.no_buy_reason || (plan.simulation?.opened_days?.includes(plan.trade_date)?'本日开盘模拟已完成，盘中空位等待下一交易日':!priced?'模拟持仓行情未核验，暂停新买预算计算':!rows.length?'没有可新增的空位或当日新提醒':'开盘按下列顺序评估模拟新买');
    $('buyBasis').textContent = plan ? `当前计划交易日 ${plan.trade_date} · 信号日 ${plan.signal_date} · 最多考察排序前${state.cap}名 · 每笔预算为前收盘参考资产的1/${state.cap}` : '';
    $('simulationBasis').textContent = `从 ${state.startDate||'所选交易日'} 以零持仓和设定本金开始，按前一交易日信号模拟买入，随后滚动到最新行情。过去日期不补发旧提醒，模拟持仓不代表实际成交。`;
    const firstBuys=(b.ledger||[]).filter(e=>e.side==='模拟买入'&&e.at.slice(0,10)===state.startDate);
    $('startPurchases').hidden=state.startDate===chinaClock().day||b.unloaded;
    $('startPurchasesTitle').textContent=`起点当日模拟买入 · ${state.startDate}`;
    $('startPurchaseRows').innerHTML=firstBuys.map(e=>`<tr><td>${escape(e.at)}</td><td>${stockCode(e.code)} ${escape(e.name)}<small>${escape(e.model)}</small></td><td>${e.qty}</td><td>${e.price.toFixed(3)}</td><td>${money(-e.cash_change)}</td></tr>`).join('')||empty(5,'起点当日未模拟买入，从现金开始继续按规则等待');
    $('buyRows').innerHTML = rows.length ? rows.map(r => `<tr><td>${stockCode(r.code)} ${escape(r.name)}<small>${escape(r.model)}</small></td><td>${escape(r.signal_day)}</td><td>${(r.atr_fraction*100).toFixed(2)}%</td><td><input style="width:110px" type="number" min="0.001" step="any" value="${r.evaluation_price}" data-price="${escape(r.code)}" aria-label="${escape(r.name)}评估买入价"><small>信号收盘 ${r.reference_price.toFixed(3)}</small></td><td>${r.qty ? r.qty+'股':r.blocked?'接近涨停，跳过':'预算不足最小买入量'}</td><td>${money(r.cost)}</td></tr>`).join('') : empty(6,plan?.no_buy_reason || '暂无可执行买入名单');
    $('holdingRows').innerHTML = b.positions.length ? b.positions.map(p => {
      const q=marks.get(p.code),v=valuation?.positions?.[p.code],sell=q?.sell;
      return `<tr><td>${stockCode(p.code)} ${escape(p.name)}</td><td>${escape(p.entry_day)}<small>信号 ${escape(p.signal_day)} · ${escape(p.model)}</small></td><td>${p.qty}股<small>含费成本 ${v?money(v.cost_price):'待核验'}</small></td><td>${v?v.price.toFixed(3):'—'}</td><td>${profitMarkup(v?.daily_pnl,v?.daily_pct)}${v?`<small>${escape(v.day)}${v.day!==chinaClock().day?' · 今日待更新':''}</small>`:''}</td><td>${profitMarkup(v?.holding_pnl,v?.holding_pct)}</td><td>${escape(v?.asof||q?.last_bar||'待核验')}</td><td>${sell?`${escape(sell.reason)}<small>确认 ${escape(sell.confirmed_at)}<br>最早模拟执行 ${escape(sell.execution_at)}</small>`:escape(q?.status||'严格卖出待30分钟行情核验')}</td></tr>`;
    }).join('') : empty(8,b.unloaded?'模拟持仓待同步':'当前模拟空仓，按当日方案持币等待');
    $('dailyBasis').textContent=valuation?.days?.length?`${valuation.from}—${valuation.through} · ${valuation.days.length}个交易日，包含继续持有和空仓日。${valuation.basis}`:valuation?.error||'逐日模拟记录待读取；没有买卖的交易日也会显示。';
    $('dailyRows').innerHTML=(valuation?.days||[]).map(row=>`<tr><td>${escape(row.day)}</td><td>${row.actions.length?row.actions.map(e=>`${escape(e.side)} ${stockCode(e.code)} ${escape(e.name||'')} ${e.qty?e.qty+'股':''}`).join('<br>'):row.state==='持有'?'继续持有':'空仓等待'}</td><td>${row.positions.length?row.positions.map(p=>`${stockCode(p.code)} ${escape(p.name)} · ${p.qty}股${p.valuation?`<small>核验价 ${p.valuation.price.toFixed(3)} · ${profitMarkup(p.valuation.daily_pnl,p.valuation.daily_pct)}</small>`:'<small>当日行情待核验</small>'}`).join('<br>'):'空仓 · 持币'}</td><td>${row.equity==null?'当日行情待核验':money(row.equity)}<small>现金 ${money(row.cash)}</small></td><td>${profitMarkup(row.daily_pnl,row.daily_pct)}</td><td>${profitMarkup(row.total_pnl,row.total_pct)}</td></tr>`).join('')||empty(6,'逐日模拟记录待读取');
    $('simulationRows').innerHTML = (valuation?.trades||b.ledger||[]).map(t=>`<tr><td>${escape(t.at)}</td><td>${escape(t.side)}</td><td>${stockCode(t.code)} ${escape(t.name)}</td><td>${t.qty} × ${t.price}</td><td>${money(t.fee)}</td><td>${profitMarkup(t.pnl,t.net_pct)}</td><td>${escape(t.confirmed_at||t.signal_day)}</td></tr>`).join('')||empty(7,'尚无模拟买卖记录；持有与空仓日见上方逐日记录');
    $('metadata').textContent = plan ? `行情信号日 ${plan.signal_date} · 计划交易日 ${plan.trade_date} · 数据读取 ${plan.generated_at.slice(0,19).replace('T',' ')}（北京时间）` : '当前数据不可用，本机模拟记录保留';
    $('notify').textContent = state.desktop ? '关闭桌面提醒' : '开启桌面提醒';
    $('notifyStatus').textContent = `${state.desktop?'桌面提醒已开启':'桌面提醒未开启'}。页面内始终显示提醒；页面须保持打开，浏览器休眠、系统免打扰或断网可能延迟通知。`;
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
    $('historyBasis').textContent=`${historyData.from}—${historyData.through} · ${r.curve.length}个交易日 · 本金${money(state.capital)} · 只投入一次，逐日滚动。当前本金已重新计算整手及费用。`;
    $('historyMetrics').innerHTML=metric('累计净收益',pct(r.net_pct),cls(r.net_pct))+metric('最大收盘回撤',pct(-Math.abs(r.dd_pct)),cls(-Math.abs(r.dd_pct)))+metric('已卖笔数 / 胜率',`${r.closed_n}笔 / ${pct(r.closed_win_pct)}`);
    const prior=$('historyDay').value;
    $('historyDay').innerHTML=r.curve.map(d=>`<option value="${d.day}">${d.day}</option>`).join('');
    $('historyDay').value=r.curve.some(d=>d.day===prior)?prior:r.curve[0].day;
    $('historyRows').innerHTML=r.curve.map(d=>`<tr><td>${d.day}</td><td>${money(d.equity)}</td><td>${money(d.cash)}</td><td class="${cls(d.net_pct)}">${pct(d.net_pct)}</td><td>${escape(d.holdings)}</td></tr>`).join('');
    $('historyTradeTimes').innerHTML=historicalTradeTimes(r).map(t=>`<tr><td>${stockCode(t.code)} ${escape(t.name)}<small>${escape(t.model)}</small></td><td>${escape(t.buy_confirmed||'未保存确认时刻')}</td><td>${escape(t.buy_at)}</td><td>${escape(t.sell_confirmed||'截至'+historyData.through+'未触发')}</td><td>${escape(t.sell_at||'仍持有')}</td><td>${t.qty}</td><td>${profitMarkup(t.pnl,t.net_pct)}<small>${t.sell_at?'已卖出':'截至'+historyData.through+'持有浮盈亏'}</small></td></tr>`).join('')||empty(7,'该本金下没有历史买入');
    const curves=historyData.selected_caps.map(c=>historyData.results[c].curve),values=curves.flatMap(c=>c.map(d=>d.net_pct)),colors=['#2563eb','#17645e','#6976a5'];
    const lo=Math.min(0,...values)-.3, hi=Math.max(0,...values)+.3, x=i=>50+i*800/Math.max(1,curves[0].length-1), y=v=>205-(v-lo)/(hi-lo)*165;
    $('chart').innerHTML=`<svg viewBox="0 0 900 250" role="img" aria-label="历史收益曲线"><line x1="50" y1="${y(0)}" x2="850" y2="${y(0)}" stroke="#ccd8e4"/><text x="2" y="${y(0)+4}" fill="#64758a" font-size="12">0%</text>${curves.map((c,i)=>`<polyline points="${c.map((d,j)=>x(j)+','+y(d.net_pct)).join(' ')}" fill="none" stroke="${colors[i]}" stroke-width="2.5"/><text x="${50+i*240}" y="22" fill="${c[c.length-1].net_pct>0?'#c62828':c[c.length-1].net_pct<0?'#16803e':'#64758a'}" font-size="13">${historyData.selected_caps[i]}只方案 · ${pct(c[c.length-1].net_pct)}</text>`).join('')}<text x="50" y="235" fill="#64758a" font-size="12">${historyData.from}</text><text x="770" y="235" fill="#64758a" font-size="12">${historyData.through}</text></svg>`;
    drawHistoryDay();
  }
  function drawHistoryDay() {
    if(!historyData)return;
    const r=historyData.results[state.cap],day=$('historyDay').value,d=r.curve.find(x=>x.day===day),events=r.ledger.filter(e=>e.at.slice(0,10)===day);
    $('historyDetail').innerHTML=`<p>${escape(d.holdings)} · 期末资产${money(d.equity)} · 累计<span class="${cls(d.net_pct)}">${pct(d.net_pct)}</span></p><div class="scroll"><table><thead><tr><th>时间</th><th>买卖</th><th>股票 / 来源模型</th><th>股数</th><th>基准价</th><th>现金变动</th></tr></thead><tbody>${events.map(e=>`<tr><td>${escape(e.at)}</td><td>${escape(e.side)}</td><td>${stockCode(e.code)} ${escape(e.name)}<small>${escape(e.model)}</small></td><td>${e.qty}</td><td>${e.price.toFixed(3)}</td><td>${money(e.cash_change)}</td></tr>`).join('')||empty(6,'该日没有买卖，继续持有或持币')}</tbody></table></div>`;
  }
  async function loadHistory() {
    $('capitalForm').querySelector('button').disabled=true;
    const capital=state.capital;
    try {const value=await request('/api/history?capital='+encodeURIComponent(capital));if(capital!==state.capital)return;historyData=value;if(!historyData.selected_caps.includes(state.cap))state.cap=historyData.selected_caps[0];save();draw();}
    finally{$('capitalForm').querySelector('button').disabled=false;}
  }
  async function loadStartOptions(){
    const value=await request('/api/options');
    if(state.startMode==='latest'||!value.dates.includes(state.startDate)){state.startMode='latest';state.startDate=value.default_start;}
    const html=`<option value="latest">最近交易日 · ${value.default_start}</option>`+value.dates.slice().reverse().map(d=>`<option value="${d}">${d}</option>`).join('');
    if($('startDate').innerHTML!==html)$('startDate').innerHTML=html;
    $('startDate').value=state.startMode==='latest'?'latest':state.startDate;
    $('startDate').disabled=false;save();
  }
  async function refresh() {
    if(busy)return;busy=true;const id=++lastRequest,cap=state.cap,capital=state.capital;
    let startDate=state.startDate;
    $('refresh').disabled=true;
    try {
      await loadStartOptions();startDate=state.startDate;if(id!==lastRequest)return;
      const value=await request('/api/plan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({capital,cap,start_date:startDate})});
      if(id!==lastRequest||cap!==state.cap||capital!==state.capital||startDate!==state.startDate)return;
      plan=value;if(plan.simulation)paperBooks[`${capital}:${cap}:${startDate}`]=plan.simulation;draw();
      const current=chinaClock();
      if(plan.trade_date<current.day){plan=null;draw();showNotice('计划已过期，等待完整的最新收盘数据。',true);return;}
      if(!plan.live)showNotice('固定快照预览：仅核对页面，不发送桌面交易提醒。');
      else if(plan.no_buy_reason)showNotice(`起点 ${startDate} · 当前 ${plan.trade_date}：${plan.no_buy_reason}。${book().positions.length?'已有模拟持仓继续按严格卖出信号跟踪。':'当前模拟空仓，持币等待。'}`);
      else showNotice(`${plan.trade_date}模拟计划已更新，持仓和买卖记录将自动跟踪，不代表实际成交。`);
      tick();
    } catch(error){plan=null;draw();showNotice(error.message,true);}
    finally{busy=false;$('refresh').disabled=false;if(id!==lastRequest||cap!==state.cap||capital!==state.capital||startDate!==state.startDate)setTimeout(refresh,0);}
  }
  function tick() {
    if(!plan)return;
    const events=reminderEvents(plan,state.cap,book(),chinaClock());
    const sell=events.filter(e=>e.id.startsWith('sell:'));
    if(sell.length)showNotice(sell.map(e=>e.body).join('；'));
    else if(events.length)showNotice(events.map(e=>e.body).join('；'));
    if(!state.desktop || typeof Notification==='undefined' || Notification.permission!=='granted')return;
    for(const e of events){if(state.seen.includes(e.id))continue;try{const n=new Notification(e.title,{body:e.body,tag:e.id});n.onclick=()=>{window.focus();n.close();};state.seen.push(e.id);}catch(_){$('notifyStatus').textContent='桌面通知未能显示，请检查浏览器和系统通知权限。';}}
    state.seen=state.seen.slice(-500);save();
  }
  $('capital').value=state.capital;
  $('capitalForm').addEventListener('submit',async event=>{
    event.preventDefault();const next=Number($('capital').value);
    if(!Number.isFinite(next)||next<100||next>100000000){showNotice('本金须在100元至1亿元之间',true);return;}
    state.capital=next;lastRequest++;plan=null;historyData=null;save();draw();
    $('schemes').innerHTML='';$('historyDetail').textContent='正在按新本金重算';
    showNotice('正在保存本金并重算五种方案的股数与费用…');
    try{await request('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({capital:next})});await loadHistory();await refresh();}
    catch(error){showNotice(error.message+'；当前本金保留为'+money(state.capital),true);}
  });
  $('schemes').addEventListener('click',event=>{const button=event.target.closest('[data-cap]');if(!button)return;state.cap=Number(button.dataset.cap);plan=null;lastRequest++;save();draw();if(busy)setTimeout(refresh,1500);else refresh();});
  $('refresh').addEventListener('click',refresh);
  $('startDate').addEventListener('change',event=>{state.startMode=event.target.value==='latest'?'latest':'manual';if(state.startMode==='manual')state.startDate=event.target.value;lastRequest++;plan=null;save();draw();showNotice('正在从所选交易日重新计算模拟账户…');refresh();});
  $('buyRows').addEventListener('change',event=>{const code=event.target.dataset.price;if(!code||!plan)return;const price=Number(event.target.value);if(!Number.isFinite(price)||price<=0){showNotice('请输入有效的评估价格。',true);return;}const key=`${state.startDate}:${state.cap}:${plan.trade_date}`;priceInputs[key]={...(priceInputs[key]||{}),[code]:price};draw();});
  function setTab(value){tab=value;$('planTab').setAttribute('aria-selected',String(tab==='plan'));$('historyTab').setAttribute('aria-selected',String(tab==='history'));$('planPanel').hidden=tab!=='plan';$('historyPanel').hidden=tab!=='history';}
  $('planTab').addEventListener('click',()=>setTab('plan'));$('historyTab').addEventListener('click',()=>setTab('history'));$('historyDay').addEventListener('change',drawHistoryDay);
  $('notify').addEventListener('click',async()=>{
    if(state.desktop){state.desktop=false;save();draw();return;}
    if(typeof Notification==='undefined'){showNotice('当前浏览器不支持桌面通知，页面提醒仍可用。',true);return;}
    const granted=Notification.permission==='granted'?'granted':await Notification.requestPermission();
    if(granted==='granted'){state.desktop=true;save();draw();tick();}else showNotice('桌面通知未获允许，请在浏览器站点设置中开启；页面提醒保持可用。',true);
  });
  async function initialize(){
    try{const value=await request('/api/settings');state.capital=value.capital;$('capital').value=state.capital;save();draw();}
    catch(error){showNotice('本机本金设置读取失败：'+error.message,true);return;}
    await Promise.all([loadHistory().catch(error=>showNotice(error.message,true)),refresh()]);
  }
  initialize();
  setInterval(refresh,30000);setInterval(tick,15000);
})();
