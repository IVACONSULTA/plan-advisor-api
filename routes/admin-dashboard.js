const express = require('express');
const router  = express.Router();
const db      = require('../lib/db');
const { requireAuth, requireAdmin } = require('../lib/supabase');
const { calculatorRuleGroupsCountSelect } = require('../lib/calculator-rules-count');
const { mockList } = require('../lib/admin-document-analyses-mock');

/**
 * GET /api/admin/dashboard
 * Admin home aggregates: DB-backed profiles, documents, scenarios + mock document analyses block.
 */
router.get('/dashboard', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows: statusRows } = await db.query(
      `SELECT status, COUNT(*)::int AS n
       FROM calculation_profiles
       GROUP BY status`
    );
    const byStatus = Object.fromEntries(statusRows.map((r) => [r.status, r.n]));
    const activeCount = byStatus.active ?? 0;
    const draftCount = byStatus.draft ?? 0;
    const pendingApprovalCount = byStatus.pending_approval ?? 0;

    const mockAnalyses = mockList();
    const analysesPendingMock = mockAnalyses.filter((a) => a.status === 'pending_review').length;

    const { rows: profileRows } = await db.query(
      `SELECT cp.id, cp.version, cp.status, cp.currency, cp.active_from,
              co.code AS country_code, co.name AS country_name,
              pr.name AS provider_name, pr.type AS provider_type,
              ${calculatorRuleGroupsCountSelect()} AS rules_count,
              (SELECT COUNT(*)::int FROM plans pl
                 WHERE pl.profile_id = cp.id AND pl.status = 'approved') AS plans_count,
              (SELECT da.id::text FROM document_analyses da
                 WHERE da.profile_id = cp.id AND da.status = 'pending_review'
                 ORDER BY da.created_at DESC LIMIT 1) AS pending_analysis_id
       FROM calculation_profiles cp
       JOIN countries co ON co.id = cp.country_id
       JOIN providers pr ON pr.id = cp.provider_id
       ORDER BY co.name, pr.name`
    );

    const profiles = profileRows.map((p) => ({
      id: p.id,
      country: { code: p.country_code, name: p.country_name },
      provider: { name: p.provider_name, type: p.provider_type },
      version: p.version,
      currency: p.currency,
      status: p.status,
      active_from: p.active_from,
      rules_count: p.rules_count,
      plans_count: p.plans_count,
      analysis_id: p.pending_analysis_id,
    }));

    const { rows: docRows } = await db.query(
      `SELECT d.id, d.filename, d.copyright_status, d.created_at
       FROM documents d
       ORDER BY d.created_at DESC
       LIMIT 8`
    );
    const recent_documents = docRows.map((d) => ({
      id: d.id,
      filename: d.filename,
      copyright_status: d.copyright_status,
      uploaded_at: d.created_at,
    }));

    const { rows: recentScenarios } = await db.query(
      `SELECT s.id, s.client_name, s.created_at,
              s.ai_summary IS NOT NULL AS has_summary,
              s.result_json->'recommended_plan'->>'plan_name' AS recommended_plan,
              (s.result_json->'recommended_plan'->>'total_annual_cost')::numeric AS total_annual_cost,
              co.name AS country_name, pr.name AS provider_name, cp.version
       FROM scenarios s
       JOIN calculation_profiles cp ON cp.id = s.profile_id
       JOIN countries co ON co.id = cp.country_id
       JOIN providers pr ON pr.id = cp.provider_id
       ORDER BY s.created_at DESC
       LIMIT 8`
    );

    const scenarioRows = recentScenarios.map((s) => ({
      id: s.id,
      client_name: s.client_name,
      created_at: s.created_at,
      has_summary: Boolean(s.has_summary),
      recommended_plan: s.recommended_plan,
      total_annual_cost: s.total_annual_cost,
      country_name: s.country_name,
      provider_name: s.provider_name,
      version: s.version,
    }));

    res.json({
      success: true,
      kpis: {
        active_profiles: activeCount,
        profiles_in_progress: draftCount + pendingApprovalCount,
        analyses_pending_review: analysesPendingMock,
        archived_profiles: byStatus.archived ?? 0,
      },
      profiles,
      recent_documents,
      recent_scenarios: scenarioRows,
      document_analyses: {
        success: true,
        mock: true,
        message:
          'Document Agent pipeline not wired yet; returning fixture analyses for UI development.',
        items: mockAnalyses,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Failed to load admin dashboard.' });
  }
});

module.exports = router;
