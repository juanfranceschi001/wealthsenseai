const { GoogleGenAI, Type } = require('@google/genai');

// Vercel serverless function, served at YOUR_VERCEL_URL/api/gemini.
//
// The client only sends an `action` name and that action's data. Models,
// prompts and generation settings are fixed here so the endpoint can't be
// used as a general-purpose Gemini proxy on our API key.

// Everything runs on the Gemini free tier: Flash only, and no Google Search
// grounding (both Pro and Search have zero free quota). Instead of searching,
// the model is handed real market data from the proxy below.
//
// Free-tier capacity per model comes and goes ("high demand" 503s), so each
// request walks this list until one model answers.
const MODELS = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3-flash-preview', 'gemini-3.5-flash-lite'];
const MODEL_TIMEOUT_MS = 25_000;

// Quotes, fundamentals and company news come from the Cloudflare Worker that
// fronts Finnhub for Blue Chip (see that repo's worker/README.md). It holds the
// Finnhub key and caches responses across all users, so this data is free.
const MARKET_DATA_PROXY_URL = (process.env.MARKET_DATA_PROXY_URL || 'https://bluechip-proxy.juan-franceschi5.workers.dev').replace(/\/$/, '');

// Caps proxy fan-out for large portfolios during analysis.
const MAX_ANALYZED_SYMBOLS = 15;
const NEWS_PER_SYMBOL = 3;

// Origins always allowed besides same-origin requests: the Capacitor Android
// WebView (https://localhost) and local dev servers. Add your own domains via
// the ALLOWED_ORIGINS env var (comma-separated).
const DEFAULT_ORIGINS = ['https://localhost', 'capacitor://localhost', 'http://localhost', 'http://localhost:3000', 'http://localhost:5173'];
const allowedOrigins = new Set([
    ...DEFAULT_ORIGINS,
    ...(process.env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean),
]);

// Best-effort per-IP rate limits. State lives in the function instance's
// memory, so it resets on cold starts and isn't shared across instances. The
// key's free-tier quota (no billing enabled) is the hard backstop.
const RATE_LIMITS = {
    resolveTicker: { max: 20, windowMs: 60_000 },
    parsePortfolio: { max: 5, windowMs: 60_000 },
    syncPrices: { max: 6, windowMs: 60_000 },
    analyzePortfolio: { max: 3, windowMs: 60_000 },
};
const hits = new Map();

const isRateLimited = (ip, action) => {
    const { max, windowMs } = RATE_LIMITS[action];
    const key = `${ip}:${action}`;
    const now = Date.now();
    const recent = (hits.get(key) || []).filter(t => now - t < windowMs);
    if (recent.length >= max) {
        hits.set(key, recent);
        return true;
    }
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 10_000) hits.clear();
    return false;
};

class BadRequest extends Error {}
class NotConfigured extends Error {}
class InvalidModelOutput extends Error {}

const getAI = () => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new NotConfigured('GEMINI_API_KEY is not set');
    return new GoogleGenAI({ apiKey });
};

// Errors that mean "this model can't serve us right now" rather than "the
// request is bad": overloaded, out of quota, retired, or too slow.
const isModelUnavailable = (error) =>
    [404, 429, 500, 503, 504].includes(error?.status) || error?.name === 'AbortError' || error?.name === 'TimeoutError';

// Returns the response text from the first available model.
const generate = async ({ contents, config }) => {
    const ai = getAI();
    let lastError;
    for (const model of MODELS) {
        try {
            const response = await ai.models.generateContent({
                model,
                contents,
                config: {
                    // Caps runaway output (lite models occasionally loop on a digit).
                    maxOutputTokens: 4096,
                    ...config,
                    abortSignal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
                },
            });
            // A cut-off or malformed JSON answer counts as a failed model, not a result.
            if (config.responseMimeType === 'application/json' && parseJson(response.text, undefined) === undefined) {
                throw new InvalidModelOutput(`${model} returned invalid JSON`);
            }
            return response.text;
        } catch (error) {
            if (!isModelUnavailable(error) && !(error instanceof InvalidModelOutput)) throw error;
            console.warn(`Model ${model} unavailable (${error.status || error.name}), trying next`);
            lastError = error;
        }
    }
    throw lastError;
};

