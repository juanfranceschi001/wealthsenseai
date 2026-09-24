
import React, { useState } from 'react';
import { resolveTicker, RateLimitError } from '../services/geminiService';

interface AddStockModalProps {
  onClose: () => void;
  onAdd: (symbol: string, name: string, shares: number, avgCost: number) => void;
  isLoading?: boolean;
}

export const AddStockModal: React.FC<AddStockModalProps> = ({ onClose, onAdd, isLoading: parentLoading }) => {
  const [query, setQuery] = useState('');
  const [shares, setShares] = useState('');
  const [avgCost, setAvgCost] = useState('');
  const [isResolving, setIsResolving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query || !shares) return;

    setIsResolving(true);
    setError(null);
    try {
      const { symbol, name } = await resolveTicker(query);
      if (!symbol || symbol === '???') {
        setError("Could not find that stock. Please check the name or symbol.");
        return;
      }
      onAdd(symbol, name, parseFloat(shares), parseFloat(avgCost) || 0);
      onClose();
    } catch (err) {
      setError(err instanceof RateLimitError
        ? "Too many requests. Please wait a minute and try again."
        : (err as Error).message || "Could not reach the AI service. Please try again later.");
    } finally {
      setIsResolving(false);
    }
  };

  const isLoading = parentLoading || isResolving;

  return (
    <div className="fixed inset-0 z-[100] bg-slate-950/90 backdrop-blur-xl flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-800 w-full max-w-md rounded-[40px] p-8 sm:p-10 shadow-2xl animate-in fade-in zoom-in duration-300">
        <div className="flex justify-between items-center mb-8">
          <h2 className="text-2xl font-black uppercase tracking-tighter italic">Add <span className="text-blue-500">Asset</span></h2>
          <button onClick={onClose} className="text-slate-500 hover:text-white transition-colors text-2xl">
            <i className="fas fa-times"></i>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-2">Ticker or Company Name</label>
            <input 
              autoFocus
              required
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="e.g. Tesla or TSLA"
              className="w-full bg-slate-950 border border-slate-800 rounded-2xl p-4 text-sm text-white outline-none focus:ring-2 focus:ring-blue-500/50 transition-all placeholder:text-slate-700"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-2">Shares Owned</label>
              <input 
                required
                type="number"
                step="any"
                value={shares}
                onChange={(e) => setShares(e.target.value)}
                placeholder="10"
                className="w-full bg-slate-950 border border-slate-800 rounded-2xl p-4 text-sm text-white outline-none focus:ring-2 focus:ring-blue-500/50 transition-all placeholder:text-slate-700"
              />
            </div>
            <div>
              <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-2">Avg Cost (Opt)</label>
              <input 
                type="number"
                step="any"
                value={avgCost}
                onChange={(e) => setAvgCost(e.target.value)}
                placeholder="$150.00"
                className="w-full bg-slate-950 border border-slate-800 rounded-2xl p-4 text-sm text-white outline-none focus:ring-2 focus:ring-blue-500/50 transition-all placeholder:text-slate-700"
              />
            </div>
          </div>

          {error && (
            <p className="text-xs font-bold text-rose-400">{error}</p>
          )}

          <button 
            type="submit"
            disabled={isLoading}
            className="w-full bg-blue-600 hover:bg-blue-500 py-5 rounded-2xl font-black uppercase tracking-widest text-xs shadow-xl active:scale-95 transition-all disabled:opacity-50 flex items-center justify-center gap-3"
          >
            {isLoading ? (
              <><i className="fas fa-spinner fa-spin"></i> Resolving...</>
            ) : (
              <><i className="fas fa-plus-circle"></i> Add to Portfolio</>
            )}
          </button>
        </form>
      </div>
    </div>
  );
};
