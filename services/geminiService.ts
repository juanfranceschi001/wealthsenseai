
import { Stock, AIAnalysisResult } from "../types";

// This is a placeholder for the actual Type enum from "@google/genai"
// We define it here to avoid keeping the "@google/genai" dependency on the client-side.
const Type = {
    STRING: 'STRING',
    NUMBER: 'NUMBER',
    OBJECT: 'OBJECT',
    ARRAY: 'ARRAY',
};

const callAIGateway = async (model: string, contents: any, config: any = {}) => {
    // This URL points to the Vercel serverless function.
    // Vercel automatically handles routing for local development and production.
    const API_GATEWAY_URL = '/api/gemini';

    try {
        const response = await fetch(API_GATEWAY_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, contents, config }),
        });

        if (!response.ok) {
            if (response.status === 429) {
                throw new RateLimitError("AI Quota reached. Cooling down...");
            }
            const errorBody = await response.json().catch(() => ({ error: 'Proxy request failed with status ' + response.status }));
            throw new Error(errorBody.error || 'Failed to fetch from AI gateway');
        }

        const result = await response.json();
        return { text: () => result.text };
    } catch (error) {
        if (error instanceof RateLimitError) throw error;
        console.error("Error calling AI Gateway:", error);
        throw new Error("Could not connect to the AI service. Please check your network connection.");
    }
};


/**
 * Custom error to handle rate limiting specifically
 */
export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

const checkResponseForErrors = (error: any) => {
  const msg = error?.message || "";
  if (msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED") || msg.includes("quota")) {
    throw new RateLimitError("AI Quota reached. Cooling down...");
  }
  throw error;
};

export const resolveTicker = async (input: string): Promise<{ symbol: string; name: string }> => {
  const prompt = `Identify the official stock ticker symbol and company name for: \"${input}\". Return JSON with keys: symbol, name. Example: {\"symbol\": \"AAPL\", \"name\": \"Apple Inc.\"}`;

  try {
    const response = await callAIGateway("gemini-3-flash-preview", prompt, {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            symbol: { type: Type.STRING },
            name: { type: Type.STRING }
          },
          required: ['symbol', 'name']
        }
      });
    return JSON.parse(response.text() || '{\"symbol\": \"???\", \"name\": \"Unknown\"}');
  } catch (error) {
    return checkResponseForErrors(error);
  }
};

export const parsePortfolioFromText = async (text: string): Promise<Partial<Stock>[]> => {
  const prompt = `Extract stock portfolio data. Identify Symbol, Shares, and Avg Cost. Text: \"${text}\". Return JSON array of objects with keys: symbol, shares, avgCost.`;

  try {
    const response = await callAIGateway("gemini-3-flash-preview", prompt, {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              symbol: { type: Type.STRING },
              shares: { type: Type.NUMBER },
              avgCost: { type: Type.NUMBER }
            },
            required: ['symbol']
          }
        }
      });
    return JSON.parse(response.text() || '[]');
  } catch (error) {
    return checkResponseForErrors(error);
  }
};

export const syncStockPrices = async (symbols: string[]): Promise<Record<string, { price: number, change: number, changePercent: number }>> => {
  const prompt = `Find the CURRENT real-time stock price and daily % change for: ${symbols.join(', ')}. Return ONLY a JSON array of objects with keys: symbol, price, change, changePercent. Use search for accuracy.`;

  try {
    const response = await callAIGateway("gemini-3-flash-preview", prompt, {
        tools: [{ googleSearch: {} }],
      });

    const text = response.text() || '';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    const data = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
    
    const results: Record<string, { price: number, change: number, changePercent: number }> = {};
    data.forEach((item: any) => {
      if (item.symbol) {
        results[item.symbol.toUpperCase()] = {
          price: Number(item.price) || 0,
          change: Number(item.change) || 0,
          changePercent: Number(item.changePercent) || 0
        };
      }
    });
    return results;
  } catch (error) {
    return checkResponseForErrors(error);
  }
};

export const analyzePortfolio = async (portfolio: Stock[]): Promise<AIAnalysisResult> => {
  const context = portfolio.map(s => `${s.symbol}: $${s.price}, Cost: $${s.avgCost}, Shares: ${s.shares}`).join('\n');

  const prompt = `
    ACT AS WealthSenseAI, A SENIOR TRADING INTELLIGENCE. 
    1. Analyze this portfolio:
    ${context}
    2. Predict BUY/SELL/HOLD for each ticker with reasoning and a 12-month TARGET PRICE.
    3. Suggest 3 NEW high-growth stocks to buy right now based on today's news.
    4. Provide a market summary.
    
    Return the result as a raw JSON object:
    {
      \"predictions\": [{\"symbol\": \"TICKER\", \"action\": \"BUY|SELL|HOLD\", \"confidence\": 0-1, \"reasoning\": \"...\", \"targetPrice\": 0.0}],
      \"insights\": [{\"title\": \"...\", \"summary\": \"...\", \"sentiment\": \"BULLISH|BEARISH|NEUTRAL\", \"source\": \"...\", \"url\": \"...\"}],
      \"recommendations\": [{\"symbol\": \"...\", \"name\": \"...\", \"sector\": \"...\", \"reason\": \"...\"}],
      \"summary\": \"...\"
    }
  `;

  try {
    const response = await callAIGateway("gemini-3-pro-preview", prompt, {
        tools: [{ googleSearch: {} }],
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            predictions: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  symbol: { type: Type.STRING },
                  action: { type: Type.STRING },
                  confidence: { type: Type.NUMBER },
                  reasoning: { type: Type.STRING },
                  targetPrice: { type: Type.NUMBER }
                },
                required: ['symbol', 'action', 'reasoning', 'targetPrice']
              }
            },
            insights: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING },
                  summary: { type: String },
                  sentiment: { type: Type.STRING },
                  source: { type: Type.STRING },
                  url: { type: String }
                }
              }
            },
            recommendations: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  symbol: { type: Type.STRING },
                  name: { type: Type.STRING },
                  sector: { type: Type.STRING },
                  reason: { type: Type.STRING }
                }
              }
            },
            summary: { type: Type.STRING }
          },
          required: ['predictions', 'insights', 'recommendations', 'summary']
        }
      });

    return JSON.parse(response.text() || '{}');
  } catch (error) {
    return checkResponseForErrors(error);
  }
};
