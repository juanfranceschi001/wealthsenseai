
import React, { useEffect, useState, useRef } from 'react';
import { Stock, Prediction } from '../types';

interface StockCardProps {
  stock: Stock;
  prediction?: Prediction;
  onRemove?: () => void;
  onUpdateShares?: (newAmount: number) => void;
}

export const StockCard: React.FC<StockCardProps> = ({ stock, prediction, onRemove, onUpdateShares }) => {
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(stock.shares.toString());
  const prevPrice = useRef(stock.price);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (stock.price > prevPrice.current) {
      setFlash('up');
      setTimeout(() => setFlash(null), 1000);
    } else if (stock.price < prevPrice.current) {
      setFlash('down');
      setTimeout(() => setFlash(null), 1000);
    }
    prevPrice.current = stock.price;
  }, [stock.price]);

  // Sync edit value when stock shares change from outside
  useEffect(() => {
    if (!isEditing) {
      setEditValue(stock.shares.toString());
    }
  }, [stock.shares, isEditing]);

  const isPositive = stock.change >= 0;
  
  const actionColors = {
    BUY: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    SELL: 'bg-rose-500/10 text-rose-400 border-rose-500/20',
    HOLD: 'bg-amber-500/10 text-amber-400 border-amber-500/20'
  };

  const handleRemove = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onRemove) onRemove();
  };

  const handleUpdate = (delta: number) => {
    if (onUpdateShares) {
      onUpdateShares(stock.shares + delta);
    }
  };

  const saveEdit = () => {
    const val = parseFloat(editValue);
    if (!isNaN(val) && onUpdateShares) {
      onUpdateShares(val);
    }
    setIsEditing(false);
  };

  const cancelEdit = () => {
    setEditValue(stock.shares.toString());
    setIsEditing(false);
  };

  return (
    <div className={`bg-slate-800 border border-slate-700 rounded-2xl p-4 sm:p-5 hover:border-blue-500 transition-all shadow-lg group relative overflow-hidden active:bg-slate-700/50 ${
      flash === 'up' ? 'ring-2 ring-emerald-500/50' : flash === 'down' ? 'ring-2 ring-rose-500/50' : ''
    }`}>
      {/* Quick Remove Button */}
      {onRemove && (
        <button 
          onClick={handleRemove}
          className="absolute top-3 right-3 w-9 h-9 sm:w-8 sm:h-8 bg-slate-900/90 backdrop-blur rounded-xl border border-slate-700 flex items-center justify-center text-slate-400 hover:text-rose-500 hover:border-rose-500/50 transition-all z-20 sm:opacity-0 sm:group-hover:opacity-100"
          aria-label="Remove asset"
        >
          <i className="fas fa-trash-alt text-sm sm:text-xs"></i>
        </button>
      )}

      <div className="flex justify-between items-start mb-4 pr-10 sm:pr-0">
        <div className="min-w-0">
          <div className="flex items-center space-x-2">
             <h3 className="text-lg sm:text-xl font-black group-hover:text-blue-400 transition-colors uppercase truncate">{stock.symbol}</h3>
             <div className="flex items-center space-x-1 px-1.5 py-0.5 bg-slate-950 rounded border border-slate-800 shrink-0">
                <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse"></span>
                <span className="text-[8px] font-black text-slate-500 uppercase tracking-tighter">Live</span>
             </div>
          </div>
          <p className="text-slate-400 text-[10px] sm:text-xs truncate font-medium uppercase tracking-tight">{stock.name}</p>
        </div>
      </div>

      <div className="flex items-end justify-between mb-4">
        <div className="bg-slate-950/40 px-3 py-2 rounded-xl border border-slate-700/50">
          <p className="text-[9px] text-slate-500 font-black uppercase tracking-widest mb-0.5">Price</p>
          <p className={`text-xl font-mono font-black transition-colors duration-300 ${
            flash === 'up' ? 'text-emerald-400' : flash === 'down' ? 'text-rose-400' : 'text-white'
          }`}>
            ${stock.price.toFixed(2)}
          </p>
        </div>
        <div className="text-right pb-1">
          <p className={`text-xs sm:text-sm font-black ${isPositive ? 'text-emerald-400' : 'text-rose-400'}`}>
            <i className={`fas fa-caret-${isPositive ? 'up' : 'down'} mr-1`}></i>
            {Math.abs(stock.changePercent).toFixed(2)}%
          </p>
          <p className="text-[10px] text-slate-500 font-bold uppercase">24H</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 mb-4">
        <div className="bg-slate-900/50 p-2.5 rounded-xl border border-slate-700/30 flex flex-col justify-between">
          <div className="flex justify-between items-start mb-1">
            <p className="text-[8px] text-slate-500 uppercase font-black tracking-widest">Holding</p>
            {!isEditing && (
              <button 
                onClick={() => setIsEditing(true)}
                className="text-slate-600 hover:text-blue-400 transition-colors"
              >
                <i className="fas fa-edit text-[8px]"></i>
              </button>
            )}
          </div>
          
          <div className="flex items-center gap-2">
            {isEditing ? (
              <div className="flex items-center gap-1 w-full">
                <input 
                  ref={inputRef}
                  autoFocus
                  type="number"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveEdit();
                    if (e.key === 'Escape') cancelEdit();
                  }}
                  className="bg-slate-950 border border-blue-500/50 rounded-lg flex-grow text-[10px] font-black px-1 py-0.5 text-white outline-none min-w-0"
                />
                <div className="flex items-center gap-0.5 shrink-0">
                  <button 
                    onClick={saveEdit}
                    className="w-4 h-4 bg-emerald-500/20 text-emerald-400 rounded border border-emerald-500/30 flex items-center justify-center hover:bg-emerald-500/30 transition-colors"
                    title="Confirm changes"
                  >
                    <i className="fas fa-check text-[7px]"></i>
                  </button>
                  <button 
                    onClick={cancelEdit}
                    className="w-4 h-4 bg-slate-800 text-slate-400 rounded border border-slate-700 flex items-center justify-center hover:bg-slate-700 transition-colors"
                    title="Cancel"
                  >
                    <i className="fas fa-times text-[7px]"></i>
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between w-full">
                <p className="font-black text-xs text-slate-200">
                  {stock.shares.toLocaleString()} <span className="text-slate-500 font-normal">Units</span>
                </p>
                <div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button 
                    onClick={() => handleUpdate(-1)}
                    className="w-5 h-5 bg-slate-800 rounded-md border border-slate-700 flex items-center justify-center text-rose-500 hover:bg-rose-500/10 active:scale-90 transition-all"
                  >
                    <i className="fas fa-minus text-[8px]"></i>
                  </button>
                  <button 
                    onClick={() => handleUpdate(1)}
                    className="w-5 h-5 bg-slate-800 rounded-md border border-slate-700 flex items-center justify-center text-emerald-500 hover:bg-emerald-500/10 active:scale-90 transition-all"
                  >
                    <i className="fas fa-plus text-[8px]"></i>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
        
        <div className="bg-slate-900/50 p-2.5 rounded-xl border border-slate-700/30">
          <p className="text-[8px] text-slate-500 uppercase font-black tracking-widest mb-1">Value</p>
          <p className="font-black text-xs text-slate-200">${(stock.shares * stock.price).toLocaleString(undefined, { maximumFractionDigits: 0 })}</p>
        </div>
      </div>

      {prediction && (
        <div className={`mt-2 p-3 rounded-xl border ${actionColors[prediction.action]}`}>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[9px] font-black uppercase tracking-widest opacity-80">Signal</span>
            <div className="flex items-center gap-2">
               {prediction.targetPrice && prediction.targetPrice > 0 && (
                 <span className="text-[9px] font-black px-2 py-0.5 rounded-lg bg-black/20 text-white">
                   Target: ${prediction.targetPrice.toFixed(0)}
                 </span>
               )}
               <span className="text-[10px] font-black px-2 py-0.5 rounded-lg bg-black/20">{prediction.action}</span>
            </div>
          </div>
          <p className="text-[10px] sm:text-[11px] leading-snug line-clamp-2 font-medium opacity-90">
            {prediction.reasoning}
          </p>
        </div>
      )}
    </div>
  );
};