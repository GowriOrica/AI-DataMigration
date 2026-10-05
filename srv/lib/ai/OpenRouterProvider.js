const AIProvider = require("./AIProvider");

class OpenRouterProvider extends AIProvider {
    constructor() {
    super();

    if (!process.env.OPENROUTER_API_KEY) {
        throw new Error("OPENROUTER_API_KEY is not configured");
    }

    this.apiKey = process.env.OPENROUTER_API_KEY;

    // Use the model configured in .env
    // Example:
    // OPENROUTER_MODEL=meta-llama/llama-3.1-8b-instruct:free
    const configuredModel = process.env.OPENROUTER_MODEL;

    if (!configuredModel) {
        throw new Error("OPENROUTER_MODEL is not configured");
    }

    this.fallbackModels = [
        configuredModel
    ].filter(Boolean);

    this.endpoint = "https://openrouter.ai/api/v1/chat/completions";
}

    async generateText(prompt, options = {}) {
        let lastError;

        for (const modelName of this.fallbackModels) {
            try {
                console.log(`[OPENROUTER PROVIDER] Trying model: ${modelName}`);

                const response = await fetch(this.endpoint, {
                    method: "POST",
                    headers: {
                        "Authorization": `Bearer ${this.apiKey}`,
                        "Content-Type": "application/json",
                        "HTTP-Referer": process.env.OPENROUTER_HTTP_REFERER || "",
                        "X-Title": process.env.OPENROUTER_APP_NAME || "Migration Orchestrator"
                    },
                    body: JSON.stringify({
                        model: modelName,
                        messages: [
                            {
                                role: "system",
                                content: "You are a data migration semantic assessment engine. Return ONLY valid JSON. Do not return Markdown, code fences, explanations, safety messages, or any text outside the JSON response."
                            },
                            {
                                role: "user",
                                content: prompt
                            }
                        ],
                        temperature: options.temperature ?? 0.1,
                        max_tokens: options.maxOutputTokens ?? 4000,
                        response_format: {
                            type: "json_object"
                        }
                    })
                });

                if (!response.ok) {
                    const errorText = await response.text();
                    const err = new Error(`OpenRouter API failed (${response.status}): ${errorText}`);
                    err.status = response.status;
                    throw err;
                }

                const result = await response.json();
                const content = result?.choices?.[0]?.message?.content;

                if (!content) {
                    throw new Error("OpenRouter returned an empty response");
                }

                return {
                    content,
                    usage: result?.usage || {}
                };

            } catch (err) {
                console.warn(`[OPENROUTER PROVIDER] Model '${modelName}' failed (${err.message}).`);
                lastError = err;
            }
        }

        // No invented fallback result: a failed AI call must be reported as a failure,
        // so callers never present made-up assessments as real AI output.
        throw new Error(
            `OpenRouter: all configured models failed. Last error: ${lastError?.message || "unknown"}`
        );
    }

    _extractAndParseJSON(rawText) {
        if (!rawText || typeof rawText !== "string") {
            throw new Error("Empty AI response received");
        }

        let text = rawText.trim();
        text = text.replace(/^User Safety:\s*safe\s*/i, "").trim();

        const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
        if (fenceMatch) {
            text = fenceMatch[1].trim();
        }

        const firstBrace = text.indexOf("{");
        const firstBracket = text.indexOf("[");
        let startIdx = -1;

        if (firstBrace !== -1 && firstBracket !== -1) {
            startIdx = Math.min(firstBrace, firstBracket);
        } else {
            startIdx = firstBrace !== -1 ? firstBrace : firstBracket;
        }

        if (startIdx === -1) {
            throw new Error(`No JSON object found: "${rawText.slice(0, 100)}..."`);
        }

        const lastBrace = text.lastIndexOf("}");
        const lastBracket = text.lastIndexOf("]");
        const endIdx = Math.max(lastBrace, lastBracket);

        if (endIdx === -1 || endIdx < startIdx) {
            throw new Error(`Incomplete JSON: "${rawText.slice(0, 100)}..."`);
        }

        return JSON.parse(text.substring(startIdx, endIdx + 1));
    }

    async generateJSON(prompt, options = {}) {
        const result = await this.generateText(prompt, options);

        try {
            const parsed = this._extractAndParseJSON(result.content);
            return {
                data: parsed,
                usage: result.usage
            };
        } catch (error) {
            throw new Error(`OpenRouter returned invalid JSON: ${error.message}\nResponse: ${result.content}`);
        }
    }
}

module.exports = OpenRouterProvider;