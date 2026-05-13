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

/** In-memory jobs for async analysis (avoids long-held HTTP through Netlify → Railway). */
const jobs = new Map();
const JOB_TTL_MS = 45 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [id, row] of jobs) {
    if (now - row.createdAt > JOB_TTL_MS) jobs.delete(id);
  }
}, 5 * 60 * 1000).unref();

function mapRuleRow(r, i) {
  return {
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
  };
}

function buildClientPayload(rawOutput, documents) {
  let assistant = '';
  let rules = [];
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
  return {
    assistant,
    rules,
    raw_output: rawOutput,
    documents_used: documents.map((d) => d.filename),
  };
}

/**
 * Resolve documents and build the JSON body for POST /analyze.
 * @returns {{ ok: true, agentPayload, documents, agentUrl } | { ok: false, status, body }}
 */
async function prepareChatAgentPayload({ message, profileId, countryName, providerName }) {
  const agentUrl = (process.env.DOC_AGENT_URL || '').trim().replace(/\/$/, '');
  if (!agentUrl) {
    return {
      ok: false,
      status: 503,
      body: {
        error: 'Crew service unavailable',
        message: 'DOC_AGENT_URL is not configured on the API server.',
        demo: true,
      },
    };
  }

  let resolvedProfileId = profileId;
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(profileId);

  if (!isUuid) {
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
    return {
      ok: false,
      status: 400,
      body: {
        error: 'No documents',
        message: `No documents found for profile "${profileId}". Upload files at step 2 first.`,
      },
    };
  }

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
      return {
        ok: false,
        status: 400,
        body: {
          error: 'No readable documents',
          message: 'None of the uploaded documents could be read. Please re-upload the files at step 2.',
        },
      };
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

  return { ok: true, agentPayload, documents, agentUrl };
}

async function callAgentAndBuildResponse(agentUrl, agentPayload, documents) {
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
      `(timeout_ms=${agentTimeoutMs}, doc_slots=${docCount}, message_len=${String(agentPayload.message || '').length})`
  );

  const agentStarted = Date.now();
  let agentData;
  try {
    const agentHeaders = {
      'X-Correlation-Id': correlationId,
      ...(process.env.AGENT_API_KEY ? { 'X-API-Key': process.env.AGENT_API_KEY } : {}),
    };
    const axRes = await axios.post(`${agentUrl}/analyze`, agentPayload, {
      headers: agentHeaders,
      timeout: agentTimeoutMs,
      maxBodyLength: 25 * 1024 * 1024,
      maxContentLength: 25 * 1024 * 1024,
    });
    agentData = axRes.data;
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

  const rawOutput = String(agentData?.output ?? '');
  const payload = buildClientPayload(rawOutput, documents);
  console.log(
    `[ai-analysis/chat] correlationId=${correlationId} built client payload ` +
      `(rules=${payload.rules.length}, assistant_len=${payload.assistant.length})`
  );
  return payload;
}

async function runChatJob(jobId, prep) {
  const started = jobs.get(jobId)?.createdAt ?? Date.now();
  try {
    const payload = await callAgentAndBuildResponse(prep.agentUrl, prep.agentPayload, prep.documents);
    jobs.set(jobId, {
      state: 'completed',
      createdAt: started,
      completedAt: Date.now(),
      result: payload,
    });
    console.log(`[ai-analysis/chat] job ${jobId} completed`);
  } catch (err) {
    if (err.response?.status) {
      jobs.set(jobId, {
        state: 'failed',
        createdAt: started,
        completedAt: Date.now(),
        httpStatus: err.response.status,
        error: {
          error: 'Crew error',
          message:
            typeof err.response.data?.detail === 'string'
              ? err.response.data.detail
              : JSON.stringify(err.response.data),
        },
      });
    } else {
      jobs.set(jobId, {
        state: 'failed',
        createdAt: started,
        completedAt: Date.now(),
        httpStatus: 500,
        error: { error: String(err.message || err) },
      });
    }
    console.error(`[ai-analysis/chat] job ${jobId} failed:`, err.message || err);
  }
}

/**
 * POST /api/admin/ai-analysis/chat
 * Body: { message, profileId, countryName?, providerName? }
 *
 * With header `X-Async-Analysis: 1`, returns 202 + `{ job_id }` immediately and finishes work
 * in-process; poll GET /api/admin/ai-analysis/chat/jobs/:jobId until `status` is `completed`.
 * (Avoids Netlify/proxy idle timeouts on a single long request.)
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
      const wantAsync = String(req.get('x-async-analysis') || '').trim() === '1';

      if (!message) {
        return res.status(400).json({ error: 'message is required.' });
      }
      if (!profileId) {
        return res.status(400).json({ error: 'profileId is required.' });
      }

      const prep = await prepareChatAgentPayload({
        message,
        profileId,
        countryName,
        providerName,
      });
      if (!prep.ok) {
        return res.status(prep.status).json(prep.body);
      }

      if (wantAsync) {
        const jobId = crypto.randomUUID();
        jobs.set(jobId, { state: 'pending', createdAt: Date.now() });
        setImmediate(() => {
          void runChatJob(jobId, prep);
        });
        return res.status(202).json({
          job_id: jobId,
          poll_after_ms: 1500,
          message:
            'Analysis started. Poll GET /api/admin/ai-analysis/chat/jobs/<job_id> until status is completed.',
        });
      }

      const payload = await callAgentAndBuildResponse(prep.agentUrl, prep.agentPayload, prep.documents);
      try {
        res.json(payload);
        console.log('[ai-analysis/chat] sent JSON to client (sync path)');
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

/**
 * GET /api/admin/ai-analysis/chat/jobs/:jobId
 * Poll for async job started via POST …/chat with X-Async-Analysis: 1.
 */
router.get(
  '/ai-analysis/chat/jobs/:jobId',
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const jobId = String(req.params.jobId || '').trim();
    const row = jobs.get(jobId);
    if (!row) {
      return res.status(404).json({ error: 'Unknown job_id', message: 'Job expired or invalid.' });
    }
    if (row.state === 'pending') {
      return res.status(200).json({ status: 'pending', job_id: jobId });
    }
    if (row.state === 'completed') {
      return res.status(200).json({ status: 'completed', job_id: jobId, ...row.result });
    }
    // Always 200 so BFF polling can parse JSON; check `status === 'failed'` and `http_status`.
    return res.status(200).json({
      status: 'failed',
      job_id: jobId,
      http_status: row.httpStatus || 500,
      ...row.error,
    });
  }
);

module.exports = router;
