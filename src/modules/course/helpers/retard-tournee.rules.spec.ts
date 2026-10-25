import { CourseStatut } from '@prisma/client';

import {
  baseDeTournee,
  CourseTourneeLue,
  departEstReel,
  enRetard,
  finTourneePrevue,
  retardMin,
  tempsDeTourneeMin,
} from './retard-tournee.rules';

const RETRAIT = new Date('2026-10-24T12:00:00.000Z');
const minutes = (n: number) => new Date(RETRAIT.getTime() + n * 60_000);
const FACTEUR = 1.5;

/** Course partie pour de bon 5 min après le retrait, tournée estimée à 20 min. */
const partie: CourseTourneeLue = {
  statut: CourseStatut.IN_DELIVERY,
  picked_up_at: RETRAIT,
  parti_at: minutes(5),
  motif_depart: 'POSITION',
  estimated_duration_min: 20,
  delay_alerted_at: null,
};

describe('departEstReel', () => {
  it('motifs réels : bouton, position, livraison démarrée, fenêtre écoulée', () => {
    for (const motif of ['BOUTON', 'POSITION', 'LIVRAISON_DEMARREE', 'FENETRE_ECHUE']) {
      expect([motif, departEstReel({ ...partie, motif_depart: motif })]).toEqual([motif, true]);
    }
  });

  it('fenêtre fermée d’office : pas un départ réel', () => {
    for (const motif of ['ANCIENNE_APPLI', 'REPLI_V1', 'AJOUT_COUPE', 'SANS_LIVREUR', 'DEJA_PARTI', 'SANS_RETRAIT']) {
      expect([motif, departEstReel({ ...partie, motif_depart: motif })]).toEqual([motif, false]);
    }
  });

  it('sans motif (course d’avant le motif) : réel si noté après le retrait', () => {
    expect(departEstReel({ ...partie, motif_depart: null })).toBe(true);
    expect(departEstReel({ ...partie, motif_depart: null, parti_at: RETRAIT })).toBe(false);
  });

  it('pas parti : non', () => {
    expect(departEstReel({ ...partie, parti_at: null })).toBe(false);
  });
});

describe('finTourneePrevue', () => {
  it('départ réel : départ + durée estimée', () => {
    expect(baseDeTournee(partie)).toEqual(minutes(5));
    expect(finTourneePrevue(partie)).toEqual(minutes(25));
  });

  it('départ noté sans être réel : retrait + durée estimée', () => {
    const course = { ...partie, parti_at: RETRAIT, motif_depart: 'ANCIENNE_APPLI' };
    expect(baseDeTournee(course)).toEqual(RETRAIT);
    expect(finTourneePrevue(course)).toEqual(minutes(20));
  });

  it('pas encore parti (fenêtre d’ajout ouverte, Turbo) : rien', () => {
    expect(finTourneePrevue({ ...partie, parti_at: null, motif_depart: null })).toBeNull();
  });

  it('sans durée estimée, ou durée nulle : rien', () => {
    expect(finTourneePrevue({ ...partie, estimated_duration_min: null })).toBeNull();
    expect(finTourneePrevue({ ...partie, estimated_duration_min: undefined })).toBeNull();
    expect(finTourneePrevue({ ...partie, estimated_duration_min: 0 })).toBeNull();
  });

  it('départ noté sans être réel et sans retrait : rien', () => {
    expect(finTourneePrevue({ ...partie, picked_up_at: null, motif_depart: 'SANS_RETRAIT' })).toBeNull();
  });

  it('lit aussi les dates en texte ISO', () => {
    const texte = {
      ...partie,
      picked_up_at: RETRAIT.toISOString(),
      parti_at: minutes(5).toISOString(),
    };
    expect(finTourneePrevue(texte)).toEqual(minutes(25));
  });
});

