
export interface Stock {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  shares: number;
  avgCost: number;
}

export interface Prediction {
  symbol: string;
  action: 'BUY' | 'SELL' | 'HOLD';
  confidence?: number;
  reasoning: string;
  targetPrice?: number;
}

export interface MarketInsight {
  title: string;
  summary: string;
  sentiment: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  source: string;
  url: string;
}

export interface Recommendation {
  symbol: string;
  name: string;
  sector: string;
  reason: string;
}

export interface AIAnalysisResult {
  predictions: Prediction[];
  insights: MarketInsight[];
  recommendations: Recommendation[];
  summary: string;
}