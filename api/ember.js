// Vercel serverless function, served at YOUR_VERCEL_URL/api/ember.
//
// Ember twin of api/gemini.js: same actions, same request/response contract,
// same market-data proxy — only the model behind it changes. The app keeps
// calling /api/gemini, so nothing here affects the live app until this file
// is wired up (or its contents replace api/gemini.js) AND a MODEL_API_KEY
// is set in the Vercel env vars. Without the key the function answers 500
// ("AI service is not configured").
//
// Why Ember: Muse Ember (muse-ember-1.0) is Meta's smallest/cheapest Muse
// model, built for the repeated work agents do all day — tool calls, coding
// subtasks, routing, extraction, long-document parsing. Pricing (standard
// mode): $0.10 / $0.50 per million input/output tokens for requests up to
// 200K input tokens; above 200K the WHOLE request bills at 3x
// ($0.30 / $1.50). 1M-token context, up to 512K output tokens. Reasoning
// effort runs "minimal" to "max" — there is no off switch.
//
// API: POST https://api.meta.ai/v1/responses, Bearer MODEL_API_KEY.
// Structured output uses text.format (NOT response_format — sending
// response_format to /v1/responses returns 400).
// Docs: https://dev.meta.ai/docs/overview,
// https://dev.meta.ai/docs/structured-output

const META_API_URL = 'https://api.meta.ai/v1/responses';
const MODEL = 'muse-ember-1.0';

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
// memory, so it resets on cold starts and isn't shared across instances.
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

const getModelKey = () => {
    const apiKey = process.env.MODEL_API_KEY;
    if (!apiKey) throw new NotConfigured('MODEL_API_KEY is not set');
    return apiKey;
};

// Errors that mean "this model can't serve us right now" rather than "the
// request is bad": overloaded, out of quota, or too slow.
const isModelUnavailable = (error) =>
    [404, 429, 500, 502, 503, 504].includes(error?.status) || error?.name === 'AbortError' || error?.name === 'TimeoutError';

// Total time one request may spend waiting on the model. After a failed
// attempt we pause briefly and try once more, as long as there is budget left.
const TOTAL_BUDGET_MS = 75_000;
const RETRY_PAUSE_MS = 2_000;
const MAX_PASSES = 2;
const MODEL_TIMEOUT_MS = 25_000;

class ModelsBusy extends Error {}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Pulls the assistant's text out of a Responses API payload, whether it
// arrives as the top-level output_text or nested in output[].content[].
const extractText = (data) => {
    if (typeof data.output_text === 'string' && data.output_text) return data.output_text;
    const parts = [];
    for (const item of data.output || []) {
        if (item.type !== 'message') continue;
        for (const part of item.content || []) {
            if (part.type === 'output_text' && typeof part.text === 'string') parts.push(part.text);
        }
    }
    return parts.join('');
};

// Rough token estimate (~4 chars per token) used only for the price-cliff
// warning below; never blocks a request.
const approxInputTokens = (text) => Math.ceil(String(text).length / 4);

