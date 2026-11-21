/**
 * Customer Executive Agent — main service module.
 * Coordinates workspace management, website crawling, knowledge extraction,
 * and chatbot configuration.
 */

const { createRouterFromEnv } = require('../services/ai/router');
const { ensureSchema: ensureKnowledgeSchema } = require('./knowledge');
const { ensureSchema: ensureCrawlerSchema } = require('./crawler');

// Initialize schemas on load
ensureKnowledgeSchema();
ensureCrawlerSchema();

/**
 * Get the NVIDIA AI Router (Customer Executive uses NVIDIA only)
 */
function getNvidiaRouter() {
  return createRouterFromEnv({
    ...process.env,
    AI_PROVIDER: 'nvidia'
  });
}

/**
 * Extract knowledge from website content.
 * @param {string} content - Raw HTML content
 * @param {string} url - Source URL
 * @returns {object} - Structured knowledge object
 */
function extractKnowledge(content, url) {
  // Basic extraction - can be enhanced with NLP/embeddings
  const knowledge = {
    sourceUrl: url,
    extracted: new Date().toISOString(),
    sections: []
  };

  // Extract title
  const titleMatch = content.match(/<title[^>]*>([^<]*)<\/title>/i);
  if (titleMatch) knowledge.title = titleMatch[1].trim();

  // Extract company name from meta tags
  const orgMatch = content.match(/<meta property="og:website"[^>]*content="([^"]+)"/i);
  if (orgMatch) knowledge.companyName = orgMatch[1].trim();

  // Extract product/service descriptions (simplified)
  const descMatches = content.matchAll(/<p[^>]*>([^<]+)<\/p>/gi);
  const paragraphs = [];
  for (const match of descMatches) {
    if (match[1].trim().length > 50) {
      paragraphs.push(match[1].trim());
    }
  }
  knowledge.sections = paragraphs.slice(0, 10); // First 10 relevant paragraphs

  return knowledge;
}

module.exports = {
  getNvidiaRouter,
  extractKnowledge
};