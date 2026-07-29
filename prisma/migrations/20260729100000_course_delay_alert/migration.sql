-- Détection des livraisons en retard.
-- La durée estimée d'une tournée n'était jamais calculée : personne ne pouvait
-- savoir qu'une livraison dérapait avant que le client ne réclame. Elle est
-- désormais figée au retrait, et cet horodatage évite de répéter l'alerte.
--
-- Additif + idempotent.

ALTER TABLE "Course"
  ADD COLUMN IF NOT EXISTS "delay_alerted_at" TIMESTAMP(6);
