-- Distance ayant servi à facturer la livraison, en kilomètres, à vol d'oiseau.
--
-- Sans elle, aucune commande ne dit sur quelle distance elle a été tarifée, et
-- l'écart avec la distance routière affichée reste invisible.
--
-- Purement additive, colonne nullable : les commandes antérieures restent
-- valides et n'auront simplement pas l'information.
ALTER TABLE "Order" ADD COLUMN "delivery_distance_km" DOUBLE PRECISION;
