const GeminiProvider = require("./GeminiProvider");
const OpenRouterProvider = require("./OpenRouterProvider");

function createAIProvider() {
    const providerName = (process.env.AI_PROVIDER || "GEMINI")
        .trim()
        .toUpperCase();

    switch (providerName) {
        case "GEMINI":
            return new GeminiProvider();

        case "OPENROUTER":
            return new OpenRouterProvider();

        default:
            throw new Error(`Unsupported AI provider '${providerName}'`);
    }
}

module.exports = {
    createAIProvider
};