
import React from 'react';
import { MarketInsight } from '../types';

interface MarketInsightCardProps {
  insight: MarketInsight;
}

export const MarketInsightCard: React.FC<MarketInsightCardProps> = ({ insight }) => {
  const sentimentConfig = {
    BULLISH: {
      color: 'text-emerald-400',
      bg: 'bg-emerald-500/10',
      border: 'border-emerald-500/20',
      icon: 'fa-arrow-trend-up'
    },
    BEARISH: {
      color: 'text-rose-400',
      bg: 'bg-rose-500/10',
      border: 'border-rose-500/20',
      icon: 'fa-arrow-trend-down'
    },
    NEUTRAL: {
      color: 'text-amber-400',
      bg: 'bg-amber-500/10',
      border: 'border-amber-500/20',
      icon: 'fa-arrows-left-right'
    }
  };

  const config = sentimentConfig[insight.sentiment] || sentimentConfig.NEUTRAL;

  return (
    <div className={`bg-slate-900 border ${config.border} rounded-3xl p-6 hover:shadow-xl hover:shadow-blue-500/5 transition-all group flex flex-col h-full`}>
      <div className="flex justify-between items-start mb-4">
        <span className={`text-[9px] font-black uppercase tracking-[0.2em] px-3 py-1.5 rounded-full ${config.bg} ${config.color} flex items-center gap-2`}>
          <i className={`fas ${config.icon}`}></i>
          {insight.sentiment}
        </span>
        <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest bg-slate-800 px-2 py-1 rounded">
          {insight.source}
        </span>
      </div>
      
      <h3 className="text-lg font-black text-white mb-3 leading-tight group-hover:text-blue-400 transition-colors">
        {insight.title}
      </h3>
      
      <p className="text-slate-400 text-xs leading-relaxed mb-6 flex-grow">
        {insight.summary}
      </p>

      {insight.url && (
        <a 
          href={insight.url} 
          target="_blank" 
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-slate-500 hover:text-white transition-colors mt-auto"
        >
          View Full Brief <i className="fas fa-external-link-alt text-[8px]"></i>
        </a>
      )}
    </div>
  );
};
