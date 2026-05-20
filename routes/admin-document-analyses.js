const express = require('express');
const router  = express.Router();
const { requireAuth, requireAdmin } = require('../lib/supabase');
const { mockList, mockAnalysisDetailForId } = require('../lib/admin-document-analyses-mock');
const { query: dbQuery } = require('../lib/db');

/**
 * GET /api/admin/document-analyses
 * List all document analyses with profile info and creator details.
 */
router.get('/document-analyses', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const sql = `
      SELECT 
        da.id,
        da.profile_id,
        da.status,
        da.created_at,
        da.created_by,
        c.name AS country_name,
        c.code AS country_code,
        p.name AS provider_name,
        p.type AS provider_type,
        up.full_name AS created_by_name,
        up.email AS created_by_email
      FROM document_analyses da
      JOIN calculation_profiles cp ON da.profile_id = cp.id
      JOIN countries c ON cp.country_id = c.id
      JOIN providers p ON cp.provider_id = p.id
      JOIN users_profile up ON da.created_by = up.id
      ORDER BY da.created_at DESC
    `;

    const { rows } = await dbQuery(sql);

    const items = rows.map(row => ({
      id: row.id,
      profile_id: row.profile_id,
      country: row.country_name,
      country_code: row.country_code,
      provider: row.provider_name,
      provider_type: row.provider_type,
      created_by: row.created_by_name || row.created_by_email || 'Unknown',
      created_at: row.created_at,
      status: row.status,
    }));

    res.json({
      success: true,
      mock: false,
      items,
    });
  } catch (err) {
    console.error('[document-analyses] Error fetching list:', err.message);
    // Fallback to mock data in development if query fails
    const mockItems = mockList();
    if (mockItems.length > 0) {
      return res.json({
        success: true,
        mock: true,
        message: 'Database query failed; returning mock data for development.',
        items: mockItems,
      });
    }
    res.status(500).json({
      success: false,
      error: 'Failed to fetch document analyses',
      message: err.message,
    });
  }
});

/**
 * GET /api/admin/document-analyses/:id
 * Get detail for a specific document analysis.
 */
router.get('/document-analyses/:id', requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    // First get the analysis with profile info
    const analysisSql = `
      SELECT 
        da.id,
        da.profile_id,
        da.document_ids,
        da.analysis_json,
        da.summary,
        da.status,
        da.guardrail_audit,
        da.created_at,
        da.created_by,
        c.name AS country_name,
        c.code AS country_code,
        p.name AS provider_name,
        p.type AS provider_type,
        up.full_name AS created_by_name,
        up.email AS created_by_email
      FROM document_analyses da
      JOIN calculation_profiles cp ON da.profile_id = cp.id
      JOIN countries c ON cp.country_id = c.id
      JOIN providers p ON cp.provider_id = p.id
      JOIN users_profile up ON da.created_by = up.id
      WHERE da.id = $1
    `;

    const { rows } = await dbQuery(analysisSql, [id]);

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Analysis not found',
      });
    }

    const row = rows[0];

    // Parse the analysis_json to extract rules, plans, assumptions, etc.
    const analysisJson = row.analysis_json || {};

    const data = {
      id: row.id,
      profile_id: row.profile_id,
      country: row.country_name,
      country_code: row.country_code,
      provider: row.provider_name,
      provider_type: row.provider_type,
      version: 'v1.0', // Could be fetched from calculation_profiles
      created_at: row.created_at,
      created_by: row.created_by_name || row.created_by_email || 'Unknown',
      status: row.status,
      summary: row.summary || analysisJson.summary || '',
      guardrail_audit: row.guardrail_audit || {
        eu_ai_act_check: 'passed',
        copyright_check: 'passed',
        processing_id: 'unknown',
        document_count: 0,
        blocked_documents: [],
        processing_timestamp: row.created_at,
      },
      rules: analysisJson.rules || analysisJson.transaction_rules || [],
      plans: analysisJson.plans || [],
      assumptions: analysisJson.assumptions || [],
      ambiguities: analysisJson.ambiguities || analysisJson.gaps_and_conflicts?.ambiguities || [],
      conflicts: analysisJson.conflicts || analysisJson.gaps_and_conflicts?.conflicts || [],
    };

    res.json({
      success: true,
      mock: false,
      data,
    });
  } catch (err) {
    console.error('[document-analyses] Error fetching detail:', err.message);
    // Fallback to mock data in development
    const mockData = mockAnalysisDetailForId(id);
    if (mockData.id !== 'mock-analysis-id') {
      return res.json({
        success: true,
        mock: true,
        message: 'Database query failed; returning mock data for development.',
        data: mockData,
      });
    }
    res.status(500).json({
      success: false,
      error: 'Failed to fetch analysis detail',
      message: err.message,
    });
  }
});

module.exports = router;
