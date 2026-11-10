/**
 * SearchProvider — provider-independent web search interface.
 * Mirrors the AI provider pattern: the chat API and UI depend only on
 * this interface, so DuckDuckGo can later be swapped (Brave, Tavily…)
 * without touching callers.
 */

class SearchProvider {
  constructor(name) {
    this.name = name;
  }

  /**
   * @param {string} query
   * @param {{ count?: number }} opts
   * @returns {Promise<Array<{ title: string, url: string, snippet: string }>>}
   */
  async search() {
    throw new Error('search() not implemented');
  }
}

module.exports = { SearchProvider };
