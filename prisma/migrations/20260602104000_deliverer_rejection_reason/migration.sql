-- Persiste le motif du dernier refus d'un livreur (status REJECTED).
-- Posé par reject(id, reason), effacé à la validation/resoumission.
-- Affiché au livreur (deli) et à l'administrateur (backoffice).
ALTER TABLE "Deliverer" ADD COLUMN IF NOT EXISTS "rejection_reason" TEXT;
