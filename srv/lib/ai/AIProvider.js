class AIProvider {

    async generateText(prompt, options = {}) {
        throw new Error("generateText() must be implemented by an AI provider");
    }

    async generateJSON(prompt, schema = null, options = {}) {
        throw new Error("generateJSON() must be implemented by an AI provider");
    }

}

module.exports = AIProvider;