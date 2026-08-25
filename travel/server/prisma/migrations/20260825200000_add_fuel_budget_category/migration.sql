-- Add a dedicated FUEL budget category so gas/fuel line items (currently
-- falling into OTHER, or misleadingly excluded from TRANSPORT) get their
-- own bucket separate from both.
ALTER TYPE "BudgetCategory" ADD VALUE 'FUEL';
