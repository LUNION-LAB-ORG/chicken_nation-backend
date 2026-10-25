/**
 * Petites règles de l'application du plan (numérotation des arrêts, textes
 * vus par le livreur, commandes attendues) et de la fenêtre d'ajout fermée à
 * la validation.
 */
import { DeliveryStatut } from '@prisma/client';

import {
  commandesAttenduesAEcrire,
  estRaisonDuPlanificateur,
  heureCourte,
  libelleRegroupement,
  lireCommandesAttendues,
  numeroterArrets,
  referencesAttendues,
  retenueEnCours,
  texteCommandeAjoutee,
  texteCommandeRemise,
  texteCommandeRetiree,
  texteRetenue,
  texteSacOublie,
  texteToutEstPret,
} from './application-plan.rules';
import { motifFermetureALaValidation } from './depart.rules';
import { REGLAGES_PLANIFICATION_DEFAUT } from './planification.rules';

const l = (id: string, order_id: string, sequence_order: number, statut: DeliveryStatut = DeliveryStatut.PENDING) => ({
  id,
  order_id,
  sequence_order,
  statut,
});

describe('numeroterArrets', () => {
  it('suit la séquence demandée', () => {
    const rangs = numeroterArrets([l('l1', 'a', 1), l('l2', 'b', 2), l('l3', 'c', 3)], ['c', 'a', 'b']);
    expect(rangs && Object.fromEntries(rangs)).toEqual({ l3: 1, l1: 2, l2: 3 });
  });

  it('rien ne change : null (pas d’écriture)', () => {
    expect(numeroterArrets([l('l1', 'a', 1), l('l2', 'b', 2)], ['a', 'b'])).toBeNull();
  });

  it('livraisons commencées en tête, annulées en fin', () => {
    const rangs = numeroterArrets(
      [l('l1', 'a', 1, DeliveryStatut.CANCELLED), l('l2', 'b', 2, DeliveryStatut.IN_ROUTE), l('l3', 'c', 3), l('l4', 'd', 4)],
      ['d', 'c', 'b'],
    );
    expect(rangs && Object.fromEntries(rangs)).toEqual({ l2: 1, l4: 2, l3: 3, l1: 4 });
  });
});

describe('commandes attendues (colonne JSON)', () => {
  it('écrites avec les heures en ISO et le motif, relues en identifiants, formes inattendues ignorées', () => {
    const ecrites = commandesAttenduesAEcrire([
      {
        order_id: 'b',
        reference: 'CMD-B',
        prete_vers: new Date('2026-10-22T12:41:00Z'),
        prete_au_plus_tard: new Date('2026-10-22T12:44:00Z'),
        motif: 'TRAJET_LONG',
      },
      {
        order_id: 'c',
        reference: 'CMD-C',
        prete_vers: new Date('2026-10-22T12:33:00Z'),
        prete_au_plus_tard: new Date('2026-10-22T12:35:00Z'),
        motif: 'ATTENTE_COURTE',
      },
    ]);
    expect(ecrites).toEqual([
      {
        order_id: 'b',
        reference: 'CMD-B',
        prete_vers: '2026-10-22T12:41:00.000Z',
        prete_au_plus_tard: '2026-10-22T12:44:00.000Z',
        motif: 'TRAJET_LONG',
      },
      {
        order_id: 'c',
        reference: 'CMD-C',
        prete_vers: '2026-10-22T12:33:00.000Z',
        prete_au_plus_tard: '2026-10-22T12:35:00.000Z',
        motif: 'ATTENTE_COURTE',
      },
    ]);
    expect(lireCommandesAttendues(ecrites)).toEqual(['b', 'c']);
    expect(referencesAttendues(ecrites)).toEqual(['CMD-B', 'CMD-C']);
    expect(lireCommandesAttendues(null)).toEqual([]);
    expect(lireCommandesAttendues([{ x: 1 }, 'c', 3])).toEqual(['c']);
  });

  it('retenue en cours (remise pendant la retenue, 25/10) : échéance à venir et commandes attendues, sinon rien', () => {
    const maintenant = new Date('2026-10-22T12:30:30Z');
    const attendues = [{ order_id: 'b', reference: 'CMD-B' }];
    expect(retenueEnCours({ retenue_jusqua: '2026-10-22T12:34:00.000Z', commandes_attendues: attendues }, maintenant)).toEqual({
      jusqua: new Date('2026-10-22T12:34:00Z'),
      attendues: ['CMD-B'],
    });
    // Échue, levée (plus rien d'attendu), ou aucune.
    expect(retenueEnCours({ retenue_jusqua: new Date('2026-10-22T12:30:30Z'), commandes_attendues: attendues }, maintenant)).toBeNull();
    expect(retenueEnCours({ retenue_jusqua: new Date('2026-10-22T12:34:00Z'), commandes_attendues: [] }, maintenant)).toBeNull();
    expect(retenueEnCours({ retenue_jusqua: null, commandes_attendues: attendues }, maintenant)).toBeNull();
  });
});

