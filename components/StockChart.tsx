
import React, { useMemo } from 'react';
import { 
  AreaChart, Area, XAxis, YAxis, CartesianGrid, 
  Tooltip, ResponsiveContainer 
} from 'recharts';

interface StockChartProps {
  symbol: string;
  price: number;
}

export const StockChart: React.FC<StockChartProps> = ({ symbol, price }) => {
  const data = useMemo(() => {
    const points = [];
    const basePrice = price * 0.98;
    const times = ['09:30', '10:30', '11:30', '12:30', '13:30', '14:30', '15:30', '16:00'];
    
    let current = basePrice;
    for (let i = 0; i < times.length; i++) {
      if (i === times.length - 1) {
        points.push({ time: times[i], price: price });
      } else {
        const volatility = (Math.random() - 0.4) * (price * 0.01);
        current += volatility;
        points.push({ time: times[i], price: current });
      }
    }
    return points;
  }, [symbol, price]);

  const isUp = price > data[0].price;

  return (
    <div className="h-56 sm:h-64 w-full bg-slate-900/50 rounded-2xl p-4 sm:p-5 border border-slate-800 shadow-inner group">
      <div className="flex justify-between items-center mb-4">
        <div>
          <h3 className="text-[10px] sm:text-xs font-black text-slate-500 uppercase tracking-widest">{symbol} Intraday</h3>
          <p className="text-[8px] sm:text-[10px] text-slate-600 font-mono font-bold">Simulated Depth</p>
        </div>
        <div className="text-right">
          <span className={`font-mono text-xl sm:text-2xl font-black ${isUp ? 'text-emerald-400' : 'text-rose-400'}`}>
            ${price.toFixed(2)}
          </span>
        </div>
      </div>
      <div className="h-[calc(100%-3rem)] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
            <defs>
              <linearGradient id="colorPrice" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={isUp ? "#10b981" : "#f43f5e"} stopOpacity={0.2}/>
                <stop offset="95%" stopColor={isUp ? "#10b981" : "#f43f5e"} stopOpacity={0}/>
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#1e293b" />
            <XAxis dataKey="time" stroke="#475569" fontSize={9} tickLine={false} axisLine={false} tick={{dy: 10}} />
            <YAxis hide domain={['dataMin - 1', 'dataMax + 1']} />
            <Tooltip 
              contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: '12px', fontSize: '10px' }}
              itemStyle={{ color: isUp ? '#10b981' : '#f43f5e', fontWeight: 'bold' }}
              formatter={(val: number) => [`$${val.toFixed(2)}`, 'Price']}
            />
            <Area 
              type="monotone" 
              dataKey="price" 
              stroke={isUp ? "#10b981" : "#f43f5e"} 
              fillOpacity={1} 
              fill="url(#colorPrice)" 
              strokeWidth={3}
              animationDuration={1500}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};
