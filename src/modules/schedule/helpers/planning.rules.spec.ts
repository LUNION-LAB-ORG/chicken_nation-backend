import { ForbiddenException } from '@nestjs/common';
import { Genre, SchedulePlanStatus, User, UserRole, UserType } from '@prisma/client';

import {
  actionAuJournal,
  dateCourte,
  deRestaurant,
  type GestePlanning,
  jourCourt,
  MESSAGE_PLANNING_AUTRE_RESTAURANT,
  nomLivreur,
  notificationDates,
  notificationJour,
  notificationRetrait,
  notificationSuppression,
  periode,
  planningsDuRestaurant,
  prevenirLesLivreurs,
  resumeJournal,
  verifierPlanningDuRestaurant,
} from './planning.rules';

const { DRAFT, SENT, CONFIRMED, ARCHIVED } = SchedulePlanStatus;
const jour = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const angre = (status: SchedulePlanStatus) => ({
  status,
  period_start: jour('2026-10-13'),
  period_end: jour('2026-10-26'),
  restaurant: { name: 'Angré' },
});

describe('qui est prévenu, ce qui va au journal', () => {
  const gestes: GestePlanning[] = ['jour', 'ajout', 'retrait', 'dates', 'suppression'];

  it('le livreur n’est prévenu que sur un planning envoyé ou confirmé', () => {
    expect([DRAFT, SENT, CONFIRMED, ARCHIVED].map(prevenirLesLivreurs)).toEqual([false, true, true, false]);
  });

  it('journal : tout geste sur un archivé, et la suppression d’un confirmé ; rien d’autre', () => {
    for (const statut of [DRAFT, SENT, CONFIRMED, ARCHIVED]) {
      for (const geste of gestes) {
        const attendu =
          statut === ARCHIVED
            ? geste === 'suppression'
              ? 'PLANNING_SUPPRIME'
              : 'PLANNING_ARCHIVE_MODIFIE'
            : statut === CONFIRMED && geste === 'suppression'
              ? 'PLANNING_SUPPRIME'
              : null;
        expect([statut, geste, actionAuJournal(statut, geste)]).toEqual([statut, geste, attendu]);
      }
    }
  });
});

describe('textes', () => {
  it('dates courtes, jour court, période', () => {
    expect(dateCourte(jour('2026-11-09'))).toBe('09/11');
    expect(jourCourt(jour('2026-10-26'))).toBe('Lun. 26/10');
    expect(jourCourt(jour('2026-11-01'))).toBe('Dim. 01/11');
    expect(periode(jour('2026-10-27'), jour('2026-11-09'))).toBe('27/10 au 09/11');
  });

  it('le jour est lu en UTC (Abidjan), même tard le soir', () => {
    expect(jourCourt(new Date('2026-10-26T23:59:00Z'))).toBe('Lun. 26/10');
  });

  it('restaurant : élision devant une voyelle', () => {
    expect(deRestaurant('Angré')).toBe("d'Angré");
    expect(deRestaurant('Épervier')).toBe("d'Épervier");
    expect(deRestaurant('Marcory')).toBe('de Marcory');
    expect(deRestaurant('Yopougon')).toBe('de Yopougon');
    expect(deRestaurant(null)).toBe('de restaurant inconnu');
  });

  it('nom du livreur', () => {
    expect(nomLivreur({ first_name: 'Koffi', last_name: 'Yao' })).toBe('Koffi Yao');
    expect(nomLivreur({ first_name: ' Awa ', last_name: null })).toBe('Awa');
    expect(nomLivreur(null)).toBe('Livreur sans nom');
  });

  it('journal d’un planning archivé : une phrase par geste, accordée au livreur', () => {
    const koffi = { first_name: 'Koffi', last_name: 'Yao', genre: Genre.HOMME };
    const awa = { first_name: 'Awa', last_name: 'Koné', genre: Genre.FEMME };
    const plan = angre(ARCHIVED);
    expect(resumeJournal(plan, { geste: 'jour', livreur: koffi, mode: 'REST', date: jour('2026-10-21') })).toBe(
      "Planning archivé d'Angré (13/10 au 26/10) : Koffi Yao en repos le 21/10",
    );
    expect(resumeJournal(plan, { geste: 'jour', livreur: koffi, mode: 'WORK', date: jour('2026-10-21') })).toBe(
      "Planning archivé d'Angré (13/10 au 26/10) : Koffi Yao au travail le 21/10",
    );
    expect(resumeJournal(plan, { geste: 'retrait', livreur: koffi })).toBe(
      "Planning archivé d'Angré (13/10 au 26/10) : Koffi Yao retiré",
    );
    expect(resumeJournal(plan, { geste: 'retrait', livreur: awa })).toBe(
      "Planning archivé d'Angré (13/10 au 26/10) : Awa Koné retirée",
    );
    expect(resumeJournal(plan, { geste: 'ajout', livreur: awa })).toBe(
      "Planning archivé d'Angré (13/10 au 26/10) : Awa Koné ajoutée",
    );
    expect(resumeJournal(plan, { geste: 'ajout', livreur: { first_name: 'Ali', last_name: null, genre: null } })).toBe(
      "Planning archivé d'Angré (13/10 au 26/10) : Ali ajouté",
    );
    expect(resumeJournal(plan, { geste: 'dates', debut: jour('2026-10-14'), fin: jour('2026-10-27') })).toBe(
      "Planning archivé d'Angré (13/10 au 26/10) : dates changées pour le 14/10 au 27/10",
    );
    expect(resumeJournal(plan, { geste: 'suppression' })).toBe('Planning archivé d\'Angré (13/10 au 26/10) supprimé');
    expect(
      resumeJournal(
        { ...angre(CONFIRMED), period_start: jour('2026-10-27'), period_end: jour('2026-11-09') },
        { geste: 'suppression' },
      ),
    ).toBe("Planning confirmé d'Angré (27/10 au 09/11) supprimé");
  });

  it('notifications au livreur : type, titre et texte de la conception', () => {
    const plan = { ...angre(SENT), period_start: jour('2026-10-26'), period_end: jour('2026-11-08') };
    expect(notificationJour('WORK', jour('2026-10-26'))).toEqual({
      type: 'plan_sent',
      titre: 'Planning modifié',
      texte: 'Lun. 26/10 : au travail, à confirmer',
    });
    expect(notificationJour('REST', jour('2026-10-26'))).toEqual({
      type: 'plan_modifie',
      titre: 'Planning modifié',
      texte: 'Lun. 26/10 : repos',
    });
    expect(notificationRetrait(plan)).toEqual({
      type: 'plan_modifie',
      titre: 'Planning modifié',
      texte: "Tu n'es plus sur le planning du 26/10 au 08/11",
    });
    expect(notificationDates(plan)).toEqual({
      type: 'plan_modifie',
      titre: 'Planning modifié',
      texte: 'Le planning du 26/10 au 08/11 est refait',
    });
    expect(notificationSuppression(plan)).toEqual({
      type: 'plan_modifie',
      titre: 'Planning annulé',
      texte: 'Le planning du 26/10 au 08/11 est annulé',
    });
  });

  it('aucun texte n’a de tiret cadratin', () => {
    const plan = angre(ARCHIVED);
    const textes = [
      resumeJournal(plan, { geste: 'suppression' }),
      notificationJour('WORK', jour('2026-10-26')).texte,
      notificationRetrait(plan).texte,
      notificationDates(plan).texte,
      notificationSuppression(plan).texte,
    ];
    for (const t of textes) expect(t).not.toMatch(/[—–]/);
  });
});

