-- Relances de l'offre pendant la fenêtre d'acceptation.
-- Une notification unique ne laisse au livreur qu'UNE chance de voir l'offre :
-- distrait à cet instant (poche, moteur, casque), il perd une course qu'il
-- aurait acceptée. Le compteur rend les relances idempotentes et sûres avec
-- deux backends en parallèle (claim atomique sur la valeur précédente).
--
-- Additif + idempotent.

ALTER TABLE "CourseOfferAttempt"
  ADD COLUMN IF NOT EXISTS "reminders_sent" INTEGER NOT NULL DEFAULT 0;
