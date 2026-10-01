import { IRapport, Levier, comparer, taux } from './crm-rapport.rules';

/**
 * Rapport FICTIF mais réaliste, pour les tests et le contrôle visuel du PDF
 * (ordre de grandeur des captures d'écran : 212 inscrits, 347 appels,
 * 181 joints, 269 coupons, 27 passés en direct). Sur 7 jours la courbe est
 * par jour ; sur 60 jours elle est par semaine et le PDF se pagine.
 *
 * Le jeu est COHÉRENT : les agents se somment aux totaux de l'équipe
 * (appels, joints, coupons) et du résultat (ventes, chiffre d'affaires) ;
 * Glovo + Yango = captés ; captés + inactifs = résultat. Un lecteur du PDF
 * de contrôle ne doit jamais croire à une erreur de calcul du rapport.
 */

const JOUR = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);

function levier(v: Record<keyof Omit<Levier, 'taux_contact' | 'taux_conversion'>, [number, number]>): Levier {
  return {
    entres: comparer(...v.entres),
    appeles: comparer(...v.appeles),
    joints: comparer(...v.joints),
    coupons: comparer(...v.coupons),
    ventes: comparer(...v.ventes),
    ca: comparer(v.ca[0], v.ca[1], true),
    taux_contact: taux(v.joints[0], v.appeles[0], v.joints[1], v.appeles[1]),
    taux_conversion: taux(v.ventes[0], v.entres[0], v.ventes[1], v.entres[1]),
  };
}

/** Agents : nom, appels, clients joints, coupons, ventes, chiffre d'affaires. Les 12 premiers se somment à 347 / 181 / 269 / 39 / 194 470. */
const AGENTS: [string, number, number, number, number, number][] = [
  ['Marie-Dominique Kouassi Aya Brou', 52, 29, 41, 7, 35_210],
  ['Jean-Baptiste N’Guessan Koffi', 46, 25, 36, 6, 29_870],
  ['Aïcha Diabaté', 41, 22, 33, 5, 24_650],
  ['Emmanuel Yao Konan', 36, 19, 29, 5, 25_400],
  ['Fatoumata Coulibaly Traoré', 32, 17, 25, 4, 19_980],
  ['Christelle Adjoua Kouamé', 29, 15, 22, 3, 15_100],
  ['Serge-Alain Gnamien', 26, 14, 20, 3, 14_320],
  ['Mariam Bamba', 23, 12, 17, 2, 10_450],
  ['Olivier Kouadio Assi', 20, 10, 15, 2, 9_600],
  ['Nadège Akissi Yapo', 17, 9, 13, 1, 5_230],
  ['Ibrahim Touré', 14, 6, 10, 1, 4_660],
  ['Prisca Djédjé', 11, 3, 8, 0, 0],
  ['Franck Zadi', 9, 4, 6, 0, 0],
  ['Rokia Sanogo', 6, 2, 3, 0, 0],
];

