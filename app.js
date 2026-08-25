// ============ 工具函数 ============
function jsonp(url, param = 'cb') {
  return new Promise((resolve, reject) => {
    const cbName = '__jp_' + Date.now() + '_' + Math.floor(Math.random() * 100000);
    window[cbName] = function (data) { resolve(data); delete window[cbName]; };
    const s = document.createElement('script');
    s.src = url + (url.includes('?') ? '&' : '?') + param + '=' + cbName;
    s.onerror = () => { reject(new Error('网络请求失败')); delete window[cbName]; s.remove(); };
    document.body.appendChild(s);
    setTimeout(() => { if (window[cbName]) { reject(new Error('请求超时')); delete window[cbName]; s.remove(); } }, 8000);
  });
}

function fmt(n) {
  if (n == null || isNaN(n)) return '0.00';
  return Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmt3(n) {
  if (n == null || isNaN(n)) return '0.000';
  return Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
}
function todayStr() { return new Date().toISOString().slice(0, 10); }

// ============ 数据层 (IndexedDB) ============
const DB = {
  db: null,
  async init() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('stock_accounting', 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('accounts')) {
          db.createObjectStore('accounts', { keyPath: 'id', autoIncrement: true });
        }
        if (!db.objectStoreNames.contains('stocks')) {
          db.createObjectStore('stocks', { keyPath: 'id', autoIncrement: true });
        }
        if (!db.objectStoreNames.contains('transactions')) {
          db.createObjectStore('transactions', { keyPath: 'id', autoIncrement: true });
        }
      };
      req.onsuccess = (e) => { this.db = e.target.result; resolve(); };
      req.onerror = (e) => reject(e.target.error);
    });
  },
  _tx(store, mode = 'readonly') { return this.db.transaction(store, mode).objectStore(store); },
  async getAll(store) {
    return new Promise((resolve, reject) => {
      const req = this._tx(store).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  },
  async get(store, id) {
    return new Promise((resolve, reject) => {
      const req = this._tx(store).get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  async add(store, data) {
    return new Promise((resolve, reject) => {
      const req = this._tx(store, 'readwrite').add(data);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  async put(store, data) {
    return new Promise((resolve, reject) => {
      const req = this._tx(store, 'readwrite').put(data);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  async del(store, id) {
    return new Promise((resolve, reject) => {
      const req = this._tx(store, 'readwrite').delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  },
  async clear(store) {
    return new Promise((resolve, reject) => {
      const req = this._tx(store, 'readwrite').clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  },
};

// ============ 行情数据 (新浪API script标签) ============
const Market = {
  // 新浪代码格式
  toSinaCode(code, market) {
    if (market === 'HK') return 'hk' + String(code).padStart(5, '0');
    if (market === 'US') return 'gb_' + String(code).toLowerCase();
    return (code[0] === '6' || code[0] === '5') ? 'sh' + code : 'sz' + code;
  },
  // 通过script标签加载新浪行情（设置全局变量 hq_str_xxx）
  _loadScript(url) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = url;
      s.charset = 'gbk';
      s.onload = () => { s.remove(); resolve(); };
      s.onerror = () => { s.remove(); reject(new Error('加载失败')); };
      document.body.appendChild(s);
      setTimeout(() => { if (document.body.contains(s)) { s.remove(); reject(new Error('超时')); } }, 8000);
    });
  },
  async getQuotes(stocks) {
    if (!stocks.length) return [];
    const sinaCodes = stocks.map(s => this.toSinaCode(s.code, s.market));
    const url = 'https://hq.sinajs.cn/list=' + sinaCodes.join(',');
    try {
      await this._loadScript(url);
      const results = [];
      for (let i = 0; i < stocks.length; i++) {
        const sc = sinaCodes[i];
        const raw = window['hq_str_' + sc];
        if (!raw) continue;
        const parts = raw.split(',');
        const stock = stocks[i];
        if (stock.market === 'HK') {
          // 港股: data[1]=中文名, data[6]=现价, data[7]=涨跌额, data[8]=涨跌幅
          results.push({
            code: stock.code,
            name: parts[1] || stock.name,
            price: parseFloat(parts[6]) || 0,
            change_pct: parseFloat(parts[8]) || 0,
          });
        } else {
          // A股: data[0]=名称, data[3]=现价, data[2]=昨收
          const price = parseFloat(parts[3]) || 0;
          const yesterday = parseFloat(parts[2]) || 0;
          const changePct = yesterday > 0 ? ((price - yesterday) / yesterday * 100) : 0;
          results.push({
            code: stock.code,
            name: parts[0] || stock.name,
            price: price,
            change_pct: changePct,
          });
        }
      }
      return results;
    } catch (e) { console.error('行情获取失败:', e); return []; }
  },
  async search(keyword) {
    const url = 'https://searchapi.eastmoney.com/api/suggest/get?input=' + encodeURIComponent(keyword) + '&type=14&count=10';
    try {
      const data = await jsonp(url);
      if (!data || !data.QuotationCodeTable || !data.QuotationCodeTable.Data) return [];
      return data.QuotationCodeTable.Data
        .filter(item => item.MktNum === 1 || item.MktNum === 0 || item.MktNum === 116)
        .map(item => ({
          code: item.Code,
          name: item.Name,
          market: item.MktNum === 116 ? 'HK' : 'A',
        }));
    } catch (e) { console.error('搜索失败:', e); return []; }
  },
};

// ============ 业务逻辑 ============
const Calc = {
  // 重算持仓
  async recalcHoldings(accountId) {
    const txns = (await DB.getAll('transactions')).filter(t => t.account_id === accountId);
    txns.sort((a, b) => (a.trade_date || '').localeCompare(b.trade_date || '') || (a.id - b.id));
    const map = {};
    for (const t of txns) {
      const key = t.stock_code;
      if (!map[key]) map[key] = { stock_code: t.stock_code, stock_name: t.stock_name, quantity: 0, total_cost: 0 };
      const h = map[key];
      if (t.type === 'BUY') {
        h.total_cost += t.quantity * t.price + (t.fee || 0);
        h.quantity += t.quantity;
      } else if (t.type === 'SELL') {
        if (h.quantity > 0) {
          const costPortion = h.total_cost * (t.quantity / h.quantity);
          h.total_cost -= costPortion;
          h.quantity -= t.quantity;
          if (h.quantity <= 0.001) { h.total_cost = 0; h.quantity = 0; }
        }
      } else if (t.type === 'DIVIDEND') {
        h.total_cost = Math.max(0, h.total_cost - (t.dividend_per_share || 0) * h.quantity);
      } else if (t.type === 'BONUS') {
        h.quantity += h.quantity * (t.bonus_ratio || 0);
      }
    }
    return Object.values(map).filter(h => h.quantity > 0.001);
  },

  // 重算现金
  async recalcCash(accountId) {
    const account = await DB.get('accounts', accountId);
    if (!account) return 0;
    const txns = (await DB.getAll('transactions')).filter(t => t.account_id === accountId);
    let cash = account.initial_cash || 0;
    for (const t of txns) {
      if (t.type === 'BUY') cash -= (t.quantity * t.price + (t.fee || 0));
      else if (t.type === 'SELL') cash += (t.quantity * t.price - (t.fee || 0) - (t.tax || 0));
      else if (t.type === 'DIVIDEND') cash += (t.dividend_per_share || 0) * t.quantity;
    }
    return cash;
  },

  // 获取持仓（含实时价格）
  async getHoldings(accountId) {
    const holdings = await this.recalcHoldings(accountId);
    const stocks = await DB.getAll('stocks');
    for (const h of holdings) {
      const stock = stocks.find(s => s.code === h.stock_code);
      if (stock) {
        h.current_price = stock.price || 0;
        h.market_value = h.quantity * (stock.price || 0);
        h.float_pnl = h.market_value - h.total_cost;
        h.float_pnl_pct = h.total_cost > 0 ? (h.float_pnl / h.total_cost * 100) : 0;
        h.avg_cost = h.quantity > 0 ? (h.total_cost / h.quantity) : 0;
        h.stock_name = stock.name || h.stock_name;
      } else {
        h.current_price = 0; h.market_value = 0; h.float_pnl = 0; h.float_pnl_pct = 0;
        h.avg_cost = h.quantity > 0 ? (h.total_cost / h.quantity) : 0;
      }
    }
    return holdings;
  },

  // 总览
  async getOverview(accountId) {
    const account = await DB.get('accounts', accountId);
    if (!account) return { total_assets: 0, total_cost: 0, total_pnl: 0, pnl_pct: 0, cash_balance: 0, market_value: 0, holdings_count: 0 };
    const cash = await this.recalcCash(accountId);
    const holdings = await this.getHoldings(accountId);
    const market_value = holdings.reduce((s, h) => s + (h.market_value || 0), 0);
    const total_cost = holdings.reduce((s, h) => s + (h.total_cost || 0), 0);
    const total_assets = cash + market_value;
    const total_pnl = market_value - total_cost;
    const pnl_pct = total_cost > 0 ? (total_pnl / total_cost * 100) : 0;
    return { total_assets, total_cost, total_pnl, pnl_pct, cash_balance: cash, market_value, holdings_count: holdings.length };
  },

  // 净值曲线
  async getNetValue(accountId, period) {
    const txns = (await DB.getAll('transactions')).filter(t => t.account_id === accountId);
    txns.sort((a, b) => (a.trade_date || '').localeCompare(b.trade_date || ''));
    if (txns.length === 0) return [];
    const account = await DB.get('accounts', accountId);
    const stocks = await DB.getAll('stocks');
    const dates = [...new Set(txns.map(t => t.trade_date))];
    const now = todayStr();
    if (!dates.includes(now)) dates.push(now);
    const result = [];
    for (const date of dates) {
      const pastTxns = txns.filter(t => t.trade_date <= date);
      let cash = account.initial_cash || 0;
      const hMap = {};
      for (const t of pastTxns) {
        if (!hMap[t.stock_code]) hMap[t.stock_code] = { qty: 0, cost: 0, name: t.stock_name };
        const h = hMap[t.stock_code];
        if (t.type === 'BUY') { h.cost += t.quantity * t.price + (t.fee || 0); h.qty += t.quantity; cash -= t.quantity * t.price + (t.fee || 0); }
        else if (t.type === 'SELL') { const cp = h.cost * (t.quantity / h.qty); h.cost -= cp; h.qty -= t.quantity; cash += t.quantity * t.price - (t.fee || 0) - (t.tax || 0); }
        else if (t.type === 'DIVIDEND') { cash += (t.dividend_per_share || 0) * h.qty; h.cost = Math.max(0, h.cost - (t.dividend_per_share || 0) * h.qty); }
        else if (t.type === 'BONUS') { h.qty += h.qty * (t.bonus_ratio || 0); }
      }
      let marketValue = 0;
      for (const code in hMap) {
        const stock = stocks.find(s => s.code === code);
        const price = (date === now && stock) ? (stock.price || 0) : (hMap[code].cost / Math.max(hMap[code].qty, 1));
        marketValue += hMap[code].qty * price;
      }
      const totalCost = Object.values(hMap).reduce((s, h) => s + Math.max(h.cost, 0), 0);
      result.push({ date, total_assets: cash + marketValue, total_cost: totalCost, total_pnl: cash + marketValue - totalCost });
    }
    return result;
  },

  // 盈亏日历
  async getCalendar(accountId, year, month) {
    const txns = (await DB.getAll('transactions')).filter(t => t.account_id === accountId);
    const days = [];
    for (const t of txns) {
      const d = new Date(t.trade_date + 'T00:00:00');
      if (d.getFullYear() === year && d.getMonth() + 1 === month) {
        let pnl = 0;
        if (t.type === 'BUY') pnl = -(t.fee || 0);
        else if (t.type === 'SELL') {
          const holdings = await this.recalcHoldings(accountId);
          const h = holdings.find(x => x.stock_code === t.stock_code);
          const avgCost = h && h.quantity > 0 ? h.total_cost / h.quantity : 0;
          pnl = (t.quantity * t.price - (t.fee || 0) - (t.tax || 0)) - t.quantity * avgCost;
        }
        else if (t.type === 'DIVIDEND') pnl = (t.dividend_per_share || 0) * t.quantity;
        days.push({ date: t.trade_date, pnl });
      }
    }
    return { days };
  },

  // 回撤分析
  async getDrawdown(accountId, period) {
    const nav = await this.getNetValue(accountId, period);
    if (nav.length < 2) return { max_drawdown_pct: 0, current_drawdown_pct: 0, events: [] };
    let peak = nav[0].total_assets;
    let maxDD = 0, currentPeak = nav[0].total_assets, currentDD = 0;
    let peakDate = nav[0].date, troughDate = nav[0].date, maxPeakDate = nav[0].date, maxTroughDate = nav[0].date;
    for (const point of nav) {
      if (point.total_assets > currentPeak) { currentPeak = point.total_assets; peakDate = point.date; }
      const dd = currentPeak > 0 ? ((currentPeak - point.total_assets) / currentPeak * 100) : 0;
      if (dd > maxDD) { maxDD = dd; maxPeakDate = peakDate; maxTroughDate = point.date; }
      currentDD = dd;
    }
    return {
      max_drawdown_pct: maxDD,
      current_drawdown_pct: currentDD,
      events: maxDD > 0 ? [{ peak_date: maxPeakDate, trough_date: maxTroughDate, drawdown_pct: maxDD, duration_days: Math.round((new Date(maxTroughDate) - new Date(maxPeakDate)) / 86400000) }] : [],
    };
  },

  // 添加交易
  async addTransaction(data) {
    const id = await DB.add('transactions', data);
    return id;
  },
  async deleteTransaction(id) {
    await DB.del('transactions', id);
  },
};

// ============ 种子数据 ============
async function seedData() {
  await DB.clear('accounts'); await DB.clear('stocks'); await DB.clear('transactions');
  const accId = await DB.add('accounts', { name: '我的账户', broker: '华泰证券', initial_cash: 200000, created_at: todayStr() });
  const stocks = [
    { code: '600519', name: '贵州茅台', market: 'A' },
    { code: '000858', name: '五粮液', market: 'A' },
    { code: '601318', name: '中国平安', market: 'A' },
    { code: '600036', name: '招商银行', market: 'A' },
    { code: '00700', name: '腾讯控股', market: 'HK' },
  ];
  for (const s of stocks) { s.price = 0; s.change_pct = 0; s.updated_at = ''; await DB.add('stocks', s); }
  const txns = [
    { account_id: accId, stock_code: '600519', stock_name: '贵州茅台', type: 'BUY', quantity: 100, price: 1480, fee: 37, tax: 0, dividend_per_share: 0, bonus_ratio: 0, trade_date: '2026-07-26', note: '' },
    { account_id: accId, stock_code: '000858', stock_name: '五粮液', type: 'BUY', quantity: 500, price: 145, fee: 18.13, tax: 0, dividend_per_share: 0, bonus_ratio: 0, trade_date: '2026-07-31', note: '' },
    { account_id: accId, stock_code: '601318', stock_name: '中国平安', type: 'BUY', quantity: 1000, price: 45, fee: 11.25, tax: 0, dividend_per_share: 0, bonus_ratio: 0, trade_date: '2026-08-05', note: '' },
    { account_id: accId, stock_code: '600036', stock_name: '招商银行', type: 'BUY', quantity: 2000, price: 35, fee: 17.5, tax: 0, dividend_per_share: 0, bonus_ratio: 0, trade_date: '2026-08-10', note: '' },
    { account_id: accId, stock_code: '000858', stock_name: '五粮液', type: 'SELL', quantity: 100, price: 152, fee: 7.6, tax: 3.8, dividend_per_share: 0, bonus_ratio: 0, trade_date: '2026-08-15', note: '' },
    { account_id: accId, stock_code: '600519', stock_name: '贵州茅台', type: 'DIVIDEND', quantity: 100, price: 0, fee: 0, tax: 0, dividend_per_share: 25.91, bonus_ratio: 0, trade_date: '2026-08-20', note: '每股分红25.91元' },
  ];
  for (const t of txns) await DB.add('transactions', t);
  return accId;
}
