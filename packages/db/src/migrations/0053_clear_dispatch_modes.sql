ALTER TABLE "routines"
ADD COLUMN IF NOT EXISTS "dispatch_mode" text DEFAULT 'event_driven' NOT NULL;