const SYMBOL_RE = /^[A-Z0-9.\-^]{1,12}$/;
const MAX_STOCKS = 50;

const cleanString = (value, maxLength, field) => {
    if (typeof value !== 'string' || !value.trim()) throw new BadRequest(`${field} is required`);
    if (value.length > maxLength) throw new BadRequest(`${field} is too long (max ${maxLength} characters)`);
    return value.trim();
};

const normalizeSymbol = (value) => String(value ?? '').toUpperCase().trim();

// Entries with malformed symbols (e.g. "?" from a failed import) are skipped
// rather than failing the whole request.
const cleanSymbols = (symbols) => {
    if (!Array.isArray(symbols)) throw new BadRequest('symbols must be an array');
    if (symbols.length > MAX_STOCKS) throw new BadRequest(`Too many symbols (max ${MAX_STOCKS})`);
    const valid = symbols.map(normalizeSymbol).filter(s => SYMBOL_RE.test(s));
    if (valid.length === 0) throw new BadRequest('No valid symbols provided');
    return valid;
};

const cleanNumber = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
};

const cleanPortfolio = (portfolio) => {
    if (!Array.isArray(portfolio)) throw new BadRequest('portfolio must be an array');
    if (portfolio.length > MAX_STOCKS) throw new BadRequest(`Too many stocks (max ${MAX_STOCKS})`);
    const stocks = portfolio
        .filter(s => s && SYMBOL_RE.test(normalizeSymbol(s.symbol)))
        .map(s => ({
            symbol: normalizeSymbol(s.symbol),
            price: cleanNumber(s.price),
            avgCost: cleanNumber(s.avgCost),
            shares: cleanNumber(s.shares),
        }));
    if (stocks.length === 0) throw new BadRequest('No valid stocks provided');
    return stocks;
};

// Returns parsed JSON, or null on any failure: missing market data should
// degrade the result, never fail the request.
const fetchMarketData = async (path, params) => {
    try {
        const res = await fetch(`${MARKET_DATA_PROXY_URL}${path}?${new URLSearchParams(params)}`, {
            signal: AbortSignal.timeout(8000),
        });
        return res.ok ? await res.json() : null;
    } catch {
        return null;
    }
};

// Finnhub quote: c = current, d = change, dp = % change. Unknown tickers come
// back as all zeros.
const fetchQuote = async (symbol) => {
    const q = await fetchMarketData('/quote', { symbol });
    if (!q || !(Number(q.c) > 0)) return null;
    return { price: cleanNumber(q.c), change: cleanNumber(q.d), changePercent: cleanNumber(q.dp) };
};

const isoDate = (date) => date.toISOString().slice(0, 10);

const fetchResearch = async (symbol) => {
    const today = new Date();
    const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    const [quote, financials, news] = await Promise.all([
        fetchQuote(symbol),
        fetchMarketData('/financials', { symbol }),
        fetchMarketData('/news', { symbol, from: isoDate(weekAgo), to: isoDate(today) }),
    ]);
    const m = (financials && financials.metric) || {};
    return {
        symbol,
        quote,
        metrics: {
            peTTM: m.peTTM,
            epsTTM: m.epsTTM,
            weekHigh52: m['52WeekHigh'],
            weekLow52: m['52WeekLow'],
            revenueGrowthYoY: m.revenueGrowthTTMYoy,
            beta: m.beta,
            dividendYield: m.dividendYieldIndicatedAnnual,
        },
        news: (Array.isArray(news) ? news : [])
            .filter(n => n && n.headline && n.url)
            .sort((a, b) => (b.datetime || 0) - (a.datetime || 0))
            .slice(0, NEWS_PER_SYMBOL),
    };
};

const fmt = (value, digits = 2) => (Number.isFinite(Number(value)) && value !== null ? Number(value).toFixed(digits) : 'n/a');

const parseJson = (text, fallback) => {
    try {
        return JSON.parse(text);
    } catch {
        return fallback;
    }
};