// Returns the response text from Muse Ember. Retries on transient failures
// (rate limits, 5xx, timeouts) with a short pause; auth and bad-request
// errors throw immediately so a bad key or schema fails loud instead of
// burning the whole time budget.
const generate = async ({ contents, config }) => {
    const apiKey = getModelKey();

    // Ember's cheap rate only applies up to 200K input tokens per request;
    // above that the whole request bills at 3x. Our prompts are ~10-20K
    // tokens, but warn loudly if one ever approaches the cliff.
    const estimated = approxInputTokens(contents);
    if (estimated > 180_000) {
        console.warn(`Ember request near 200K-token price cliff (~${estimated} tokens)`);
    }

    const startedAt = Date.now();
    let lastError;
    for (let pass = 0; pass < MAX_PASSES; pass++) {
        if (pass > 0) {
            if (Date.now() - startedAt + RETRY_PAUSE_MS + MODEL_TIMEOUT_MS / 2 > TOTAL_BUDGET_MS) break;
            await sleep(RETRY_PAUSE_MS);
        }
        const remaining = TOTAL_BUDGET_MS - (Date.now() - startedAt);
        if (remaining < 5_000) break;
        try {
            const body = {
                model: MODEL,
                input: contents,
                // No server-side state: each call is self-contained.
                store: false,
                reasoning: { effort: config.effort || 'minimal' },
                max_output_tokens: config.maxOutputTokens || 4096,
            };
            if (config.jsonSchema) {
                body.text = {
                    format: {
                        type: 'json_schema',
                        name: config.jsonSchema.name,
                        schema: config.jsonSchema.schema,
                    },
                };
            }
            const res = await fetch(META_API_URL, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(Math.min(MODEL_TIMEOUT_MS, remaining)),
            });
            if (!res.ok) {
                const err = new Error(`Meta Model API ${res.status}`);
                err.status = res.status;
                const detail = await res.text().catch(() => '');
                if (detail) err.message += `: ${detail.slice(0, 300)}`;
                throw err;
            }
            const data = await res.json();
            if (data.status === 'failed') {
                throw new InvalidModelOutput(`${MODEL} failed: ${data.error?.message || 'unknown error'}`);
            }
            const text = extractText(data);
            // A cut-off or malformed JSON answer counts as a failed model, not a result.
            if (config.jsonSchema && parseJson(text, undefined) === undefined) {
                throw new InvalidModelOutput(`${MODEL} returned invalid JSON`);
            }
            return text;
        } catch (error) {
            if (!isModelUnavailable(error) && !(error instanceof InvalidModelOutput)) throw error;
            console.warn(`Muse Ember unavailable (${error.status || error.name}${error instanceof InvalidModelOutput ? `: ${error.message}` : ''}), retrying [pass ${pass + 1}]`);
            lastError = error;
        }
    }
    const busy = new ModelsBusy(lastError ? String(lastError.message || lastError) : 'No model answered in time');
    busy.status = lastError?.status; // lets the handler still report quota exhaustion as 429
    throw busy;
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
    if (symbols.length > MAX_STOCKS) throw new BadRequest(`Too many stocks (max ${MAX_STOCKS})`);
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
                effort: 'minimal',
                jsonSchema: {
                    name: 'resolve_ticker',
                    schema: {
                        type: 'object',
                        properties: {
                            symbol: { type: 'string' },
                            name: { type: 'string' },
                        },
                        required: ['symbol', 'name'],
                        additionalProperties: false,
                    },
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
                effort: 'minimal',
                jsonSchema: {
                    name: 'parse_portfolio',
                    schema: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                symbol: { type: 'string' },
                                name: { type: 'string' },
                                shares: { type: 'number' },
                                avgCost: { type: 'number' },
                            },
                            required: ['symbol'],
                            additionalProperties: false,
                        },
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

    Keep every reasoning, summary and reason to one short sentence (under 25 words) so the answer stays compact.
  `;

        const responseText = await generate({
            contents: prompt,
            config: {
                // Full reasoning for the judgment call; lower to "high" if
                // this action starts hitting the per-model timeout.
                effort: 'max',
                maxOutputTokens: 8192,
                jsonSchema: {
                    name: 'analyze_portfolio',
                    schema: {
                        type: 'object',
                        properties: {
                            predictions: {
                                type: 'array',
                                items: {
                                    type: 'object',
                                    properties: {
                                        symbol: { type: 'string' },
                                        action: { type: 'string', enum: ['BUY', 'SELL', 'HOLD'] },
                                        confidence: { type: 'number' },
                                        reasoning: { type: 'string' },
                                        targetPrice: { type: 'number' },
                                    },
                                    required: ['symbol', 'action', 'reasoning', 'targetPrice'],
                                    additionalProperties: false,
                                },
                            },
                            insights: {
                                type: 'array',
                                items: {
                                    type: 'object',
                                    properties: {
                                        newsId: { type: 'integer' },
                                        title: { type: 'string' },
                                        summary: { type: 'string' },
                                        sentiment: { type: 'string', enum: ['BULLISH', 'BEARISH', 'NEUTRAL'] },
                                    },
                                    required: ['newsId', 'title', 'summary', 'sentiment'],
                                    additionalProperties: false,
                                },
                            },
                            recommendations: {
                                type: 'array',
                                items: {
                                    type: 'object',
                                    properties: {
                                        symbol: { type: 'string' },
                                        name: { type: 'string' },
                                        sector: { type: 'string' },
                                        reason: { type: 'string' },
                                    },
                                    required: ['symbol', 'name', 'sector', 'reason'],
                                    additionalProperties: false,
                                },
                            },
                            summary: { type: 'string' },
                        },
                        required: ['predictions', 'insights', 'recommendations', 'summary'],
                        additionalProperties: false,
                    },
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

        console.error(`Error in /api/ember (${action}):`, error);

        const message = String(error?.message || '');
        if (error?.status === 429 || message.includes('RESOURCE_EXHAUSTED') || message.includes('quota')) {
            return res.status(429).json({ error: 'AI Quota Exceeded. Please try again later.' });
        }
        if (error instanceof ModelsBusy) {
            return res.status(503).json({ error: 'The AI service is busy right now. Please try again in a minute.' });
        }
        return res.status(500).json({ error: 'Failed to generate content from AI model' });
    }
};
