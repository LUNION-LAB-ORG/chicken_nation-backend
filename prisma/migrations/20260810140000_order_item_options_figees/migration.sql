-- MENUS COMPOSABLES (10/08) — les choix du client, figés sur la ligne.
--
-- Un burger composable se commande avec une sauce et un format. Sans cette
-- colonne, la commande ne garderait que le plat et son prix : la cuisine ne
-- saurait pas quoi préparer, et le reçu ne pourrait pas dire ce qui a été payé.
--
-- Additive et rejouable. Les lignes existantes gardent NULL, ce qui se lit
-- « plat sans options », exactement ce qu'elles sont.

ALTER TABLE "OrderItem" ADD COLUMN IF NOT EXISTS "options" JSON;
