const crypto = require('crypto');
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

      // AGENT_SHARED_VOLUME=true  → pass file paths directly (AgenteDocumental reads via FileReadTool).
      //                             Requires both services to mount the same Railway volume at /data.
      // AGENT_SHARED_VOLUME unset → extract text here and send inline (works without shared volume,
      //                             but uses more LLM context; tune MAX_CHARS_PER_DOC / MAX_CHARS_TOTAL).
      const useSharedVolume = (process.env.AGENT_SHARED_VOLUME || '').toLowerCase() === 'true';

      let agentPayload;

      if (useSharedVolume) {
        const storagePaths = documents.map((d) => d.storage_path);
        const DOCS_PATH = (process.env.DOCUMENTS_PATH || '/data/documents').replace(/\/$/, '');
        console.log(`[ai-analysis/chat] Shared-volume mode — sending ${storagePaths.length} path(s) to agent`);
        agentPayload = {
          message,
          document_paths: storagePaths,
          documents: [],
          allowed_roots: [DOCS_PATH],
          country_name: countryName,
          provider_name: providerName,
          profile_id: profileId,
        };
      } else {
        // Extract text here; AgenteDocumental receives inline content (no volume sharing required).
        // MAX_CHARS_PER_DOC: per-document cap. MAX_CHARS_TOTAL: combined cap across all documents.
        const maxCharsPerDoc = parseInt(process.env.MAX_CHARS_PER_DOC || '15000', 10);
        const maxCharsTotal = parseInt(process.env.MAX_CHARS_TOTAL || '40000', 10);
        const extractedDocs = [];
        let totalChars = 0;

        for (const doc of documents) {
          if (totalChars >= maxCharsTotal) {
            console.warn(`[ai-analysis/chat] Total char cap (${maxCharsTotal}) reached — skipping ${doc.filename}`);
            break;
          }
          try {
            const buffer = await readDocument(doc.storage_path);
            const text = await extractText(buffer, doc.filename);
            const remaining = maxCharsTotal - totalChars;
            const slice = text.slice(0, Math.min(maxCharsPerDoc, remaining));
            extractedDocs.push({ filename: doc.filename, text: slice });
            totalChars += slice.length;
            console.log(`[ai-analysis/chat] Extracted ${text.length} chars from ${doc.filename} (sending ${slice.length})`);
          } catch (readErr) {
            console.warn(`[ai-analysis/chat] Could not read ${doc.filename}:`, readErr.message);
          }
        }

        if (!extractedDocs.length) {
          return res.status(400).json({
            error: 'No readable documents',
            message: 'None of the uploaded documents could be read. Please re-upload the files at step 2.',
          });
        }

        console.log(`[ai-analysis/chat] Text-extraction mode — sending ${extractedDocs.length} doc(s) inline to agent`);
        agentPayload = {
          message,
          document_paths: [],
          documents: extractedDocs,
          country_name: countryName,
          provider_name: providerName,
          profile_id: profileId,
        };
      }

      // Must stay below Netlify SSR `timeout` when the browser uses the Astro BFF; keep
      // a few seconds headroom so we return JSON before the edge kills the function.
      const agentTimeoutMs = parseInt(process.env.DOC_AGENT_TIMEOUT_MS || '290000', 10);
      const correlationId = crypto.randomUUID();
      const docCount =
        Array.isArray(agentPayload.documents) && agentPayload.documents.length
          ? agentPayload.documents.length
          : Array.isArray(agentPayload.document_paths)
            ? agentPayload.document_paths.length
            : 0;

      console.log(
        `[ai-analysis/chat] correlationId=${correlationId} → POST ${agentUrl}/analyze ` +
          `(timeout_ms=${agentTimeoutMs}, doc_slots=${docCount}, message_len=${message.length})`
      );

      const agentStarted = Date.now();
      let agentData;
      try {
        const agentHeaders = {
          'X-Correlation-Id': correlationId,
          ...(process.env.AGENT_API_KEY ? { 'X-API-Key': process.env.AGENT_API_KEY } : {}),
        };
        const res = await axios.post(`${agentUrl}/analyze`, agentPayload, {
          headers: agentHeaders,
          timeout: agentTimeoutMs,
          // Avoid hanging on rare chunked / parser edge cases — body is small JSON.
          maxBodyLength: 25 * 1024 * 1024,
          maxContentLength: 25 * 1024 * 1024,
        });
        agentData = res.data;
      } catch (axErr) {
        const ms = Date.now() - agentStarted;
        const code = axErr.code || axErr.cause?.code;
        console.error(
          `[ai-analysis/chat] correlationId=${correlationId} agent request failed after ${ms}ms:`,
          code || axErr.message,
          axErr.response?.status,
          typeof axErr.response?.data === 'string'
            ? axErr.response.data.slice(0, 500)
            : axErr.response?.data
        );
        throw axErr;
      }

      const elapsedMs = Date.now() - agentStarted;
      const outLen =
        agentData && typeof agentData.output === 'string' ? agentData.output.length : 0;
      console.log(
        `[ai-analysis/chat] correlationId=${correlationId} ← agent OK in ${elapsedMs}ms ` +
          `(output_json_string_len=${outLen}, top_level_keys=${agentData && typeof agentData === 'object' ? Object.keys(agentData).join(',') : typeof agentData})`
      );

      // Parse agent response — `output` is a JSON string (DocumentAnalysisResult from AgenteDocumental).
      const rawOutput = String(agentData?.output ?? '');
      let assistant = '';
      let rules = [];

      const mapRuleRow = (r, i) => ({
        id: r.id || `ext-${i + 1}`,
        label: r.label || '',
        inputKey: r.input_key || r.inputKey || '',
        direction: r.direction || '',
        obligation: r.obligation || '',
        operationGroup: r.operation_group || r.operationGroup || '',
        paPerItem: String(r.pa_transactions_per_item ?? r.paPerItem ?? ''),
        status: r.status || 'proposed',
        reason: r.reason || '',
        sourceExcerpt: r.source_excerpt || r.sourceExcerpt || '',
      });

      try {
        const parsed = JSON.parse(rawOutput);
        const rows = Array.isArray(parsed.transaction_rules)
          ? parsed.transaction_rules
          : Array.isArray(parsed.rules)
            ? parsed.rules
            : [];
        rules = rows.map(mapRuleRow);
        assistant =
          (typeof parsed.summary_markdown === 'string' && parsed.summary_markdown.trim()) ||
          (typeof parsed.summary === 'string' && parsed.summary.trim()) ||
          (typeof parsed.assistant === 'string' && parsed.assistant.trim()) ||
          rawOutput;
      } catch {
        assistant = rawOutput;
      }

      const payload = {
        assistant,
        rules,
        raw_output: rawOutput,
        documents_used: documents.map((d) => d.filename),
      };

      try {
        res.json(payload);
        console.log(
          `[ai-analysis/chat] correlationId=${correlationId} sent JSON to client ` +
            `(rules=${rules.length}, assistant_len=${assistant.length})`
        );
      } catch (jsonErr) {
        console.error('[ai-analysis/chat] res.json failed:', jsonErr?.message || jsonErr);
        if (!res.headersSent) {
          res.status(500).json({
            error: 'Failed to serialize chat response',
            message: String(jsonErr?.message || jsonErr),
          });
        }
      }
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
