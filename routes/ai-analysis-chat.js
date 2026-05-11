const express = require('express');
const axios = require('axios');
const rateLimit = require('express-rate-limit');

const db = require('../lib/db');
const { readDocument } = require('../lib/storage');
const { extractText } = require('../lib/document-text-extract');
const { requireAuth, requireAdmin } = require('../lib/supabase');
const { safeStagingSlug } = require('../lib/document-staging');

const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many AI chat requests. Try again in a minute.' },
});

const router = express.Router();

/**
 * POST /api/admin/ai-analysis/chat
 * Receives a chat message + profileId, finds documents, calls AgenteDocumental,
 * and returns the parsed analysis result.
 *
 * Body: { message, profileId, countryName?, providerName? }
 */
router.post(
  '/ai-analysis/chat',
  requireAuth,
  requireAdmin,
  aiLimiter,
  async (req, res) => {
    try {
      const message = String(req.body?.message ?? '').trim();
      const profileId = String(req.body?.profileId ?? '').trim();
      const countryName = String(req.body?.countryName ?? '').trim() || undefined;
      const providerName = String(req.body?.providerName ?? '').trim() || undefined;

      if (!message) {
        return res.status(400).json({ error: 'message is required.' });
      }
      if (!profileId) {
        return res.status(400).json({ error: 'profileId is required.' });
      }

      const agentUrl = (process.env.DOC_AGENT_URL || '').trim().replace(/\/$/, '');
      if (!agentUrl) {
        return res.status(503).json({
          error: 'Crew service unavailable',
          message: 'DOC_AGENT_URL is not configured on the API server.',
          demo: true,
        });
      }

      // Find documents: first by profile_id, then by storage path pattern
      let documents = [];
      const { rows: byProfile } = await db.query(
        `SELECT id, filename, storage_path FROM documents
         WHERE profile_id = $1 ORDER BY created_at DESC LIMIT 64`,
        [profileId]
      );
      documents = byProfile;

      if (!documents.length) {
        const slug = safeStagingSlug(profileId);
        const draftPattern = `%draft-${slug}%`;
        const { rows: byPath } = await db.query(
          `SELECT id, filename, storage_path FROM documents
           WHERE storage_path LIKE $1
           ORDER BY created_at DESC LIMIT 64`,
          [draftPattern]
        );
        documents = byPath;
      }

      if (!documents.length) {
        return res.status(400).json({
          error: 'No documents',
          message: 'No documents found for this profile. Upload files at step 2 first.',
        });
      }

      // Extract text from each document
      const maxChars = parseInt(process.env.MAX_CHARS_PER_DOC || '20000', 10);
      const documentsWithText = [];

      for (const doc of documents) {
        try {
          const buffer = await readDocument(doc.storage_path);
          const text = await extractText(buffer, doc.filename);
          documentsWithText.push({
            filename: doc.filename,
            text: text.slice(0, maxChars),
          });
        } catch (readErr) {
          console.warn(`[ai-analysis/chat] Could not read ${doc.filename}:`, readErr.message);
        }
      }

      if (!documentsWithText.length) {
        return res.status(400).json({
          error: 'No readable documents',
          message: 'None of the uploaded documents could be read/extracted.',
        });
      }

      console.log(
        `[ai-analysis/chat] Sending ${documentsWithText.length} documents to agent at ${agentUrl}`
      );

      // Call AgenteDocumental
      const { data: agentData } = await axios.post(
        `${agentUrl}/analyze`,
        {
          message,
          country: countryName,
          provider: providerName,
          documents: documentsWithText,
          profile_id: profileId,
        },
        {
          headers: process.env.AGENT_API_KEY
            ? { 'X-API-Key': process.env.AGENT_API_KEY }
            : {},
          timeout: 120_000,
        }
      );

      // Parse agent response — the output can be a JSON string or structured
      const rawOutput = String(agentData.output ?? '');
      let assistant = '';
      let rules = [];

      try {
        const parsed = JSON.parse(rawOutput);
        assistant = parsed.summary || parsed.assistant || rawOutput;
        rules = Array.isArray(parsed.rules)
          ? parsed.rules.map((r, i) => ({
              id: r.id || `ext-${i + 1}`,
              label: r.label || '',
              inputKey: r.input_key || '',
              direction: r.direction || '',
              obligation: r.obligation || '',
              operationGroup: r.operation_group || '',
              paPerItem: String(r.pa_transactions_per_item ?? ''),
              status: r.status || 'proposed',
              reason: r.reason || '',
              sourceExcerpt: r.source_excerpt || '',
            }))
          : [];
      } catch {
        // Not JSON — treat the whole output as assistant text
        assistant = rawOutput;
      }

      res.json({
        assistant,
        rules,
        raw_output: rawOutput,
        documents_used: documentsWithText.map((d) => d.filename),
      });
    } catch (err) {
      if (err.response?.status) {
        console.error('[ai-analysis/chat] Agent error:', err.response.status, err.response.data);
        return res.status(err.response.status).json({
          error: 'Crew error',
          message:
            typeof err.response.data?.detail === 'string'
              ? err.response.data.detail
              : JSON.stringify(err.response.data),
        });
      }
      console.error('[ai-analysis/chat] Error:', err.message || err);
      res.status(500).json({ error: String(err.message || err) });
    }
  }
);

module.exports = router;