describe('textes vus par le livreur : courts, chiffres, tutoiement, sans tiret cadratin', () => {
  const textes = [
    texteCommandeAjoutee({ ajoutees: 1, total: 2, apresRetrait: false, code: '421' }),
    texteCommandeAjoutee({ ajoutees: 2, total: 3, apresRetrait: true, code: '421' }),
    texteCommandeRetiree({ reference: 'CMD-C', restantes: 1 }),
    texteRetenue({ jusqua: new Date('2026-10-22T12:34:00Z'), maintenant: new Date('2026-10-22T12:31:20Z') }),
    texteToutEstPret({ code: '421', total: 2 }),
    texteCommandeRemise(),
    texteSacOublie({ sacs: 1 }),
    texteSacOublie({ sacs: 2 }),
  ];

  it('valeurs exactes', () => {
    expect(textes).toEqual([
      { titre: 'Commande ajoutée', corps: '2 commandes à prendre' },
      { titre: '2 commandes ajoutées', corps: 'Code 421 au restaurant' },
      { titre: 'Commande retirée', corps: '1 commande à livrer' },
      { titre: 'Attends 3 min', corps: 'Départ 12 h 34' },
      { titre: 'Tout est prêt', corps: '2 commandes · code 421' },
      { titre: 'Tout est récupéré', corps: 'Tu peux partir' },
      { titre: 'Sac oublié', corps: '1 sac au restaurant' },
      { titre: 'Sac oublié', corps: '2 sacs au restaurant' },
    ]);
  });

  it('au plus 4 mots par ligne, jamais de tiret cadratin', () => {
    for (const { titre, corps } of textes) {
      for (const ligne of [titre, corps]) {
        expect(ligne).not.toContain('—');
        expect(ligne.split(/\s+/).filter((m) => m !== '·').length).toBeLessThanOrEqual(4);
      }
    }
  });

  it('heure courte', () => {
    expect(heureCourte(new Date('2026-10-22T09:05:00Z'))).toBe('9 h 05');
  });
});

describe('raisons du planificateur et motif de regroupement', () => {
  it('les annonces du planificateur ne redéclenchent pas de passage', () => {
    expect(estRaisonDuPlanificateur('COMMANDE_AJOUTEE')).toBe(true);
    expect(estRaisonDuPlanificateur('DEPART')).toBe(true);
    expect(estRaisonDuPlanificateur(undefined)).toBe(false);
    expect(estRaisonDuPlanificateur('autre')).toBe(false);
  });

  it('libellé court pour l’affichage', () => {
    expect(libelleRegroupement('SUR_LE_TRAJET')).toBe('sur le trajet');
    expect(libelleRegroupement(null)).toBeNull();
  });
});

describe('fenêtre d’ajout fermée à la validation du retrait', () => {
  const r = REGLAGES_PLANIFICATION_DEFAUT;
  it.each([
    ['REPLI_V1', { version: 'v1' as const, deliverer_id: 'd', protocole_appli: 3, reglages: r }],
    ['SANS_LIVREUR', { version: 'v2' as const, deliverer_id: null, protocole_appli: null, reglages: r }],
    ['AJOUT_COUPE', { version: 'v2' as const, deliverer_id: 'd', protocole_appli: 3, reglages: { ...r, ajoutApresRetrait: false } }],
    ['AJOUT_COUPE', { version: 'v2' as const, deliverer_id: 'd', protocole_appli: 3, reglages: { ...r, ajoutApresRetraitMaxS: 0 } }],
    ['ANCIENNE_APPLI', { version: 'v2' as const, deliverer_id: 'd', protocole_appli: 2, reglages: r }],
    ['ANCIENNE_APPLI', { version: 'v2' as const, deliverer_id: 'd', protocole_appli: null, reglages: r }],
  ])('%s', (motif, p) => {
    expect(motifFermetureALaValidation(p)).toBe(motif);
  });

  it('nouvelle appli (protocole 3), v2, réglage actif : fenêtre ouverte', () => {
    expect(motifFermetureALaValidation({ version: 'v2', deliverer_id: 'd', protocole_appli: 3, reglages: r })).toBeNull();
  });
});
