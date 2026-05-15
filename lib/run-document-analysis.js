const axios = require('axios');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const { readDocument, DOCS_PATH, shouldUseS3 } = require('./storage');
const { extractText } = require('./document-text-extract');
const { logAIUsage } = require('./quota');

function buildStubAgentResponse(countryName, providerName, documentsWithText) {
  const snippet = (documentsWithText[0]?.text || '').replace(/\s+/g, ' ').trim().slice(0, 400);
  return {
    summary: `Local stub analysis for ${countryName} / ${providerName} (set DOC_AGENT_URL for full DocIA).`,
    rules: [
      {
        input_key: 'issued_einvoicing',
        label: 'Issued e-invoicing invoices / year (stub)',
        direction: 'Issued',
        obligation: 'E-invoicing',
        operation_group: 'Domestic B2B',
        pa_transactions_per_item: 1.5,
        reason: 'Generated because DOC_AGENT_URL is unset or the agent request failed.',
        source_excerpt: snippet || 'No text extracted from documents.',
        confidence: 'medium',
      },
    ],
    plans: [
      {
        plan_name: 'Standard bundle (stub)',
        included_pa_transactions: 10000,
        annual_fee: 1200,
        monthly_fee: 100,
        extra_transaction_cost: 0.05,
        source_excerpt: 'stub plan',
        confidence: 'medium',
      },
    ],
    guardrail_audit: { stub: true, local: true },
  };
}

/**
 * Replace every string value "null" with actual null, recursively.
 * LLMs commonly emit placeholder `"null"` strings; this normalises them.
 */
function deepNullify(value) {
  if (value === 'null') return null;
  if (Array.isArray(value)) return value.map(deepNullify);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = deepNullify(v);
    }
    return out;
  }
  return value;
}

/**
 * Unwrap the agent response envelope.
 *
 * The document agent wraps its structured output in a JSON object:
 *   { "output": "<stringified inner JSON>" }
 *
 * This mirrors the logic in scripts/parse_nested_output.py:
 *  1. If the response is an object with an `output` string → JSON.parse the string.
 *  2. If `output` is already an object → use it directly.
 *  3. If the response already contains `transaction_rules` → treat as already unwrapped.
 *  4. After unwrapping, replace all string "null" values with actual null.
 */
function unwrapAgentResponse(raw) {
  let inner = raw;

  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    if (typeof raw.output === 'string') {
      console.log('[runDocumentAnalysis] Unwrapping agent envelope: parsing raw.output string');
      try {
        inner = JSON.parse(raw.output);
      } catch (parseErr) {
        console.error('[runDocumentAnalysis] Failed to parse raw.output string:', parseErr.message);
        console.error('[runDocumentAnalysis] raw.output (first 500 chars):', raw.output.slice(0, 500));
        throw new Error(`Agent returned an unparseable output string: ${parseErr.message}`);
      }
    } else if (raw.output && typeof raw.output === 'object') {
      console.log('[runDocumentAnalysis] Unwrapping agent envelope: raw.output is already an object');
      inner = raw.output;
    } else if (!('output' in raw)) {
      console.log('[runDocumentAnalysis] Agent response has no envelope — using as-is');
    }
  }

  return deepNullify(inner);
}

/**
 * Pretty-print the document agent JSON to stdout (Railway / local logs).
 * DOC_AGENT_LOG_RESPONSE=false disables. DOC_AGENT_LOG_RESPONSE_MAX_CHARS caps size (default 100000).
 */
function logDocumentAgentResponse(source, data) {
  const enabled = String(process.env.DOC_AGENT_LOG_RESPONSE ?? 'true').toLowerCase();
  if (enabled === '0' || enabled === 'false' || enabled === 'no') return;

  const maxChars = parseInt(process.env.DOC_AGENT_LOG_RESPONSE_MAX_CHARS || '100000', 10);

  try {
    const rulesN = Array.isArray(data?.rules) ? data.rules.length : 0;
    const plansN = Array.isArray(data?.plans) ? data.plans.length : 0;
    const keys =
      data && typeof data === 'object' && !Array.isArray(data)
        ? Object.keys(data).join(', ')
        : typeof data;
    const summaryLen = typeof data?.summary === 'string' ? data.summary.length : 0;
    console.log(
      `[runDocumentAnalysis] ${source} — summary: keys=[${keys}] rules=${rulesN} plans=${plansN} summaryChars=${summaryLen}`,
    );

    const text = JSON.stringify(data, null, 2);
    if (text.length > maxChars) {
      console.log(
        `[runDocumentAnalysis] ${source} — JSON body (${text.length} chars, truncated to ${maxChars}; raise DOC_AGENT_LOG_RESPONSE_MAX_CHARS to see more):`,
      );
      console.log(text.slice(0, maxChars));
      console.log(`[runDocumentAnalysis] ${source} — … [truncated ${text.length - maxChars} chars]`);
    } else {
      console.log(`[runDocumentAnalysis] ${source} — JSON body (${text.length} chars):`);
      console.log(text);
    }
  } catch (e) {
    console.warn(`[runDocumentAnalysis] Could not log ${source}:`, e?.message || e);
  }
}

