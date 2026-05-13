DO $$
DECLARE
  pid uuid := 'e1304b85-3d56-42c7-bc25-76d6bc322a9c';
BEGIN
  DELETE FROM scenarios          WHERE profile_id = pid;
  DELETE FROM document_analyses  WHERE profile_id = pid;
  DELETE FROM plans              WHERE profile_id = pid;
  DELETE FROM transaction_rules  WHERE profile_id = pid;
  DELETE FROM assumptions        WHERE profile_id = pid;
  DELETE FROM documents          WHERE profile_id = pid;
  DELETE FROM calculation_profiles WHERE id = pid;
END $$;