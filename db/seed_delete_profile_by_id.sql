DO $$
DECLARE
  pid uuid := 'c6978d7c-4448-4f43-8a11-c57580156d08';
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
