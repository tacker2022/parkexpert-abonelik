-- Add apply_employee_price_to_corporate column to otoparks table
ALTER TABLE otoparks ADD COLUMN IF NOT EXISTS apply_employee_price_to_corporate BOOLEAN DEFAULT false;
