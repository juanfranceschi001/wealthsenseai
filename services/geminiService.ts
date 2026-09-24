
import { Stock, AIAnalysisResult } from "../types";

// Web builds hosted on Vercel call the API on the same origin, so this stays
// empty. The Android app is served from https://localhost inside the WebView,
// so it must be built with VITE_API_BASE_URL set to the deployed Vercel URL.
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');

/**
 * Custom error to handle rate limiting specifically
 */
export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

const callAIGateway = async <T>(action: string, payload: Record<string, unknown>): Promise<T> => {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/api/gemini`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...payload }),
    });
  } catch (error) {
    console.error("Error calling AI Gateway:", error);
    throw new Error("Could not connect to the AI service. Please check your network connection.");
  }

  if (response.status === 429) {
    throw new RateLimitError("AI Quota reached. Cooling down...");
  }

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error || 'AI request failed with status ' + response.status);
  }
  if (!body || !('data' in body)) {
    throw new Error("Could not reach the AI service. Please try again later.");
  }
  return body.data as T;
};

export const resolveTicker = (input: string): Promise<{ symbol: string; name: string }> =>
  callAIGateway('resolveTicker', { input });

export const parsePortfolioFromText = (text: string): Promise<Partial<Stock>[]> =>
  callAIGateway('parsePortfolio', { text });

export const syncStockPrices = (symbols: string[]): Promise<Record<string, { price: number, change: number, changePercent: number }>> =>
  callAIGateway('syncPrices', { symbols });

export const analyzePortfolio = (portfolio: Stock[]): Promise<AIAnalysisResult> =>
  callAIGateway('analyzePortfolio', {
    portfolio: portfolio.map(({ symbol, price, avgCost, shares }) => ({ symbol, price, avgCost, shares })),
  });
