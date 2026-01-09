const { GoogleGenerativeAI } = require('@google/generative-ai');

// This is a Vercel serverless function.
// It will be accessible at YOUR_VERCEL_URL/api/gemini

module.exports = async (req, res) => {
    // Vercel automatically enables CORS for all functions
    // and parses the body, so we can remove the boilerplate.

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const { model, contents, config } = req.body;

        if (!model || !contents) {
            return res.status(400).json({ error: 'Missing model or contents in request body' });
        }

        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            return res.status(500).json({ error: 'GEMINI_API_KEY is not set in environment variables.' });
        }

        const genAI = new GoogleGenerativeAI({ apiKey });
        const generativeModel = genAI.getGenerativeModel({ model });

        const result = await generativeModel.generateContent({ contents, ...config });
        const response = await result.response;
        const text = response.text();

        // Success response
        res.status(200).json({ text });

    } catch (error) {
        console.error('Error in /api/gemini function:', error);

        // Check for specific Gemini API errors if needed
        if (error.message.includes("quota")) {
            return res.status(429).json({ error: "AI Quota Exceeded. Please try again later." });
        }

        res.status(500).json({ error: 'Failed to generate content from AI model' });
    }
};
