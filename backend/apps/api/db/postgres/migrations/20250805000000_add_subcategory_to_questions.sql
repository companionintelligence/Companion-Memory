-- migrate:up
ALTER TABLE questions
ADD COLUMN subcategory TEXT;

-- migrate:down
ALTER TABLE questions
DROP COLUMN subcategory;
