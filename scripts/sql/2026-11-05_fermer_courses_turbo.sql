-- Courses confiées à Turbo restées ouvertes : fermeture du stock, À LANCER À LA MAIN.
--
-- POURQUOI
-- La caisse termine à la main les commandes confiées à Turbo et rien ne fermait
-- leur course. Depuis le 05/11, la commande finie ferme sa course
-- (CommandeFinieListener) : ce script traite celles d'avant.
--
-- QUOI
-- Livraison : DELIVERED si sa commande est récupérée ou terminée, CANCELLED si
-- elle est annulée. Sans heure de livraison, comme le serveur : personne ne l'a
-- validée, et une heure fausserait la durée moyenne du tableau de la livraison.
-- Course : COMPLETED, ou CANCELLED si toutes ses commandes sont annulées, et
-- seulement quand plus aucune commande n'est en cours.
-- Rien n'est supprimé. Une commande encore en cours n'est pas touchée : elles
-- sont à regarder une par une (requête 3). Aucun appel à Turbo.
--
-- COMMENT
-- Dans l'éditeur SQL de Neon, une requête à la fois, dans l'ordre.
-- La requête 2 est une seule instruction : tout ou rien. Rejouable : un second
-- passage ne touche rien.

-- 1. AVANT : ce qui est ouvert, et le nombre de positions Turbo reçues.
SELECT c.statut AS etat_course, o.status AS etat_commande,
  count(DISTINCT c.id) AS courses,
  count(*) AS livraisons,
  count(*) FILTER (WHERE d.turbo_courier_location_at IS NOT NULL) AS avec_position_turbo,
  min(c.created_at)::date AS premiere,
  max(c.created_at)::date AS derniere
FROM "Course" c
JOIN "Delivery" d ON d.course_id = c.id
JOIN "Order" o ON o.id = d.order_id
WHERE c.turbo_escalated_at IS NOT NULL
  AND c.statut IN ('PENDING_ASSIGNMENT', 'ACCEPTED', 'AT_RESTAURANT', 'IN_DELIVERY')
GROUP BY 1, 2
ORDER BY 3 DESC;

-- 2. FERMETURE.
WITH ouvertes AS (
  SELECT c.id
  FROM "Course" c
  WHERE c.turbo_escalated_at IS NOT NULL
    AND c.statut IN ('PENDING_ASSIGNMENT', 'ACCEPTED', 'AT_RESTAURANT', 'IN_DELIVERY')
),
lignes AS (
  SELECT d.id, d.course_id,
    coalesce(o.completed_at, o.collected_at, o.cancelled_at, o.updated_at) AS moment,
    CASE WHEN d.statut IN ('DELIVERED', 'FAILED', 'CANCELLED') THEN d.statut::text
         WHEN o.status IN ('COLLECTED', 'COMPLETED') THEN 'DELIVERED'
         WHEN o.status = 'CANCELLED' THEN 'CANCELLED'
    END AS etat_final
  FROM "Delivery" d
  JOIN "Order" o ON o.id = d.order_id
  WHERE d.course_id IN (SELECT id FROM ouvertes)
),
a_fermer AS (
  SELECT course_id,
    CASE WHEN bool_or(etat_final = 'DELIVERED') THEN 'COMPLETED' ELSE 'CANCELLED' END AS etat_course,
    max(moment) AS moment
  FROM lignes
  GROUP BY course_id
  HAVING bool_and(etat_final IS NOT NULL)
),
livraisons AS (
  UPDATE "Delivery" d
  SET statut = l.etat_final::"DeliveryStatut",
      updated_at = now() AT TIME ZONE 'UTC'
  FROM lignes l
  WHERE d.id = l.id
    AND l.etat_final IS NOT NULL
    AND d.statut::text <> l.etat_final
  RETURNING d.id
),
courses AS (
  UPDATE "Course" c
  SET statut = f.etat_course::"CourseStatut",
      completed_at = CASE WHEN f.etat_course = 'COMPLETED' THEN f.moment ELSE c.completed_at END,
      cancelled_at = CASE WHEN f.etat_course = 'CANCELLED' THEN f.moment ELSE c.cancelled_at END,
      cancelled_by = CASE WHEN f.etat_course = 'CANCELLED' THEN 'system' ELSE c.cancelled_by END,
      cancelled_reason = CASE WHEN f.etat_course = 'CANCELLED'
        THEN 'Plus aucune commande à livrer : toutes ses commandes ont été annulées'
        ELSE c.cancelled_reason END,
      updated_at = now() AT TIME ZONE 'UTC'
  FROM a_fermer f
  WHERE c.id = f.course_id
  RETURNING c.statut
)
SELECT
  (SELECT count(*) FROM livraisons) AS livraisons_fermees,
  (SELECT count(*) FROM courses WHERE statut = 'COMPLETED') AS courses_terminees,
  (SELECT count(*) FROM courses WHERE statut = 'CANCELLED') AS courses_annulees;

-- 3. APRÈS : il ne doit rester que des commandes encore en cours, à regarder une par une.
SELECT c.reference AS course, c.statut AS etat_course, o.reference AS commande, o.status AS etat_commande,
  o.created_at::date AS jour, d.turbo_courier_name AS livreur_turbo
FROM "Course" c
JOIN "Delivery" d ON d.course_id = c.id
JOIN "Order" o ON o.id = d.order_id
WHERE c.turbo_escalated_at IS NOT NULL
  AND c.statut IN ('PENDING_ASSIGNMENT', 'ACCEPTED', 'AT_RESTAURANT', 'IN_DELIVERY')
ORDER BY o.created_at;
