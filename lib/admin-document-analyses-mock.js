const fs   = require('fs');
const path = require('path');

const listPath   = path.join(__dirname, '..', 'data', 'admin-mock-document-analyses-list.json');
const detailPath = path.join(__dirname, '..', 'data', 'admin-mock-analysis-detail.json');

let _listCache;
let _detailCache;

/**
 * Check if running on Railway (production) or locally (development)
 */
function isRailwayProduction() {
  return Boolean(
    process.env.RAILWAY_ENVIRONMENT_NAME || 
    process.env.RAILWAY_SERVICE_NAME
  );
}

/**
 * Check if mock data files exist
 */
function mockFilesExist() {
  return fs.existsSync(listPath) && fs.existsSync(detailPath);
}

/**
 * Check if mock data should be used
 */
function shouldUseMockData() {
  // Skip mock data on Railway production
  if (isRailwayProduction()) {
    console.log('[admin-mock] Railway environment detected - skipping mock data');
    return false;
  }
  
  // Check if files exist locally
  if (!mockFilesExist()) {
    console.log('[admin-mock] Mock data files not found - skipping mock data');
    return false;
  }
  
  return true;
}

function mockList() {
  if (!shouldUseMockData()) {
    return [];
  }
  
  if (!_listCache) {
    try {
      _listCache = JSON.parse(fs.readFileSync(listPath, 'utf8'));
      console.log(`[admin-mock] Loaded ${_listCache.length} mock analyses from ${listPath}`);
    } catch (err) {
      console.error('[admin-mock] Failed to load mock list:', err.message);
      _listCache = [];
    }
  }
  return _listCache;
}

function mockDetailBase() {
  if (!shouldUseMockData()) {
    return {
      id: 'mock-analysis-id',
      profile_id: null,
      country: 'Unknown',
      provider: 'Unknown',
      status: 'pending',
      created_at: new Date().toISOString(),
      summary_markdown: 'Mock data not available in production.',
      gaps_and_conflicts: null,
      transaction_rules: [],
    };
  }
  
  if (!_detailCache) {
    try {
      _detailCache = JSON.parse(fs.readFileSync(detailPath, 'utf8'));
      console.log(`[admin-mock] Loaded mock analysis detail from ${detailPath}`);
    } catch (err) {
      console.error('[admin-mock] Failed to load mock detail:', err.message);
      _detailCache = {
        id: 'mock-analysis-id',
        profile_id: null,
        country: 'Unknown',
        provider: 'Unknown',
        status: 'pending',
        created_at: new Date().toISOString(),
        summary_markdown: 'Mock data loading failed.',
        gaps_and_conflicts: null,
        transaction_rules: [],
      };
    }
  }
  return _detailCache;
}

/**
 * Fixture payload for Document Agent analyses (replace when DOC_AGENT_URL flow is complete).
 */
function mockAnalysisDetailForId(requestedId) {
  const base = { ...mockDetailBase() };
  const row = mockList().find((x) => x.id === requestedId);
  if (row) {
    base.id = row.id;
    base.profile_id = row.profile_id;
    base.country = row.country;
    base.provider = row.provider;
    base.status = row.status;
    base.created_at =
      row.created_at && row.created_at.length <= 10
        ? `${row.created_at}T12:00:00.000Z`
        : base.created_at;
  } else {
    base.id = requestedId;
  }
  return base;
}

module.exports = {
  mockList,
  mockDetailBase,
  mockAnalysisDetailForId,
};
