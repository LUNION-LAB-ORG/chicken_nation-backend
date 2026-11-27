/**
 * Ouvert ou fermé à un instant donné, selon les horaires d'un restaurant.
 *
 * Horaires : une entrée par jour, `{ "1": "10:00-22:00" }` (1 = lundi,
 * 7 = dimanche), un ou plusieurs créneaux séparés par des virgules
 * (« 08:00-12:00,14:00-22:00 »), ou « Fermé ».
 *
 * FERMETURE APRÈS MINUIT (corrigé le 27/11). Un créneau dont la fin précède
 * le début (« 22:00-02:00 ») court sur deux jours :
 *  - le soir, depuis l'ouverture jusqu'à minuit, il appartient au jour lu ;
 *  - après minuit, jusqu'à la fermeture, c'est le créneau de la VEILLE qui
 *    court encore.
 * Avant, seul le jour en cours était lu, et la fin de nuit exigeait d'être à
 * la fois après l'ouverture du soir et avant la fermeture : jamais vrai. Le
 * restaurant était jugé fermé de minuit à sa fermeture, et les commandes
 * refusées.
 *
 * L'heure est celle du serveur (`Date` locale), comme avant. Bornes
 * comprises, à la seconde : ouvert à 22:00:00 pour une fermeture à 22:00,
 * fermé à 22:00:30.
 *
 * Fonctions pures, sans base ni réseau.
 */

export type HorairesRestaurant = Record<string, string>[];

interface Creneau {
  /** Secondes depuis minuit. */
  debut: number;
  fin: number;
}

const enSecondes = (heure: string): number | null => {
  const lu = /^(\d{1,2}):(\d{1,2})$/.exec(heure.trim());
  if (!lu) return null;
  const h = Number(lu[1]);
  const m = Number(lu[2]);
  if (h > 23 || m > 59) return null;
  return h * 3600 + m * 60;
};

/** Clé du jour dans les horaires : 1 = lundi … 7 = dimanche. */
const cleDuJour = (date: Date): string => {
  const jour = date.getDay();
  return String(jour === 0 ? 7 : jour);
};

const cleDeLaVeille = (date: Date): string => {
  const jour = Number(cleDuJour(date));
  return String(jour === 1 ? 7 : jour - 1);
};

/** Créneaux lisibles d'un jour ; aucun pour un jour fermé, absent ou illisible. */
const creneauxDuJour = (horaires: HorairesRestaurant, cle: string): Creneau[] => {
  const jour = horaires.find((entree) => entree && Object.prototype.hasOwnProperty.call(entree, cle));
  const plage = jour?.[cle];
  if (typeof plage !== 'string' || !plage.trim()) return [];
  if (['fermé', 'closed'].includes(plage.trim().toLowerCase())) return [];

  return plage
    .split(',')
    .map((texte) => {
      const bornes = texte.trim().split('-');
      if (bornes.length !== 2) return null;
      const debut = enSecondes(bornes[0]);
      const fin = enSecondes(bornes[1]);
      return debut === null || fin === null ? null : { debut, fin };
    })
    .filter((creneau): creneau is Creneau => creneau !== null);
};

/** Le créneau finit-il le lendemain ? */
const deborde = (creneau: Creneau): boolean => creneau.fin < creneau.debut;

export function ouvertSelonHoraires(
  horaires: HorairesRestaurant | null | undefined,
  reference: Date = new Date(),
): boolean {
  if (!horaires || !Array.isArray(horaires)) return false;

  const maintenant = reference.getHours() * 3600 + reference.getMinutes() * 60 + reference.getSeconds();

  // Créneaux du jour : dans la journée, ou le soir d'un créneau qui déborde.
  const ouvertAujourdhui = creneauxDuJour(horaires, cleDuJour(reference)).some((creneau) =>
    deborde(creneau)
      ? maintenant >= creneau.debut
      : maintenant >= creneau.debut && maintenant <= creneau.fin,
  );
  if (ouvertAujourdhui) return true;

  // Après minuit : le créneau de la veille court jusqu'à sa fermeture.
  return creneauxDuJour(horaires, cleDeLaVeille(reference)).some(
    (creneau) => deborde(creneau) && maintenant <= creneau.fin,
  );
}
