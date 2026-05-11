const express = require('express');
const axios = require('axios');
const rateLimit = require('express-rate-limit');

const db = require('../lib/db');
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

      // profileId may be a UUID or a slug — resolve to UUID if needed
      let resolvedProfileId = profileId;
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(profileId);

      if (!isUuid) {
        // Try to find profile by matching slug-style IDs in the calculation_profiles table
        const { rows: profileRows } = await db.query(
          `SELECT cp.id FROM calculation_profiles cp
           JOIN countries co ON co.id = cp.country_id
           JOIN providers pr ON pr.id = cp.provider_id
           ORDER BY cp.created_at DESC`
        );
        if (profileRows.length) {
          resolvedProfileId = profileRows[0].id;
          console.log(`[ai-analysis/chat] Resolved slug "${profileId}" to profile UUID ${resolvedProfileId}`);
        }
      }

      // Find documents: by profile_id, then by storage path pattern
      let documents = [];

      if (/^[0-9a-f]{8}-/i.test(resolvedProfileId)) {
        const { rows: byProfile } = await db.query(
          `SELECT id, filename, storage_path FROM documents
           WHERE profile_id = $1 ORDER BY created_at DESC LIMIT 64`,
          [resolvedProfileId]
        );
        documents = byProfile;
      }

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

      // Also try matching by storage path containing the original profileId
      if (!documents.length) {
        const { rows: byOriginal } = await db.query(
          `SELECT id, filename, storage_path FROM documents
           WHERE storage_path LIKE $1
           ORDER BY created_at DESC LIMIT 64`,
          [`%${profileId}%`]
        );
        documents = byOriginal;
      }

      if (!documents.length) {
        return res.status(400).json({
          error: 'No documents',
          message: `No documents found for profile "${profileId}". Upload files at step 2 first.`,
        });
      }

      // Collect storage paths — AgenteDocumental reads files directly from the shared volume
      const storagePaths = documents.map((d) => d.storage_path);

      // Derive a common allowed root from the storage paths
      // (e.g. /data/documents/<profile-id> or /data/documents/draft-...)
      const DOCS_PATH = (process.env.DOCUMENTS_PATH || '/data/documents').replace(/\/$/, '');
      const allowedRoots = [DOCS_PATH];

      console.log(
        `[ai-analysis/chat] Sending ${storagePaths.length} paths to agent at ${agentUrl}`
      );

      // Call AgenteDocumental with document_paths (not pre-extracted text)
      const { data: agentData } = await axios.post(
        `${agentUrl}/analyze`,
        {
          message,
          document_paths: storagePaths,
          allowed_roots: allowedRoots,
          country_name: countryName,
          provider_name: providerName,
          profile_id: profileId,
        },
        {
          headers: process.env.AGENT_API_KEY
            ? { 'X-API-Key': process.env.AGENT_API_KEY }
            : {},
          timeout: 180_000,
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
        documents_used: documents.map((d) => d.filename),
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
