// GROQ SERVICE REMOVED — replaced by Cloudflare Workers AI
// See services/cloudflare.js for the AI service implementation
module.exports = {
  chat: async () => { throw new Error('Groq removed — use Cloudflare Workers AI'); },
  chatStream: async () => { throw new Error('Groq removed — use Cloudflare Workers AI'); },
};