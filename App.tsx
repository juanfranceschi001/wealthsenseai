
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Stock, AIAnalysisResult, Prediction, MarketInsight } from './types';
import { analyzePortfolio, parsePortfolioFromText, syncStockPrices, RateLimitError } from './services/geminiService';
import { StockCard } from './components/StockCard';
import { MarketInsightCard } from './components/MarketInsightCard';
import { AddStockModal } from './components/AddStockModal';

const INITIAL_STOCKS: Stock[] = [
  { symbol: 'NVDA', name: 'NVIDIA Corporation', price: 145.20, change: 2.30, changePercent: 1.61, shares: 10, avgCost: 120.00 },
  { symbol: 'AAPL', name: 'Apple Inc.', price: 231.50, change: -1.20, changePercent: -0.52, shares: 15, avgCost: 195.00 },
];

const STORAGE_KEY = 'wealthsense_portfolio_v2';
const PRICE_SYNC_INTERVAL = 60000; // matches the quote proxy's 60s cache
const WATCH_MODE_INTERVAL = 300000; 
const COOLDOWN_PERIOD = 60000; 

type SortKey = 'symbol' | 'price' | 'changePercent' | 'value' | 'shares';
type SortOrder = 'asc' | 'desc';

const App: React.FC = () => {
  const [portfolio, setPortfolio] = useState<Stock[]>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        // Older Smart Paste imports saved a 'Loading...' placeholder name that never resolved.
        return JSON.parse(saved).map((s: Stock) => s.name === 'Loading...' ? { ...s, name: s.symbol } : s);
      } catch (e) { return INITIAL_STOCKS; }
    }
    return INITIAL_STOCKS;
  });

  const [sortKey, setSortKey] = useState<SortKey>('symbol');
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc');
  const [analysis, setAnalysis] = useState<AIAnalysisResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isWatchMode, setIsWatchMode] = useState(false);
  const [isCoolingDown, setIsCoolingDown] = useState(false);
  const [lastAnalysisTime, setLastAnalysisTime] = useState<Date | null>(null);
  const [quotaError, setQuotaError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  
  const [showSmartImport, setShowSmartImport] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [importText, setImportText] = useState('');

  // Persist portfolio
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(portfolio));
  }, [portfolio]);

  // Handle toast clearing
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  const triggerCooldown = useCallback(() => {
    setIsCoolingDown(true);
    setQuotaError("Rate limit reached. Pausing sync for 60s...");
    setTimeout(() => {
      setIsCoolingDown(false);
      setQuotaError(null);
    }, COOLDOWN_PERIOD);
  }, []);

  const runAIAnalysis = useCallback(async (isAuto = false) => {
    if (portfolio.length === 0 || isLoading || isCoolingDown) return;
    
    setIsLoading(true);
    setQuotaError(null);
    try {
      const result = await analyzePortfolio(portfolio);
      setAnalysis(result);
      setLastAnalysisTime(new Date());
      if (!isAuto) setToast("Portfolio Analysis Complete");
    } catch (error) {
      if (error instanceof RateLimitError) {
        triggerCooldown();
      } else if (!isAuto) {
        setToast("AI analysis failed. Check your connection and try again.");
      }
    } finally {
      setIsLoading(false);
    }
  }, [portfolio, isLoading, isCoolingDown, triggerCooldown]);

  // Real-time Price Sync
  useEffect(() => {
    const fetchLatestPrices = async () => {
      if (document.visibilityState !== 'visible' || portfolio.length === 0 || isCoolingDown) return;
      
      try {
        const symbols = portfolio.map(s => s.symbol);
        const latest = await syncStockPrices(symbols);
        setPortfolio(prev => prev.map(s => {
          const update = latest[s.symbol.toUpperCase()];
          return update ? { ...s, ...update } : s;
        }));
        setQuotaError(null);
      } catch (error) {
        if (error instanceof RateLimitError) {
          triggerCooldown();
        }
      }
    };

    const interval = setInterval(fetchLatestPrices, PRICE_SYNC_INTERVAL);
    fetchLatestPrices();
    
    return () => clearInterval(interval);
  }, [portfolio.length, isCoolingDown, triggerCooldown]);

  // Watch Mode Auto-analysis
  useEffect(() => {
    if (!isWatchMode) return;
    const watchInterval = setInterval(() => {
      runAIAnalysis(true);
    }, WATCH_MODE_INTERVAL);
    return () => clearInterval(watchInterval);
  }, [isWatchMode, runAIAnalysis]);

  const handleSmartImport = async () => {
    setIsLoading(true);
    try {
      const extracted = await parsePortfolioFromText(importText);
      const formatted = extracted.map(ext => ({
        symbol: ext.symbol?.toUpperCase() || '?',
        name: ext.name || ext.symbol?.toUpperCase() || 'Unknown',
        price: 0,
        change: 0,
        changePercent: 0,
        shares: ext.shares || 0,
        avgCost: ext.avgCost || 0
      }));
      setPortfolio(prev => [...prev, ...formatted]);
      setShowSmartImport(false);
      setImportText('');
      setToast("Imported assets successfully");
    } catch (error) {
      if (error instanceof RateLimitError) triggerCooldown();
      else setToast("Import failed. Check your connection and try again.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleAddStock = (symbol: string, name: string, shares: number, avgCost: number) => {
    const newStock: Stock = {
      symbol: symbol.toUpperCase(),
      name,
      price: 0,
      change: 0,
      changePercent: 0,
      shares,
      avgCost
    };
    
    setPortfolio(prev => {
      const exists = prev.findIndex(s => s.symbol === newStock.symbol);
      if (exists !== -1) {
        const updated = [...prev];
        updated[exists] = {
          ...updated[exists],
          shares: updated[exists].shares + shares,
          avgCost: avgCost > 0 ? (updated[exists].avgCost + avgCost) / 2 : updated[exists].avgCost
        };
        return updated;
      }
      return [newStock, ...prev];
    });
  };

  const handleUpdateShares = (symbol: string, newAmount: number) => {
    setPortfolio(prev => prev.map(s => 
      s.symbol === symbol ? { ...s, shares: Math.max(0, newAmount) } : s
    ));
  };

  // Sorting logic
  const sortedPortfolio = useMemo(() => {
    return [...portfolio].sort((a, b) => {
      let aVal: any;
      let bVal: any;

      switch(sortKey) {
        case 'value':
          aVal = a.price * a.shares;
          bVal = b.price * b.shares;
          break;
        case 'symbol':
          aVal = a.symbol;
          bVal = b.symbol;
          break;
        default:
          aVal = a[sortKey as keyof Stock];
          bVal = b[sortKey as keyof Stock];
      }

      if (typeof aVal === 'string') {
        return sortOrder === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      }
      return sortOrder === 'asc' ? aVal - bVal : bVal - aVal;
    });
  }, [portfolio, sortKey, sortOrder]);

  const totalValue = portfolio.reduce((acc, s) => acc + (s.price * s.shares), 0);
  const getPrediction = (symbol: string) => analysis?.predictions.find(p => p.symbol.toUpperCase() === symbol.toUpperCase());

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 antialiased font-sans flex flex-col">
      {/* Mobile-optimized Header with Safe Area support */}
      <nav className="border-b border-slate-800 bg-slate-900/95 backdrop-blur-xl sticky top-0 z-50 px-4 py-3 pt-[env(safe-area-inset-top,12px)]">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center shadow-lg shadow-blue-600/20">
              <i className="fas fa-brain text-white"></i>
            </div>
            <div>
              <h1 className="text-lg font-black tracking-tight leading-none uppercase">WealthSense<span className="text-blue-500">AI</span></h1>
              <div className="flex items-center gap-2 mt-1">
                <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">Stock Intelligence</p>
                {isCoolingDown && (
                  <span className="text-[8px] bg-amber-500/20 text-amber-500 px-1.5 py-0.5 rounded font-black uppercase tracking-tighter animate-pulse">
                    Quota Wait
                  </span>
                )}
              </div>
            </div>
          </div>
          
          <div className="flex items-center gap-2">
            <button 
              onClick={() => runAIAnalysis()}
              disabled={isLoading || isCoolingDown}
              className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 px-5 py-2.5 rounded-xl text-xs font-black uppercase tracking-widest shadow-lg shadow-blue-600/20 active:scale-95 transition-all"
            >
              {isLoading ? <i className="fas fa-spinner fa-spin"></i> : 'AI Audit'}
            </button>
          </div>
        </div>
      </nav>

      {quotaError && (
        <div className="bg-amber-500/10 border-b border-amber-500/20 px-4 py-2 flex items-center justify-center gap-2 overflow-hidden animate-in slide-in-from-top duration-500">
          <i className="fas fa-clock text-amber-500 text-xs"></i>
          <p className="text-[10px] font-black uppercase tracking-widest text-amber-400">{quotaError}</p>
        </div>
      )}

      <main className="max-w-7xl mx-auto p-4 sm:p-6 space-y-8 pb-32 flex-grow w-full">
        
        {/* Global Financial Disclaimer Banner */}
        <div className="bg-amber-500/5 border border-amber-500/20 rounded-[32px] p-6 flex flex-col sm:flex-row items-center gap-6 relative overflow-hidden group">
          <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-amber-500/50 to-transparent"></div>
          <div className="w-16 h-16 bg-amber-500/10 rounded-2xl flex items-center justify-center text-amber-500 shrink-0 shadow-lg shadow-amber-500/5">
            <i className="fas fa-triangle-exclamation text-2xl animate-pulse"></i>
          </div>
          <div className="text-center sm:text-left">
            <h3 className="text-amber-500 text-[10px] font-black uppercase tracking-[0.2em] mb-1">Financial Risk Disclosure</h3>
            <p className="text-slate-400 text-[11px] leading-relaxed max-w-3xl">
              All signals and predictions generated by WealthSenseAI are <span className="text-slate-100 font-bold">non-binding suggestions</span>. We are <span className="text-slate-100 font-bold underline decoration-amber-500/50">not financial advisors</span> and are not responsible for your financial decisions. Always Perform your own research (DYOR) before any trade.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="md:col-span-2 bg-slate-900 border border-slate-800 rounded-[32px] p-8 relative overflow-hidden shadow-2xl">
            <div className="absolute top-0 right-0 p-8 opacity-5 text-8xl pointer-events-none">
              <i className="fas fa-wallet"></i>
            </div>
            <h2 className="text-slate-500 text-[10px] font-black uppercase tracking-widest mb-2">Total Net Worth</h2>
            <div className="text-5xl font-black text-white tracking-tighter mb-4">
              ${totalValue.toLocaleString(undefined, { minimumFractionDigits: 2 })}
            </div>
            <div className="flex flex-wrap items-center gap-3">
               <button 
                onClick={() => setShowAddModal(true)}
                className="bg-white/5 hover:bg-white/10 text-white px-5 py-2.5 rounded-2xl border border-white/10 text-[10px] font-black uppercase tracking-widest flex items-center gap-2 transition-all active:scale-95"
               >
                 <i className="fas fa-plus text-blue-500"></i>
                 Add Asset
               </button>
               <div className="bg-slate-950 px-4 py-2.5 rounded-2xl border border-slate-800 flex items-center gap-2">
                 <span className={`${isCoolingDown ? 'text-amber-400' : 'text-emerald-400'} text-[10px] font-black uppercase tracking-widest flex items-center gap-1.5`}>
                   <span className={`w-1.5 h-1.5 ${isCoolingDown ? 'bg-amber-500' : 'bg-emerald-500'} rounded-full animate-pulse`}></span>
                   {isCoolingDown ? 'Sync Paused' : 'Live Quotes'}
                 </span>
               </div>
            </div>
          </div>

          <div className="bg-blue-600 rounded-[32px] p-8 text-white relative overflow-hidden group shadow-2xl shadow-blue-600/20">
            <div className="absolute bottom-0 right-0 translate-y-1/4 translate-x-1/4 opacity-20 group-hover:scale-110 transition-transform duration-700">
               <i className="fas fa-rocket text-9xl"></i>
            </div>
            <h3 className="text-[10px] font-black uppercase tracking-widest mb-4 opacity-80">Bulk Import</h3>
            <button 
              onClick={() => setShowSmartImport(true)}
              className="w-full bg-white text-blue-600 py-4 rounded-2xl font-black uppercase tracking-widest text-xs shadow-xl active:scale-95 transition-all"
            >
              <i className="fas fa-file-import mr-2"></i>
              Smart Paste
            </button>
            <p className="mt-4 text-[10px] opacity-70 font-medium leading-relaxed">
              Paste your brokerage statement and let the AI extract positions.
            </p>
          </div>
        </div>

        {/* Portfolio Section */}
        <section className="space-y-6">
          <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
            <div className="flex items-center gap-4">
              <h2 className="text-xl font-black uppercase tracking-tighter italic border-l-4 border-blue-500 pl-4">Your <span className="text-blue-500">Holdings</span></h2>
              <button 
                onClick={() => setIsWatchMode(!isWatchMode)}
                className={`flex px-3 py-1.5 rounded-full text-[9px] font-black uppercase tracking-widest transition-all items-center gap-2 border ${
                  isWatchMode ? 'bg-emerald-500/10 border-emerald-500/50 text-emerald-400' : 'bg-slate-800 border-slate-700 text-slate-400'
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${isWatchMode ? 'bg-emerald-500 animate-pulse' : 'bg-slate-600'}`}></span>
                {isWatchMode ? 'Watch Mode ON' : 'Watch Mode OFF'}
              </button>
            </div>
            
            {/* Sorting UI Controls */}
            {portfolio.length > 0 && (
              <div className="flex items-center gap-2 bg-slate-900 border border-slate-800 p-2 rounded-2xl self-start md:self-auto shadow-inner">
                <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest px-2">Sort By</span>
                <select 
                  value={sortKey}
                  onChange={(e) => setSortKey(e.target.value as SortKey)}
                  className="bg-slate-950 border border-slate-800 text-[10px] font-black uppercase text-blue-400 px-3 py-1.5 rounded-xl outline-none focus:ring-1 focus:ring-blue-500/50 appearance-none cursor-pointer pr-8 relative bg-[url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20width%3D%228%22%20height%3D%226%22%20viewBox%3D%220%200%208%206%22%20fill%3D%22none%22%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%3E%3Cpath%20d%3D%22M1%201.5L4%204.5L7%201.5%22%20stroke%3D%22%2364748b%22%20stroke-width%3D%221.5%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22/%3E%3C/svg%3E')] bg-[length:10px_10px] bg-[right_10px_center] bg-no-repeat"
                >
                  <option value="symbol">Ticker</option>
                  <option value="price">Price</option>
                  <option value="changePercent">Change %</option>
                  <option value="value">Net Value</option>
                  <option value="shares">Shares</option>
                </select>
                <button 
                  onClick={() => setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc')}
                  className="w-8 h-8 flex items-center justify-center bg-slate-950 border border-slate-800 rounded-xl text-slate-400 hover:text-blue-400 transition-colors"
                  title={sortOrder === 'asc' ? 'Ascending' : 'Descending'}
                >
                  <i className={`fas fa-arrow-${sortOrder === 'asc' ? 'up-short-wide' : 'down-wide-short'} text-xs`}></i>
                </button>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {portfolio.length === 0 ? (
              <div className="col-span-full py-20 text-center border-2 border-dashed border-slate-800 rounded-[40px]">
                <p className="text-slate-600 font-black uppercase tracking-widest text-xs">Your portfolio is empty. Add a stock to begin.</p>
              </div>
            ) : (
              sortedPortfolio.map(stock => {
                const pred = getPrediction(stock.symbol);
                return (
                  <StockCard 
                    key={stock.symbol} 
                    stock={stock} 
                    prediction={pred}
                    onRemove={() => {
                      setPortfolio(p => p.filter(s => s.symbol !== stock.symbol));
                      setToast(`Removed ${stock.symbol} from portfolio`);
                    }}
                    onUpdateShares={(newAmount) => handleUpdateShares(stock.symbol, newAmount)}
                  />
                );
              })
            )}
          </div>
        </section>

        {analysis?.insights && analysis.insights.length > 0 && (
          <section className="space-y-6">
            <h2 className="text-xl font-black uppercase tracking-tighter italic border-l-4 border-amber-500 pl-4">Global Market <span className="text-amber-500">Intel</span></h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {analysis.insights.map((insight, idx) => (
                <MarketInsightCard key={idx} insight={insight} />
              ))}
            </div>
          </section>
        )}

        {analysis?.recommendations && (
          <section className="bg-slate-900 rounded-[40px] border border-slate-800 p-8 sm:p-12 shadow-2xl relative overflow-hidden">
             <div className="absolute top-0 right-0 w-64 h-64 bg-blue-600/10 blur-[100px] -mr-32 -mt-32 rounded-full"></div>
             <div className="relative z-10">
               <div className="flex items-center gap-4 mb-10">
                 <div className="w-14 h-14 bg-blue-600 rounded-2xl flex items-center justify-center text-2xl shadow-xl shadow-blue-600/20">
                   <i className="fas fa-lightbulb text-white"></i>
                 </div>
                 <div>
                   <h2 className="text-2xl font-black uppercase tracking-tighter">AI Buy <span className="text-blue-500">Suggestions</span></h2>
                   <p className="text-slate-500 text-xs font-bold uppercase tracking-widest">Opportunities detected via search — Use Caution</p>
                 </div>
               </div>

               <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                 {analysis.recommendations.map((rec, i) => (
                   <div key={i} className="bg-slate-950 p-8 rounded-[32px] border border-slate-800 hover:border-blue-500/50 transition-all group">
                     <span className="text-[9px] font-black text-blue-500 bg-blue-500/10 px-3 py-1.5 rounded-full mb-6 inline-block uppercase tracking-widest">{rec.sector}</span>
                     <h4 className="text-4xl font-black mb-1 group-hover:text-blue-400 transition-colors">{rec.symbol}</h4>
                     <p className="text-slate-400 text-xs font-bold mb-4 uppercase">{rec.name}</p>
                     <p className="text-slate-500 text-[11px] leading-relaxed italic mb-8 border-l-2 border-slate-800 pl-4">"{rec.reason}"</p>
                     <button 
                        onClick={() => {
                          handleAddStock(rec.symbol, rec.name, 0, 0);
                          setToast(`Added ${rec.symbol} to your portfolio`);
                          window.scrollTo({ top: 0, behavior: 'smooth' });
                        }}
                        className="text-[10px] font-black uppercase tracking-widest text-blue-400 flex items-center gap-2 group-hover:translate-x-2 transition-transform"
                      >
                       Add to Watchlist <i className="fas fa-chevron-right text-[8px]"></i>
                     </button>
                   </div>
                 ))}
               </div>
             </div>
          </section>
        )}

        {/* Modals */}
        {showAddModal && (
          <AddStockModal 
            onClose={() => setShowAddModal(false)}
            onAdd={(symbol, name, shares, avgCost) => {
              handleAddStock(symbol, name, shares, avgCost);
              setToast(`Added ${symbol} to your portfolio`);
            }}
            isLoading={isLoading}
          />
        )}

        {showSmartImport && (
          <div className="fixed inset-0 z-[100] bg-slate-950/90 backdrop-blur-xl flex items-center justify-center p-4">
            <div className="bg-slate-900 border border-slate-800 w-full max-w-xl rounded-[40px] p-8 sm:p-10 shadow-2xl">
              <div className="flex justify-between items-center mb-8">
                <h2 className="text-2xl font-black uppercase tracking-tighter italic">Smart <span className="text-blue-500">Import</span></h2>
                <button onClick={() => setShowSmartImport(false)} className="text-slate-500 hover:text-white transition-colors text-2xl">
                  <i className="fas fa-times"></i>
                </button>
              </div>
              <textarea 
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                placeholder="AAPL 15 shares at 185.20..."
                className="w-full h-48 bg-slate-950 border border-slate-800 rounded-3xl p-6 text-sm font-mono text-blue-400 outline-none focus:ring-2 focus:ring-blue-500/50 resize-none mb-6"
              />
              <button 
                onClick={handleSmartImport}
                disabled={!importText.trim() || isLoading || isCoolingDown}
                className="w-full bg-blue-600 hover:bg-blue-500 py-5 rounded-2xl font-black uppercase tracking-widest text-xs shadow-xl active:scale-95 transition-all disabled:opacity-50"
              >
                {isLoading ? 'Processing...' : 'Extract Positions'}
              </button>
            </div>
          </div>
        )}
      </main>

      {/* Global Toast Notification */}
      {toast && (
        <div className="fixed bottom-[calc(3rem+var(--ad-height,0px))] left-1/2 -translate-x-1/2 z-[200] bg-blue-600 text-white px-6 py-3.5 rounded-full font-black uppercase tracking-[0.1em] text-[10px] shadow-2xl shadow-blue-600/40 animate-in slide-in-from-bottom-8 duration-300 flex items-center gap-3">
          <i className="fas fa-check-circle"></i>
          {toast}
        </div>
      )}

      <footer className="max-w-7xl mx-auto p-12 pb-[calc(48px+env(safe-area-inset-bottom,0px))] text-center border-t border-slate-900 w-full mt-auto">
        <div className="space-y-4">
          <p className="text-slate-500 text-[9px] font-bold uppercase tracking-[0.3em] max-w-2xl mx-auto leading-loose opacity-60">
            DISCLAIMER: WEALTHSENSEAI IS AN EXPERIMENTAL AI TOOL. NO DATA PROVIDED CONSTITUTES INVESTMENT ADVICE. TRADING STOCKS INVOLVES RISK OF TOTAL CAPITAL LOSS. WE ARE NOT RESPONSIBLE FOR DAMAGES RESULTING FROM AI ERROR OR DATA INACCURACY.
          </p>
          <p className="text-slate-700 text-[10px] font-black uppercase tracking-[0.2em] max-w-lg mx-auto leading-loose">
            WealthSenseAI • Pro/Flash Tiered Grounding • Safe Area Optimized
          </p>
        </div>
      </footer>
    </div>
  );
};

export default App;
