-- CURATION DES TÉMOIGNAGES DU SITE : le backoffice choisit explicitement les
-- avis affichés (toggle « Visible sur le site »). /comments/bests ne renvoie
-- plus une sélection automatique (note >= 4, longueur) mais UNIQUEMENT les
-- avis approuvés. Additif et idempotent.

ALTER TABLE "Comment"
  ADD COLUMN IF NOT EXISTS "site_visible" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "Comment_site_visible_idx" ON "Comment"("site_visible");
