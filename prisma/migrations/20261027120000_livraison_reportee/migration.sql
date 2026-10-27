-- Livraison passée à plus tard par le livreur (demande du 27/10) : il livre
-- d'abord les autres clients de sa tournée, puis revient sur celle-ci.
--
-- Additive et rejouable : une colonne facultative, sans valeur par défaut
-- (instantanée), aucune reprise de données. Elle survit au redémarrage de la
-- livraison (`in_route_at` est réécrit), porte la limite d'un seul report et
-- la puce « 2e passage », et sa présence dans `me/current` dit à l'appli que
-- le serveur connaît le geste. L'ancien serveur l'ignore.
ALTER TABLE "Delivery" ADD COLUMN IF NOT EXISTS "reportee_at" TIMESTAMP(6);
