const express   = require('express');
const router    = express.Router();
const axios     = require('axios');
const rateLimit = require('express-rate-limit');
const db        = require('../lib/db');
const { requireAuth }           = require('../lib/supabase');
const { checkAIQuota, logAIUsage } = require('../lib/quota');

const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many summary requests. Please wait a minute.' },
});

/**
 * POST /api/scenarios/:id/generate-summary
 * Admin / Internal / Client (if enabled) — call the Summary Agent (App 4).
 * No recalculation — only passes the saved result to the agent.
 */
router.post(
  '/:id/generate-summary',
  requireAuth,
  checkAIQuota,
  aiLimiter,
  async (req, res) => {
    const { id } = req.params;

    try {
      // 1. Fetch the scenario
      const { rows } = await db.query(
        `SELECT s.*,
                cp.version AS profile_version,
                cp.currency,
                co.name AS country_name,
                pr.name AS provider_name
         FROM scenarios s
         JOIN calculation_profiles cp ON cp.id = s.profile_id
         JOIN countries co            ON co.id = cp.country_id
         JOIN providers pr            ON pr.id = cp.provider_id
         WHERE s.id = $1`,
        [id]
      );

      if (!rows.length) return res.status(404).json({ error: 'Scenario not found.' });

      const scenario = rows[0];

      // Access control — client can only summarise own/company scenarios
      if (req.userRole === 'client') {
        const { rows: up } = await db.query(
          `SELECT company_id FROM users_profile WHERE id = $1`,
          [req.user.id]
        );
        const ownScenario = scenario.created_by === req.user.id;
        const sameCompany = up[0]?.company_id && scenario.company_id === up[0].company_id;
        if (!ownScenario && !sameCompany) {
          return res.status(403).json({ error: 'Access denied.' });
        }
      }

      const result = scenario.result_json;

      // 2. Call Summary Agent (App 4) via internal Railway network
      const { data: agentResponse } = await axios.post(
        `${process.env.SUMMARY_AGENT_URL}/generate-summary`,
        {
          country:              scenario.country_name,
          provider:             scenario.provider_name,
          profile_version:      scenario.profile_version,
          inputs:               scenario.input_json,
          transaction_breakdown: result.transaction_breakdown,
          plan_comparison:      result.plan_comparison,
          recommended_plan:     result.recommended_plan,
          assumptions:          result.assumptions || [],
        },
        {
          headers: { 'X-API-Key': process.env.AGENT_API_KEY },
          timeout: 60_000,
        }
      );

      const summary = agentResponse.summary;

      // 3. Persist the summary
      await db.query(
        `UPDATE scenarios SET ai_summary = $1 WHERE id = $2`,
        [summary, id]
      );

      // 4. Log AI usage
      await logAIUsage({
        userId:     req.user.id,
        action:     'generate_summary',
        model:      'dspy',
        scenarioId: id,
        inputTokens:  agentResponse.usage?.input_tokens  || null,
        outputTokens: agentResponse.usage?.output_tokens || null,
        estimatedCost: agentResponse.usage?.estimated_cost || null,
      });

      res.json({ summary });
    } catch (err) {
      if (err.response) {
        return res.status(err.response.status).json(err.response.data);
      }
      console.error(err);
      res.status(500).json({ error: 'Failed to generate summary.' });
    }
  }
);

module.exports = router;
