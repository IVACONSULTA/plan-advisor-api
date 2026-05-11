const axios = require('axios');
const db = require('./db');
const { readDocument } = require('./storage');
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
 * Run pipeline: load documents → optional DocIA agent → persist analyses / rules / plans.
 *
 * @returns {Promise<
 *   | { kind: 'success'; payload: object }
 *   | { kind: 'copyright_blocked'; body: object }
 * >}
 */
async function runDocumentAnalysis({ userId, profile_id, document_ids }) {
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
    throw new Error(
      'None of the documents could be read. They may have been deleted from storage. ' +
      'Please re-upload the documents at step 2.'
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
    const { data } = await axios.post(
      `${agentUrl.replace(/\/$/, '')}/analyze`,
      {
        country: countryName,
        provider: providerName,
        documents: documentsWithText,
        existing_rules: existingRules.rows,
        existing_plans: existingPlans.rows,
      },
      {
        headers: process.env.AGENT_API_KEY
          ? { 'X-API-Key': process.env.AGENT_API_KEY }
          : {},
        timeout: 120_000,
      }
    );
    agentResponse = data;
  } catch (agentErr) {
    if (agentErr.response?.status === 451) {
      await db.query(
        `UPDATE documents SET copyright_status = 'blocked', copyright_reason = $1
         WHERE id = ANY($2::uuid[])`,
        [agentErr.response.data?.reason || 'blocked', document_ids]
      );
      return { kind: 'copyright_blocked', body: agentErr.response.data };
    }
    console.warn(
      'DocIA agent unavailable, using stub response:',
      agentErr.message || agentErr
    );
    agentResponse = buildStubAgentResponse(countryName, providerName, documentsWithText);
  }

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

  const analysisId = analysis[0].id;

  if (agentResponse.rules?.length) {
    for (const rule of agentResponse.rules) {
      await db.query(
        `INSERT INTO transaction_rules
           (profile_id, input_key, label, direction, obligation, operation_group,
            pa_transactions_per_item, reason, source_excerpt, confidence, status,
            ai_proposed_value)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'proposed',$11)
         ON CONFLICT (profile_id, input_key) DO UPDATE SET
           label = EXCLUDED.label,
           direction = EXCLUDED.direction,
           obligation = EXCLUDED.obligation,
           operation_group = EXCLUDED.operation_group,
           pa_transactions_per_item = EXCLUDED.pa_transactions_per_item,
           reason = EXCLUDED.reason,
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
          rule.source_excerpt || null,
          rule.confidence || 'medium',
          JSON.stringify({ pa_transactions_per_item: rule.pa_transactions_per_item }),
        ]
      );
    }
  }

  if (agentResponse.plans?.length) {
    for (const plan of agentResponse.plans) {
      await db.query(
        `INSERT INTO plans
           (profile_id, plan_name, included_pa_transactions, annual_fee,
            monthly_fee, extra_transaction_cost, status,
            source_excerpt, confidence)
         VALUES ($1,$2,$3,$4,$5,$6,'proposed',$7,$8)`,
        [
          profile_id,
          plan.plan_name,
          plan.included_pa_transactions,
          plan.annual_fee,
          plan.monthly_fee || null,
          plan.extra_transaction_cost,
          plan.source_excerpt || null,
          plan.confidence || 'medium',
        ]
      );
    }
  }

  await db.query(
    `UPDATE documents SET copyright_status = 'clear'
     WHERE id = ANY($1::uuid[])
       AND copyright_status = 'pending'`,
    [document_ids]
  );

  await logAIUsage({
    userId,
    action: 'document_analysis',
    model: agentResponse.guardrail_audit?.stub ? 'stub-local' : 'doc-agent',
    processingId: agentResponse.guardrail_audit?.processing_id || null,
  });

  return {
    kind: 'success',
    payload: {
      analysis_id: analysisId,
      rules_proposed: agentResponse.rules?.length || 0,
      plans_proposed: agentResponse.plans?.length || 0,
      guardrail_audit: agentResponse.guardrail_audit,
    },
  };
}

module.exports = { runDocumentAnalysis, buildStubAgentResponse };
