DO $$
DECLARE
  pid uuid := '1bd4472a-45d3-4242-a401-397406e049cc';
BEGIN
  DELETE FROM scenarios          WHERE profile_id = pid;
  DELETE FROM document_analyses  WHERE profile_id = pid;
  DELETE FROM plans              WHERE profile_id = pid;
  DELETE FROM transaction_rules  WHERE profile_id = pid;
  DELETE FROM assumptions        WHERE profile_id = pid;
  DELETE FROM documents          WHERE profile_id = pid;
  DELETE FROM calculation_profiles WHERE id = pid;
END $$;

SELECT * FROM transaction_rules WHERE profile_id LIKE "dfb96bfb-30e2-492d-85ec-e6747568655d";