/**
 * Run pipeline: load documents → optional DocIA agent → persist analyses / rules / plans.
 *
 * @param {Object} params
 * @param {string} params.userId
 * @param {string} params.profile_id
 * @param {string[]} params.document_ids
 * @param {string} [params.message] - Custom analysis message/prompt for the agent
 * @param {string} [params.existingAnalysisId] - When provided, the function UPDATEs this
 *   `document_analyses` row instead of inserting a new one. Used by the async API route
 *   to create a `running` row up front and finalize it on completion.
 *
 * @returns {Promise<
 *   | { kind: 'success'; payload: object }
 *   | { kind: 'copyright_blocked'; body: object }
 * >}
 */
async function runDocumentAnalysis({ userId, profile_id, document_ids, message = '', existingAnalysisId = null }) {
  const { rows: docs } = await db.query(
    `SELECT d.*, cp.country_id, cp.provider_id,
            co.name AS country_name, pr.name AS provider_name
     FROM documents d
     JOIN calculation_profiles cp ON cp.id = d.profile_id
     JOIN countries  co ON co.id = cp.country_id
     JOIN providers  pr ON pr.id = cp.provider_id
     WHERE d.id = ANY($1::uuid[]) AND d.profile_id = $2`,
    [document_ids, profile_id]
  );

  if (!docs.length) {
    throw new Error('No documents found for the given IDs.');
  }

  const maxChars = parseInt(process.env.MAX_CHARS_PER_DOC || '20000', 10);
  const results = await Promise.all(
    docs.map(async (doc) => {
      console.log(`[runDocumentAnalysis] Processing doc ${doc.id}: ${doc.filename}`);
      console.log(`[runDocumentAnalysis]   Storage path: ${doc.storage_path}`);
      
      try {
        const buffer = await readDocument(doc.storage_path);
        console.log(`[runDocumentAnalysis]   Read ${buffer.length} bytes`);
        
        const text = await extractText(buffer, doc.filename);
        console.log(`[runDocumentAnalysis]   Extracted ${text.length} chars of text`);
        
        return {
          filename: doc.filename,
          text: text.slice(0, maxChars),
          source_url: null,
          declared_license: null,
        };
      } catch (readErr) {
        console.warn(`[runDocumentAnalysis] Skipping doc ${doc.id} (${doc.filename}): ${readErr.message}`);
        return null;
      }
    })
  );

  const documentsWithText = results.filter(Boolean);

  if (!documentsWithText.length) {
    const failedPaths = docs.map((d) => d.storage_path).join(', ');
    let hint = '';
    if (!shouldUseS3()) {
      const baseExists = fs.existsSync(DOCS_PATH);
      if (!baseExists) {
        hint =
          ` The storage base directory ${DOCS_PATH} does not exist — ` +
          `the Railway Volume is most likely NOT attached to this service. ` +
          `Go to your Railway service → Volumes and attach a volume mounted at /data (or set DOCUMENTS_PATH). ` +
          `After attaching the volume, re-upload the documents.`;
      } else {
        const profileDir = path.join(DOCS_PATH, profile_id);
        const dirExists = fs.existsSync(profileDir);
        hint = dirExists
          ? ` The profile directory ${profileDir} exists but the specific files are missing — ` +
            `they may have been uploaded before the Railway Volume was attached (written to ephemeral storage) ` +
            `and lost on the last restart. Please re-upload the documents.`
          : ` The profile directory ${profileDir} does not exist — ` +
            `the Railway Volume was likely not attached when the files were uploaded. ` +
            `Attach a Railway Volume mounted at /data and re-upload the documents.`;
      }
    }
    throw new Error(
      `None of the documents could be read from storage. ` +
      `Expected paths: [${failedPaths}].${hint}`
    );
  }

  const [existingRules, existingPlans] = await Promise.all([
    db.query(`SELECT * FROM transaction_rules WHERE profile_id = $1`, [profile_id]),
    db.query(`SELECT * FROM plans WHERE profile_id = $1`, [profile_id]),
  ]);

  const countryName = docs[0].country_name;
  const providerName = docs[0].provider_name;

  let agentResponse;
  const agentUrl = (process.env.DOC_AGENT_URL || '').trim();

  try {
    if (!agentUrl) {
      throw new Error('NO_DOC_AGENT_URL');
    }
    const agentTimeoutMs = parseInt(process.env.DOC_AGENT_TIMEOUT_MS || '290000', 10);

    // Build the request payload for the document agent
    const agentPayload = {
      country: countryName,
      provider: providerName,
      documents: documentsWithText,
      existing_rules: existingRules.rows,
      existing_plans: existingPlans.rows,
    };

    // Include custom analysis message if provided
    if (message && message.trim()) {
      agentPayload.message = message.trim();
    }

    console.log(`[runDocumentAnalysis] Calling DocIA agent at ${agentUrl}/analyze`);
    if (message) {
      console.log(`[runDocumentAnalysis] With custom message: ${message.slice(0, 100)}...`);
    }

    const { data } = await axios.post(
      `${agentUrl.replace(/\/$/, '')}/analyze`,
      agentPayload,
      {
        headers: process.env.AGENT_API_KEY
          ? { 'X-API-Key': process.env.AGENT_API_KEY }
          : {},
        timeout: agentTimeoutMs,
      }
    );
    agentResponse = unwrapAgentResponse(data);
    logDocumentAgentResponse('Doc agent HTTP 200 response (unwrapped)', agentResponse);
  } catch (agentErr) {
    if (agentErr.response?.status === 451) {
      await db.query(
        `UPDATE documents SET copyright_status = 'blocked', copyright_reason = $1
         WHERE id = ANY($2::uuid[])`,
        [agentErr.response.data?.reason || 'blocked', document_ids]
      );
      logDocumentAgentResponse('Doc agent HTTP 451 (copyright blocked)', agentErr.response.data);
      return { kind: 'copyright_blocked', body: agentErr.response.data };
    }
    if (agentErr.response?.data != null) {
      logDocumentAgentResponse(
        `Doc agent error response HTTP ${agentErr.response.status}`,
        agentErr.response.data,
      );
    } else {
      console.warn(
        '[runDocumentAnalysis] Doc agent error (no response body):',
        agentErr.message || agentErr,
      );
    }
    console.warn(
      'DocIA agent unavailable, using stub response:',
      agentErr.message || agentErr
    );
    agentResponse = buildStubAgentResponse(countryName, providerName, documentsWithText);
    logDocumentAgentResponse('Stub agent response (fallback)', agentResponse);
  }

  // ─── Normalise agent response keys ────────────────────────────────────────
  // Agent returns `transaction_rules` (new) or `rules` (legacy/stub).
  const rulesArray = Array.isArray(agentResponse.transaction_rules)
    ? agentResponse.transaction_rules
    : Array.isArray(agentResponse.rules)
      ? agentResponse.rules
      : [];
  const plansArray = Array.isArray(agentResponse.plans) ? agentResponse.plans : [];
  const assumptionsArray = Array.isArray(agentResponse.assumptions) ? agentResponse.assumptions : [];

  console.log(
    `[persist] Agent response normalised — ` +
    `rules: ${rulesArray.length}, plans: ${plansArray.length}, assumptions: ${assumptionsArray.length}`
  );

  // ─── Source document resolution ────────────────────────────────────────────
  // Build filename → UUID map. Stored filenames may have a timestamp prefix
  // (e.g. `1a2b3c_original.pdf`), so we do exact-then-suffix/contains matching.
  const docByFilename = {};
  for (const doc of docs) {
    docByFilename[doc.filename] = doc.id;
  }
  console.log(`[persist] Document filename map: ${Object.keys(docByFilename).join(' | ')}`);

  function resolveSourceDocId(sourceExcerpt) {
    if (!sourceExcerpt || typeof sourceExcerpt !== 'string') return null;
    if (docByFilename[sourceExcerpt]) return docByFilename[sourceExcerpt];
    for (const [storedName, id] of Object.entries(docByFilename)) {
      if (storedName.includes(sourceExcerpt) || storedName.endsWith(`_${sourceExcerpt}`)) return id;
    }
    return null;
  }

  // ─── 1. Persist / update document_analyses row ────────────────────────────
  console.log(`[persist] Step 1 — document_analyses row (analysis_id: ${existingAnalysisId || 'new'})`);
  let analysisId;
  if (existingAnalysisId) {
    const { rows: analysis } = await db.query(
      `UPDATE document_analyses
         SET analysis_json = $2,
             summary = $3,
             status = 'completed',
             guardrail_audit = $4
       WHERE id = $1
       RETURNING id, status, created_at`,
      [
        existingAnalysisId,
        JSON.stringify(agentResponse),
        agentResponse.summary || null,
        JSON.stringify(agentResponse.guardrail_audit || {}),
      ]
    );
    if (!analysis.length) {
      throw new Error(`document_analyses row ${existingAnalysisId} not found.`);
    }
    analysisId = analysis[0].id;
    console.log(`[persist]   → Updated document_analyses ${analysisId} → status=completed`);
  } else {
    const { rows: analysis } = await db.query(
      `INSERT INTO document_analyses
         (profile_id, document_ids, analysis_json, summary, status, guardrail_audit, created_by)
       VALUES ($1, $2, $3, $4, 'completed', $5, $6)
       RETURNING id, status, created_at`,
      [
        profile_id,
        document_ids,
        JSON.stringify(agentResponse),
        agentResponse.summary || null,
        JSON.stringify(agentResponse.guardrail_audit || {}),
        userId,
      ]
    );
    analysisId = analysis[0].id;
    console.log(`[persist]   → Inserted document_analyses ${analysisId} → status=completed`);
  }

  // ─── 2. Persist transaction_rules ─────────────────────────────────────────
  console.log(`[persist] Step 2 — transaction_rules (${rulesArray.length} rule(s))`);
  let rulesInserted = 0, rulesUpdated = 0;
  for (const rule of rulesArray) {
    const sourceDocId = resolveSourceDocId(rule.source_excerpt);
    console.log(
      `[persist]   rule "${rule.input_key}" | label="${rule.label}" | ` +
      `pa_per_item=${rule.pa_transactions_per_item} | confidence=${rule.confidence} | ` +
      `source_doc_id=${sourceDocId || 'null (unresolved)'} | source_excerpt="${rule.source_excerpt}"`
    );
    const { rowCount } = await db.query(
      `INSERT INTO transaction_rules
         (profile_id, input_key, label, direction, obligation, operation_group,
          pa_transactions_per_item, reason, source_document_id, source_excerpt,
          confidence, status, ai_proposed_value)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'proposed',$12)
       ON CONFLICT (profile_id, input_key) DO UPDATE SET
         label = EXCLUDED.label,
         direction = EXCLUDED.direction,
         obligation = EXCLUDED.obligation,
         operation_group = EXCLUDED.operation_group,
         pa_transactions_per_item = EXCLUDED.pa_transactions_per_item,
         reason = EXCLUDED.reason,
         source_document_id = EXCLUDED.source_document_id,
         source_excerpt = EXCLUDED.source_excerpt,
         confidence = EXCLUDED.confidence,
         status = 'proposed',
         ai_proposed_value = EXCLUDED.ai_proposed_value`,
      [
        profile_id,
        rule.input_key,
        rule.label,
        rule.direction,
        rule.obligation,
        rule.operation_group,
        rule.pa_transactions_per_item,
        rule.reason,
        sourceDocId,
        rule.source_excerpt || null,
        rule.confidence || 'medium',
        JSON.stringify({ pa_transactions_per_item: rule.pa_transactions_per_item }),
      ]
    );
    if (rowCount > 0) rulesInserted++;
    else rulesUpdated++;
  }
  console.log(`[persist]   → transaction_rules done: ${rulesInserted} inserted / ${rulesUpdated} updated`);

  // ─── 3. Persist plans ─────────────────────────────────────────────────────
  console.log(`[persist] Step 3 — plans (${plansArray.length} plan(s))`);
  let plansInserted = 0;
  for (const plan of plansArray) {
    const sourceDocId = resolveSourceDocId(plan.source_excerpt);
    console.log(
      `[persist]   plan "${plan.plan_name}" | included_tx=${plan.included_pa_transactions} | ` +
      `annual_fee=${plan.annual_fee} | monthly_fee=${plan.monthly_fee ?? 'null'} | ` +
      `extra_tx_cost=${plan.extra_transaction_cost} | confidence=${plan.confidence} | ` +
      `source_doc_id=${sourceDocId || 'null (unresolved)'}`
    );
    await db.query(
      `INSERT INTO plans
         (profile_id, plan_name, included_pa_transactions, annual_fee,
          monthly_fee, extra_transaction_cost, status,
          source_document_id, source_excerpt, confidence)
       VALUES ($1,$2,$3,$4,$5,$6,'proposed',$7,$8,$9)`,
      [
        profile_id,
        plan.plan_name,
        plan.included_pa_transactions,
        plan.annual_fee,
        plan.monthly_fee || null,
        plan.extra_transaction_cost,
        sourceDocId,
        plan.source_excerpt || null,
        plan.confidence || 'medium',
      ]
    );
    plansInserted++;
  }
  console.log(`[persist]   → plans done: ${plansInserted} inserted`);

  // ─── 4. Persist assumptions ───────────────────────────────────────────────
  console.log(`[persist] Step 4 — assumptions (${assumptionsArray.length} assumption(s))`);
  let assumptionsInserted = 0, assumptionsSkipped = 0;
  for (const assumption of assumptionsArray) {
    const sourceDocId = resolveSourceDocId(assumption.source_excerpt);
    console.log(
      `[persist]   assumption key="${assumption.key}" | value="${String(assumption.value).slice(0, 80)}" | ` +
      `source_doc_id=${sourceDocId || 'null (unresolved)'}`
    );
    const { rowCount } = await db.query(
      `INSERT INTO assumptions
         (profile_id, key, value, reason, status, source_document_id)
       VALUES ($1,$2,$3,$4,'proposed',$5)
       ON CONFLICT DO NOTHING`,
      [
        profile_id,
        assumption.key,
        assumption.value,
        assumption.reason || null,
        sourceDocId,
      ]
    );
    if (rowCount > 0) assumptionsInserted++;
    else assumptionsSkipped++;
  }
  console.log(
    `[persist]   → assumptions done: ${assumptionsInserted} inserted, ${assumptionsSkipped} skipped (already exist)`
  );

  // ─── 5. Mark documents as cleared ─────────────────────────────────────────
  console.log(`[persist] Step 5 — marking ${document_ids.length} document(s) as copyright_status=clear`);
  const { rowCount: clearedCount } = await db.query(
    `UPDATE documents SET copyright_status = 'clear'
     WHERE id = ANY($1::uuid[])
       AND copyright_status = 'pending'`,
    [document_ids]
  );
  console.log(`[persist]   → ${clearedCount} document(s) updated to clear`);

  // ─── 6. Log AI usage ──────────────────────────────────────────────────────
  console.log(`[persist] Step 6 — logging AI usage (model: ${agentResponse.guardrail_audit?.stub ? 'stub-local' : 'doc-agent'})`);
  await logAIUsage({
    userId,
    action: 'document_analysis',
    model: agentResponse.guardrail_audit?.stub ? 'stub-local' : 'doc-agent',
    processingId: agentResponse.guardrail_audit?.processing_id || null,
  });

  // ─── Summary ──────────────────────────────────────────────────────────────
  console.log(
    `[persist] ✓ All done for profile ${profile_id} — ` +
    `analysis_id=${analysisId} | rules=${rulesInserted}ins/${rulesUpdated}upd | ` +
    `plans=${plansInserted}ins | assumptions=${assumptionsInserted}ins/${assumptionsSkipped}skip`
  );

  return {
    kind: 'success',
    payload: {
      analysis_id: analysisId,
      rules_proposed: rulesArray.length,
      plans_proposed: plansArray.length,
      assumptions_proposed: assumptionsArray.length,
      guardrail_audit: agentResponse.guardrail_audit,
    },
  };
}

module.exports = { runDocumentAnalysis, buildStubAgentResponse };
