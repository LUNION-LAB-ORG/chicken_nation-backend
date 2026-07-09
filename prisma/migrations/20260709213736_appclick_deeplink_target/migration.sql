-- Ajout des champs de ciblage deeplink sur AppClick (idempotent pour éviter le drift Neon)
ALTER TABLE "AppClick" ADD COLUMN IF NOT EXISTS "type" TEXT;
ALTER TABLE "AppClick" ADD COLUMN IF NOT EXISTS "targetId" TEXT;
ALTER TABLE "AppClick" ADD COLUMN IF NOT EXISTS "targetLabel" TEXT;
