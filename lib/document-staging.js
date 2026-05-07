const db = require('./db');
const { saveDocument, readDocument, deleteDocument } = require('./storage');

function safeStagingSlug(slug) {
  const s = String(slug || '').replace(/[^a-zA-Z0-9-_]/g, '');
  return s || 'profile';
}

function stagingFolderKey(profileSlug) {
  return `staging__${safeStagingSlug(profileSlug)}`;
}

/**
 * Move staged wizard uploads into `documents` for an activated calculation profile.
 * @returns {Promise<Array<{ staging_id: string, filename: string }>>}
 */
async function promoteStagingToProfile(profileSlug, country_id, provider_id, profile_id, userId) {
  const slug = safeStagingSlug(profileSlug);
  const { rows } = await db.query(
    `SELECT id, filename, storage_path, document_type, description
     FROM document_staging
     WHERE profile_slug = $1
     ORDER BY created_at ASC`,
    [slug]
  );

  const promoted = [];

  const { rows: profRows } = await db.query(
    `SELECT id FROM calculation_profiles WHERE id = $1 AND country_id = $2 AND provider_id = $3`,
    [profile_id, country_id, provider_id]
  );
  if (!profRows.length) {
    throw new Error('calculation_profiles row does not match profile_id, country_id, provider_id.');
  }

  for (const row of rows) {
    const buf = await readDocument(row.storage_path);
    const promotedFilename = `${String(row.id).replace(/-/g, '').slice(0, 12)}_${row.filename}`;
    const storagePath = await saveDocument(profile_id, promotedFilename, buf);

    const ins = await db.query(
      `INSERT INTO documents
         (country_id, provider_id, profile_id, filename, storage_path,
          document_type, description, copyright_status, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)
       RETURNING id`,
      [
        country_id,
        provider_id,
        profile_id,
        promotedFilename,
        storagePath,
        row.document_type,
        row.description || null,
        userId,
      ]
    );

    await deleteDocument(row.storage_path);
    await db.query(`DELETE FROM document_staging WHERE id = $1`, [row.id]);
    promoted.push({
      staging_id: row.id,
      document_id: ins.rows[0].id,
      filename: promotedFilename,
    });
  }

  return promoted;
}

module.exports = {
  safeStagingSlug,
  stagingFolderKey,
  promoteStagingToProfile,
};
