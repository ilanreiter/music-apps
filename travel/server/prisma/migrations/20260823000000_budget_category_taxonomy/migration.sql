-- Replace the BudgetCategory enum with the simplified taxonomy
-- (TRANSPORT, FLIGHTS, LODGING, FOOD, ACTIVITIES, OTHER), dropping
-- SHOPPING/INSURANCE/MISC and adding FLIGHTS/OTHER. No BudgetLine rows use
-- the dropped values at the time of this migration, so no data remapping is
-- needed.
CREATE TYPE "BudgetCategory_new" AS ENUM ('TRANSPORT', 'FLIGHTS', 'LODGING', 'FOOD', 'ACTIVITIES', 'OTHER');
ALTER TABLE "BudgetLine" ALTER COLUMN "category" TYPE "BudgetCategory_new" USING ("category"::text::"BudgetCategory_new");
DROP TYPE "BudgetCategory";
ALTER TYPE "BudgetCategory_new" RENAME TO "BudgetCategory";