describe('cloisonnement', () => {
  const RESTO_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const RESTO_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const compte = (role: UserRole, type: UserType, restaurant_id: string | null) =>
    ({ id: role, role, type, restaurant_id }) as unknown as User;

  it('un manager d’Angré : 403 sur Marcory, avec la phrase du planning ; rien sur Angré', () => {
    const manager = compte(UserRole.MANAGER, UserType.RESTAURANT, RESTO_A);
    expect(() => verifierPlanningDuRestaurant(manager, RESTO_B)).toThrow(
      new ForbiddenException(MESSAGE_PLANNING_AUTRE_RESTAURANT),
    );
    expect(() => verifierPlanningDuRestaurant(manager, RESTO_A)).not.toThrow();
  });

  it('compte de restaurant sans restaurant : refusé partout', () => {
    expect(() =>
      verifierPlanningDuRestaurant(compte(UserRole.ASSISTANT_MANAGER, UserType.RESTAURANT, null), RESTO_A),
    ).toThrow(ForbiddenException);
  });

  it('compte du siège : tous les restaurants', () => {
    expect(() => verifierPlanningDuRestaurant(compte(UserRole.ADMIN, UserType.BACKOFFICE, null), RESTO_B)).not.toThrow();
    expect(() =>
      verifierPlanningDuRestaurant(compte(UserRole.LIVRAISON_OPS, UserType.BACKOFFICE, null), RESTO_B),
    ).not.toThrow();
  });
});

describe('planning en cours et suivant d’un restaurant', () => {
  const p = (id: string, status: SchedulePlanStatus, debut: string, fin: string) => ({
    id,
    status,
    period_start: jour(debut),
    period_end: jour(fin),
  });
  const aujourdhui = jour('2026-10-28');

  it('en cours : celui qui couvre aujourd’hui, bornes comprises ; suivant : le premier après sa fin', () => {
    const r = planningsDuRestaurant(
      [
        p('apres', DRAFT, '2026-11-23', '2026-12-06'),
        p('suivant', SENT, '2026-11-09', '2026-11-22'),
        p('courant', CONFIRMED, '2026-10-28', '2026-11-08'),
      ],
      aujourdhui,
    );
    expect([r.en_cours?.id, r.suivant?.id]).toEqual(['courant', 'suivant']);
    expect(planningsDuRestaurant([p('fin', SENT, '2026-10-15', '2026-10-28')], aujourdhui).en_cours?.id).toBe('fin');
  });

  it('un archivé ne compte ni en cours ni suivant', () => {
    const r = planningsDuRestaurant(
      [p('archive', ARCHIVED, '2026-10-26', '2026-11-08'), p('futur-archive', ARCHIVED, '2026-11-09', '2026-11-22')],
      aujourdhui,
    );
    expect(r).toEqual({ en_cours: null, suivant: null });
  });

  it('sans planning en cours : le suivant est le premier qui commence après aujourd’hui', () => {
    const r = planningsDuRestaurant(
      [p('loin', DRAFT, '2026-11-16', '2026-11-29'), p('proche', DRAFT, '2026-11-02', '2026-11-15')],
      aujourdhui,
    );
    expect([r.en_cours, r.suivant?.id]).toEqual([null, 'proche']);
  });

  it('deux plannings couvrent aujourd’hui : confirmé, puis envoyé, puis brouillon', () => {
    const r = planningsDuRestaurant(
      [p('brouillon', DRAFT, '2026-10-26', '2026-11-08'), p('envoye', SENT, '2026-10-27', '2026-11-09')],
      aujourdhui,
    );
    expect(r.en_cours?.id).toBe('envoye');
  });
});
