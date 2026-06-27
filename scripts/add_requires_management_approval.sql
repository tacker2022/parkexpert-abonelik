-- Add requires_management_approval column to otoparks table
ALTER TABLE otoparks ADD COLUMN IF NOT EXISTS requires_management_approval BOOLEAN DEFAULT false;