describe('enRetard : même règle que le cron detecterRetards', () => {
  it('à la durée estimée × facteur depuis le retrait : en retard, pas avant', () => {
    // 20 min × 1,5 = 30 min après le retrait.
    expect(enRetard(partie, minutes(29), FACTEUR)).toBe(false);
    expect(enRetard(partie, minutes(30), FACTEUR)).toBe(true);
  });

  it('compte depuis le retrait, même quand le départ est plus tard', () => {
    const tardif = { ...partie, parti_at: minutes(12) };
    expect(enRetard(tardif, minutes(30), FACTEUR)).toBe(true);
  });

  it('livreur encore au restaurant après le retrait : même règle', () => {
    expect(enRetard({ ...partie, parti_at: null, motif_depart: null }, minutes(30), FACTEUR)).toBe(true);
  });

  it('alerte déjà donnée : en retard, quelle que soit l’heure', () => {
    expect(enRetard({ ...partie, delay_alerted_at: minutes(30) }, minutes(1), FACTEUR)).toBe(true);
    expect(enRetard({ ...partie, delay_alerted_at: minutes(30).toISOString() }, minutes(1), FACTEUR)).toBe(true);
  });

  it('pas en livraison : jamais en retard, même alertée', () => {
    for (const statut of [
      CourseStatut.PENDING_ASSIGNMENT,
      CourseStatut.ACCEPTED,
      CourseStatut.AT_RESTAURANT,
      CourseStatut.COMPLETED,
      CourseStatut.CANCELLED,
      CourseStatut.EXPIRED,
    ]) {
      const course = { ...partie, statut, delay_alerted_at: minutes(30) };
      expect([statut, enRetard(course, minutes(90), FACTEUR)]).toEqual([statut, false]);
    }
  });

  it('sans retrait ou sans durée estimée : non', () => {
    expect(enRetard({ ...partie, picked_up_at: null }, minutes(90), FACTEUR)).toBe(false);
    expect(enRetard({ ...partie, estimated_duration_min: null }, minutes(90), FACTEUR)).toBe(false);
  });

  it('suit le réglage du facteur', () => {
    expect(enRetard(partie, minutes(25), 1.2)).toBe(true);
    expect(enRetard(partie, minutes(25), 1.5)).toBe(false);
  });

  describe('retenue au comptoir après la remise (relecture du 25/10) : l’attente ne compte pas comme tournée', () => {
    // Remise à 12:00 (la caisse remet dès le code), retenue jusqu'à 12:12, départ 12:13, tournée de 26 min.
    const retenue = { ...partie, retenue_jusqua: minutes(12), parti_at: minutes(13), estimated_duration_min: 26 };

    it('comptée depuis la fin de la retenue : 26 × 1,5 = 39 min après 12:12, pas 39 min après la remise', () => {
      expect(enRetard(retenue, minutes(40), FACTEUR)).toBe(false);
      expect(enRetard(retenue, minutes(50), FACTEUR)).toBe(false);
      expect(enRetard(retenue, minutes(51), FACTEUR)).toBe(true);
      expect(tempsDeTourneeMin(retenue, minutes(51))).toBe(39);
    });

    it('livreur encore au comptoir pendant la retenue : jamais en retard', () => {
      const auComptoir = { ...retenue, parti_at: null, motif_depart: null, estimated_duration_min: 6 };
      expect(enRetard(auComptoir, minutes(11), FACTEUR)).toBe(false);
    });

    it('parti pour de bon pendant la retenue : compté depuis son départ', () => {
      const parti = { ...retenue, parti_at: minutes(5), motif_depart: 'POSITION' };
      expect(enRetard(parti, minutes(43), FACTEUR)).toBe(false);
      expect(enRetard(parti, minutes(44), FACTEUR)).toBe(true);
    });

    it('retenue levée avant la remise, ou texte ISO : depuis la remise, comme avant', () => {
      expect(enRetard({ ...partie, retenue_jusqua: minutes(-2) }, minutes(30), FACTEUR)).toBe(true);
      expect(enRetard({ ...retenue, retenue_jusqua: minutes(12).toISOString() }, minutes(50), FACTEUR)).toBe(false);
    });
  });
});

describe('retardMin', () => {
  it('minutes pleines au-delà de la fin prévue', () => {
    // Fin prévue 12 h 25, en retard depuis 12 h 30 (retrait + 30 min).
    expect(retardMin(partie, minutes(30), FACTEUR)).toBe(5);
    expect(retardMin(partie, new Date(minutes(37).getTime() + 59_000), FACTEUR)).toBe(12);
  });

  it('pas en retard : rien, même au-delà de la fin prévue', () => {
    expect(retardMin(partie, minutes(28), FACTEUR)).toBeNull();
  });

  it('en retard sans fin prévue (pas encore parti) : rien, l’écran dit « En retard »', () => {
    const auRestaurant = { ...partie, parti_at: null, motif_depart: null };
    expect(enRetard(auRestaurant, minutes(40), FACTEUR)).toBe(true);
    expect(retardMin(auRestaurant, minutes(40), FACTEUR)).toBeNull();
  });

  it('alertée mais encore avant la fin prévue, ou à moins d’une minute : rien', () => {
    const alertee = { ...partie, delay_alerted_at: minutes(10) };
    expect(retardMin(alertee, minutes(20), FACTEUR)).toBeNull();
    expect(retardMin(alertee, minutes(25), FACTEUR)).toBeNull();
    expect(retardMin(alertee, new Date(minutes(25).getTime() + 59_000), FACTEUR)).toBeNull();
    expect(retardMin(alertee, minutes(26), FACTEUR)).toBe(1);
  });
});
