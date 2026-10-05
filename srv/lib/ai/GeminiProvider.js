const { GoogleGenAI } = require("@google/genai");
const AIProvider = require("./AIProvider");

class GeminiProvider extends AIProvider {

    constructor() {
        super();

        if (!process.env.GEMINI_API_KEY) {
            throw new Error(
                "GEMINI_API_KEY is not configured"
            );
        }

        this.client = new GoogleGenAI({
            apiKey: process.env.GEMINI_API_KEY
        });

        this.model = "gemini-3-flash-preview";
    }

    async generateText(prompt, options = {}) {

        const response = await this.client.models.generateContent({
            model: this.model,
            contents: prompt,
            config: {
                temperature: options.temperature ?? 0.1,
                maxOutputTokens: options.maxOutputTokens ?? 4000
            }
        });

        return response.text;
    }

    async generateJSON(prompt, options = {}) {

        const response = await this.client.models.generateContent({
            model: this.model,
            contents: prompt,
            config: {
                temperature: options.temperature ?? 0.1,
                maxOutputTokens: options.maxOutputTokens ?? 8000,
                responseMimeType: "application/json"
            }
        });

        const text = response.text;

        if (!text) {
            throw new Error("Gemini returned an empty response");
        }

        try {
            return JSON.parse(text);
        } catch (error) {
            throw new Error(
                `Gemini returned invalid JSON: ${error.message}\nResponse: ${text}`
            );
        }
    }
}

module.exports = GeminiProvider;