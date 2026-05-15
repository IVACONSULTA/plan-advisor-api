DO $$
DECLARE
  pid uuid := '57ca9717-5789-4c22-8bdf-9b4af00a0d83';
BEGIN
  DELETE FROM scenarios          WHERE profile_id = pid;
  DELETE FROM document_analyses  WHERE profile_id = pid;
  DELETE FROM plans              WHERE profile_id = pid;
  DELETE FROM transaction_rules  WHERE profile_id = pid;
  DELETE FROM assumptions        WHERE profile_id = pid;
  DELETE FROM documents          WHERE profile_id = pid;
  DELETE FROM calculation_profiles WHERE id = pid;
END $$;

