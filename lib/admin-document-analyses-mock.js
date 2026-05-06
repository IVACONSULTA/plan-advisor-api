const fs   = require('fs');
const path = require('path');

const listPath   = path.join(__dirname, '..', 'data', 'admin-mock-document-analyses-list.json');
const detailPath = path.join(__dirname, '..', 'data', 'admin-mock-analysis-detail.json');

let _listCache;
let _detailCache;

function mockList() {
  if (!_listCache) {
    _listCache = JSON.parse(fs.readFileSync(listPath, 'utf8'));
  }
  return _listCache;
}

function mockDetailBase() {
  if (!_detailCache) {
    _detailCache = JSON.parse(fs.readFileSync(detailPath, 'utf8'));
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