const actions = {
    async resolveTicker({ input }) {
        const query = cleanString(input, 100, 'input');
        const responseText = await generate({
            contents: `Identify the official stock ticker symbol and company name for: "${query}". Return JSON with keys: symbol, name. Example: {"symbol": "AAPL", "name": "Apple Inc."}`,
            config: {
                responseMimeType: 'application/json',
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        symbol: { type: Type.STRING },
                        name: { type: Type.STRING },
                    },
                    required: ['symbol', 'name'],
                },
            },
        });
        return parseJson(responseText, { symbol: '???', name: 'Unknown' });
    },

    async parsePortfolio({ text }) {
        const input = cleanString(text, 5000, 'text');
        const responseText = await generate({
            contents: `Extract stock portfolio data. Identify Symbol, official Company Name, Shares, and Avg Cost. Text: "${input}". Return JSON array of objects with keys: symbol, name, shares, avgCost.`,
            config: {
                responseMimeType: 'application/json',
                responseSchema: {
                    type: Type.ARRAY,
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            symbol: { type: Type.STRING },
                            name: { type: Type.STRING },
                            shares: { type: Type.NUMBER },
                            avgCost: { type: Type.NUMBER },
                        },
                        required: ['symbol'],
                    },
                },
            },
        });
        const rows = parseJson(responseText, []);
        const seen = new Set();
        return (Array.isArray(rows) ? rows : [])
            .map(r => ({
                symbol: normalizeSymbol(r && r.symbol),
                name: typeof r?.name === 'string' ? r.name.trim().slice(0, 100) : undefined,
                shares: cleanNumber(r?.shares),
                avgCost: cleanNumber(r?.avgCost),
            }))
            .filter(r => SYMBOL_RE.test(r.symbol) && !seen.has(r.symbol) && seen.add(r.symbol))
            .slice(0, MAX_STOCKS);
    },

    async syncPrices({ symbols }) {
        const list = [...new Set(cleanSymbols(symbols))];
        // Tickers without a quote are left out; the app keeps showing their
        // last known price.
        const quotes = await Promise.all(list.map(async symbol => {
            const quote = await fetchQuote(symbol);
            return quote && [symbol, quote];
        }));
        return Object.fromEntries(quotes.filter(Boolean));
    },

    async analyzePortfolio({ portfolio }) {
        const stocks = cleanPortfolio(portfolio).slice(0, MAX_ANALYZED_SYMBOLS);
        const research = await Promise.all(stocks.map(s => fetchResearch(s.symbol)));

        // Numbered so the model can cite articles by id; titles and links are
        // then filled in from the real article, so it can't invent sources.
        const articles = research.flatMap(r => r.news.map(n => ({ ...n, symbol: r.symbol })));

        const holdings = stocks.map((s, i) => {
            const { quote, metrics } = research[i];
            const price = quote ? quote.price : s.price;
            return [
                `${s.symbol}: price $${fmt(price)} (${quote ? `${fmt(quote.changePercent)}% today` : 'no live quote'}), `,
                `avg cost $${fmt(s.avgCost)}, shares ${s.shares}, `,
                `P/E ${fmt(metrics.peTTM, 1)}, EPS $${fmt(metrics.epsTTM)}, 52w range $${fmt(metrics.weekLow52)}-$${fmt(metrics.weekHigh52)}, `,
                `revenue growth YoY ${fmt(metrics.revenueGrowthYoY, 1)}%, beta ${fmt(metrics.beta)}, dividend yield ${fmt(metrics.dividendYield)}%`,
            ].join('');
        }).join('\n');

        const newsList = articles.length
            ? articles.map((n, i) => `[${i}] (${n.symbol}, ${n.source}) ${n.headline}${n.summary ? ` — ${String(n.summary).slice(0, 300)}` : ''}`).join('\n')
            : '(no recent news available)';

        const prompt = `
    ACT AS WealthSenseAI, A SENIOR TRADING INTELLIGENCE. Today is ${isoDate(new Date())}.
    Base your analysis on the live market data and news below, not on older knowledge of prices.

    PORTFOLIO (live data):
    ${holdings}

    RECENT NEWS (last 7 days, cite by id):
    ${newsList}

    1. Predict BUY/SELL/HOLD for each ticker with reasoning and a 12-month TARGET PRICE.
    2. Pick up to 4 of the most important news items above as insights. Set newsId to the item's id, and write a short title, a one-sentence summary and a sentiment.
    3. Suggest 3 NEW stocks (not already in the portfolio) that would diversify or strengthen it, with a reason.
    4. Provide a short market summary for this portfolio.
  `;

        const responseText = await generate({
            contents: prompt,
            config: {
                responseMimeType: 'application/json',
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        predictions: {
                            type: Type.ARRAY,
                            items: {
                                type: Type.OBJECT,
                                properties: {
                                    symbol: { type: Type.STRING },
                                    action: { type: Type.STRING, enum: ['BUY', 'SELL', 'HOLD'] },
                                    confidence: { type: Type.NUMBER },
                                    reasoning: { type: Type.STRING },
                                    targetPrice: { type: Type.NUMBER },
                                },
                                required: ['symbol', 'action', 'reasoning', 'targetPrice'],
                            },
                        },
                        insights: {
                            type: Type.ARRAY,
                            items: {
                                type: Type.OBJECT,
                                properties: {
                                    newsId: { type: Type.INTEGER },
                                    title: { type: Type.STRING },
                                    summary: { type: Type.STRING },
                                    sentiment: { type: Type.STRING, enum: ['BULLISH', 'BEARISH', 'NEUTRAL'] },
                                },
                                required: ['newsId', 'title', 'summary', 'sentiment'],
                            },
                        },
                        recommendations: {
                            type: Type.ARRAY,
                            items: {
                                type: Type.OBJECT,
                                properties: {
                                    symbol: { type: Type.STRING },
                                    name: { type: Type.STRING },
                                    sector: { type: Type.STRING },
                                    reason: { type: Type.STRING },
                                },
                                required: ['symbol', 'name', 'sector', 'reason'],
                            },
                        },
                        summary: { type: Type.STRING },
                    },
                    required: ['predictions', 'insights', 'recommendations', 'summary'],
                },
            },
        });
        const result = parseJson(responseText, {});
        const oneOf = (value, allowed, fallback) => {
            const v = String(value || '').toUpperCase();
            return allowed.includes(v) ? v : fallback;
        };
        result.predictions = (Array.isArray(result.predictions) ? result.predictions : [])
            .map(p => ({ ...p, action: oneOf(p.action, ['BUY', 'SELL', 'HOLD'], 'HOLD') }));
        result.recommendations = (Array.isArray(result.recommendations) ? result.recommendations : [])
            .filter(r => r && r.symbol);
        result.insights = (Array.isArray(result.insights) ? result.insights : [])
            .filter(i => i && articles[i.newsId])
            .map(({ newsId, ...insight }) => ({
                ...insight,
                sentiment: oneOf(insight.sentiment, ['BULLISH', 'BEARISH', 'NEUTRAL'], 'NEUTRAL'),
                source: articles[newsId].source,
                url: articles[newsId].url,
            }));
        return result;
    },
};

