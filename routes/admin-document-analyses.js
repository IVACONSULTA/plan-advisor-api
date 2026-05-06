const express = require('express');
const router  = express.Router();
const { requireAuth, requireAdmin } = require('../lib/supabase');
const { mockList, mockAnalysisDetailForId } = require('../lib/admin-document-analyses-mock');

/**
 * GET /api/admin/document-analyses
 * Mock list until Document Agent persistence is fully integrated.
 */
router.get('/document-analyses', requireAuth, requireAdmin, (_req, res) => {
  res.json({
    success: true,
    mock: true,
    message:
      'Document Agent pipeline not wired yet; returning fixture analyses for UI development.',
    items: mockList(),
  });
});

/**
 * GET /api/admin/document-analyses/:id
 * Mock detail (id echoed; content aligned with list row when id matches).
 */
router.get('/document-analyses/:id', requireAuth, requireAdmin, (req, res) => {
  const { id } = req.params;
  res.json({
    success: true,
    mock: true,
    message:
      'Document Agent pipeline not wired yet; returning fixture analysis detail for UI development.',
    data: mockAnalysisDetailForId(id),
  });
});

module.exports = router;