export function rapportFictif(jours: 7 | 60): IRapport {
  const fin = new Date('2026-10-01T00:00:00.000Z');
  const debut = new Date(fin.getTime() - (jours - 1) * JOUR);
  const finPrec = new Date(debut.getTime() - JOUR);
  const debutPrec = new Date(finPrec.getTime() - (jours - 1) * JOUR);

  const serie: IRapport['inscriptions']['serie'] = [];
  if (jours === 7) {
    const inscrits = [15, 18, 92, 40, 20, 14, 13];
    const premieres = [2, 3, 9, 11, 6, 5, 5];
    inscrits.forEach((n, i) => serie.push({ date: iso(new Date(debut.getTime() + i * JOUR)), inscrits: n, premieres_commandes: premieres[i] }));
  } else {
    const inscrits = [61, 48, 140, 97, 72, 55, 210, 88, 64];
    const premieres = [9, 7, 22, 19, 13, 9, 31, 18, 12];
    inscrits.forEach((n, i) =>
      serie.push({ date: iso(new Date(debut.getTime() + i * 7 * JOUR)), inscrits: n, premieres_commandes: premieres[i] }),
    );
  }

  const captesGlovo = levier({
    entres: [301, 268],
    appeles: [158, 141],
    joints: [79, 66],
    coupons: [61, 48],
    ventes: [17, 12],
    ca: [84_250, 59_900],
  });
  const captesYango = levier({
    entres: [178, 190],
    appeles: [94, 97],
    joints: [45, 51],
    coupons: [38, 40],
    ventes: [10, 9],
    ca: [48_820, 41_300],
  });
  const captes = levier({
    entres: [479, 458],
    appeles: [252, 238],
    joints: [124, 117],
    coupons: [99, 88],
    ventes: [27, 21],
    ca: [133_070, 101_200],
  });
  const inactifs = levier({
    entres: [83, 71],
    appeles: [76, 66],
    joints: [57, 44],
    coupons: [170, 128],
    ventes: [12, 9],
    ca: [61_400, 44_700],
  });

  const agents = AGENTS.slice(0, jours === 7 ? 12 : 14).map(([nom, appels, joints, coupons, ventes, ca], i) => ({
    id: `agent-${i + 1}`,
    nom,
    appels,
    joints,
    coupons,
    ventes,
    ca,
  }));
  const somme = (cle: 'appels' | 'joints' | 'coupons' | 'ventes' | 'ca') => agents.reduce((a, x) => a + x[cle], 0);
  // Totaux de l'équipe et du résultat = somme des agents (347 appels, 181 joints, 269 coupons, 39 ventes sur 7 jours).
  const appels = somme('appels');
  const joints = somme('joints');
  const coupons = somme('coupons');
  const ventes = somme('ventes');
  const ca = somme('ca');
  // Clients appelés : moins que les appels, un client peut être rappelé (252 Glovo et Yango + 76 inactifs).
  const appeles = captes.appeles.valeur + inactifs.appeles.valeur;
  const appelesPrec = captes.appeles.precedent + inactifs.appeles.precedent;

  const corps: Omit<IRapport, 'a_retenir'> = {
    periode: { debut: iso(debut), fin: iso(fin), jours },
    precedente: { debut: iso(debutPrec), fin: iso(finPrec) },
    edite_le: '2026-10-01',
    filtres: { publics: [], campagne: null, restaurant: null },
    inscriptions: {
      hors_restaurant: false,
      hors_filtre: false,
      inscrits: comparer(212, 189),
      ont_commande: comparer(41, 30),
      sous_7_jours: comparer(29, 22),
      taux_commande: taux(41, 212, 30, 189),
      delai_median_j: 2.5,
      ca: comparer(318_900, 221_450, true),
      sans_commande: 171,
      pas: jours === 7 ? 'jour' : 'semaine',
      serie,
    },
    captes: {
      hors_filtre: false,
      total: captes,
      par_public: [
        { segment: 'GLOVO', libelle: 'Clients Glovo', hors_filtre: false, ...captesGlovo },
        { segment: 'YANGO', libelle: 'Clients Yango', hors_filtre: false, ...captesYango },
      ],
    },
    inactifs: { hors_filtre: false, ...inactifs, delai_median_j: 6 },
    equipe: {
      appels: comparer(appels, appels - 29),
      appeles: comparer(appeles, appelesPrec),
      joints: comparer(joints, joints - 20),
      coupons: comparer(coupons, coupons - 53),
      taux_contact: taux(joints, appeles, joints - 20, appelesPrec),
      agents,
    },
    resultat: {
      ventes: comparer(ventes, 30),
      ca: comparer(ca, 145_900, true),
      panier_moyen: comparer(Math.round(ca / ventes), Math.round(145_900 / 30), true),
      par_public: [
        { segment: 'JAMAIS_COMMANDE', libelle: 'Inscrits sans commande', ventes: 0, ca: 0 },
        { segment: 'INACTIF', libelle: 'Clients inactifs', ventes: 12, ca: 61_400 },
        { segment: 'GLOVO', libelle: 'Clients Glovo', ventes: 17, ca: 84_250 },
        { segment: 'YANGO', libelle: 'Clients Yango', ventes: 10, ca: 48_820 },
      ],
    },
    raisons: [
      { raison: 'Trop cher par rapport à Glovo', nombre: 31, part: 33.7 },
      { raison: 'Ne connaît pas l’application', nombre: 22, part: 23.9 },
      { raison: 'Habitué à commander sur Yango, ne veut pas changer', nombre: 15, part: 16.3 },
      { raison: 'Pas de livraison dans son quartier', nombre: 11, part: 12 },
      { raison: 'Mauvaise expérience passée (retard de livraison)', nombre: 8, part: 8.7 },
      { raison: 'Raison non renseignée', nombre: 5, part: 5.4 },
    ],
  };
  return { ...corps, a_retenir: [] };
}