const isSameOrigin = (req, origin) => {
    try {
        return new URL(origin).host === req.headers.host;
    } catch {
        return false;
    }
};

module.exports = async (req, res) => {
    const origin = req.headers.origin;
    const originAllowed = !origin || allowedOrigins.has(origin) || isSameOrigin(req, origin);

    if (origin && originAllowed) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }

    if (req.method === 'OPTIONS') {
        return res.status(originAllowed ? 204 : 403).end();
    }
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }
    if (!originAllowed) {
        return res.status(403).json({ error: 'Origin not allowed' });
    }

    const { action, ...payload } = req.body || {};
    if (!Object.prototype.hasOwnProperty.call(actions, action)) {
        return res.status(400).json({ error: 'Unknown action' });
    }

    const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
    if (isRateLimited(ip, action)) {
        return res.status(429).json({ error: 'Too many requests. Please try again in a minute.' });
    }

    try {
        const data = await actions[action](payload);
        return res.status(200).json({ data });
    } catch (error) {
        if (error instanceof BadRequest) {
            return res.status(400).json({ error: error.message });
        }
        if (error instanceof NotConfigured) {
            console.error(error.message);
            return res.status(500).json({ error: 'AI service is not configured' });
        }

        console.error(`Error in /api/gemini (${action}):`, error);

        const message = String(error?.message || '');
        if (error?.status === 429 || message.includes('RESOURCE_EXHAUSTED') || message.includes('quota')) {
            return res.status(429).json({ error: 'AI Quota Exceeded. Please try again later.' });
        }
        return res.status(500).json({ error: 'Failed to generate content from AI model' });
    }
};
