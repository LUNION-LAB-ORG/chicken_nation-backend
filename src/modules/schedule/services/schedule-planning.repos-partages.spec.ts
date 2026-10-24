/**
 * Repos partagés entre plannings (relecture du 24/10).
 *
 * Un repos (`RestDay`) appartient au livreur et à une date, pas à un
 * planning. Deux plannings peuvent couvrir le même jour : un planning archivé
 * et le planning en cours du même restaurant, ou les plannings de l'ancien et
 * du nouveau restaurant d'un livreur. Un geste sur l'un ne doit pas changer
 * en silence les repos que l'autre montre, et les repos d'un ancien
 * restaurant ne mettent pas le livreur sur le planning du nouveau.
 *
 * Services RÉELS, base en mémoire qui évalue les `where`.
 */
import { BadRequestException } from '@nestjs/common';
import { RestDaySource, SchedulePlanStatus, ShiftType } from '@prisma/client';

import {
  ALI,
  AWA,
  type Base,
  jour,
  KOFFI,
  LIVREUR_B,
  MANAGER_A,
  MANAGER_B,
  monterBase,
  RESTO_A,
  RESTO_B,
} from './planning.base-simulee-spec';

const { CONFIRMED, ARCHIVED } = SchedulePlanStatus;

/** Affectations d'un livreur dans un planning, ou un jour donné. */
function affectations(b: Base, planId: string, livreur: string, date?: string) {
  return b.db.assignments.filter(
    (a) =>
      a.deliverer_id === livreur &&
      a.shift.plan_id === planId &&
      (!date || a.shift.date.toISOString().slice(0, 10) === date),
  );
}
const reposDe = (b: Base, livreur: string) =>
  b.db.restDays
    .filter((r) => r.deliverer_id === livreur)
    .map((r) => `${r.date.toISOString().slice(0, 10)} ${r.source}`)
    .sort();

/**
 * Planning fait à la main : matin et soir chaque jour, chaque livreur affecté
 * hors de ses repos (posés par le calcul). Un repos qui existe déjà ce jour-là
 * pour ce livreur reste tel quel.
 */
function planningFait(
  b: Base,
  p: { restaurant: string; debut: string; fin: string; statut: SchedulePlanStatus; repos: Record<string, string[]> },
) {
  const plan = b.ajouterPlan({
    restaurant_id: p.restaurant,
    period_start: jour(p.debut),
    period_end: jour(p.fin),
    status: p.statut,
  });
  for (let d = jour(p.debut); d <= jour(p.fin); d = new Date(d.getTime() + 86_400_000)) {
    for (const type of [ShiftType.MORNING, ShiftType.EVENING]) {
      const s = b.ajouterShift({
        plan_id: plan.id,
        date: d,
        type,
        start_time: type === ShiftType.MORNING ? '09:00' : '15:00',
        end_time: type === ShiftType.MORNING ? '15:00' : '23:00',
        max_slots: 3,
      });
      const cle = d.toISOString().slice(0, 10);
      for (const [id, jours] of Object.entries(p.repos)) {
        if (!jours.includes(cle)) b.ajouterAffectation({ shift_id: s.id, deliverer_id: id });
      }
    }
  }
  for (const [id, jours] of Object.entries(p.repos)) {
    for (const j of jours) b.ajouterRepos({ deliverer_id: id, date: jour(j), source: RestDaySource.AUTO });
  }
  return plan;
}

const idsDesLivreurs = (liste: { id: string }[]) => liste.map((l) => l.id).sort();

describe('livreur passé dans un autre restaurant : le planning de l’ancien ne touche pas aux repos du nouveau', () => {
  let b: Base;
  let angre: Record<string, any>;
  let marcory: Record<string, any>;
  beforeEach(() => {
    b = monterBase();
    // Angré du 26/10 au 08/11 : Koffi au repos les 26/10 et 02/11, repos posé par lui le 04/11.
    angre = b.planningAngre(CONFIRMED);
    // Koffi est rattaché à Marcory, puis mis sur le planning confirmé de Marcory du 02/11 au 15/11.
    b.db.deliverers.find((d) => d.id === KOFFI)!.restaurant_id = RESTO_B;
    marcory = planningFait(b, {
      restaurant: RESTO_B,
      debut: '2026-11-02',
      fin: '2026-11-15',
      statut: CONFIRMED,
      repos: { [KOFFI]: ['2026-11-02', '2026-11-03', '2026-11-10'], [LIVREUR_B]: ['2026-11-05', '2026-11-12'] },
    });
  });

  /** Ses repos de Marcory (02/11, 03/11, 10/11) et le sien (04/11) ; celui d'Angré seul (26/10) part. */
  const REPOS_GARDES = ['2026-11-02 AUTO', '2026-11-03 AUTO', '2026-11-04 MANUAL_DELIVERER', '2026-11-10 AUTO'];

  it('le manager d’Angré le retire de son planning : ses affectations d’Angré partent, ses repos de Marcory restent', async () => {
    await b.controleur.removeDeliverer(b.requete(MANAGER_A, 'DELETE'), angre.id, KOFFI);

    expect(affectations(b, angre.id, KOFFI)).toHaveLength(0);
    expect(reposDe(b, KOFFI)).toEqual(REPOS_GARDES);
    expect(affectations(b, marcory.id, KOFFI)).toHaveLength(22);
    const detailMarcory = await b.controleur.getPlanDetail(b.requete(MANAGER_B, 'GET'), marcory.id);
    expect(idsDesLivreurs(detailMarcory.livreurs)).toEqual([KOFFI, LIVREUR_B].sort());
  });

  it('le manager d’Angré supprime son planning : les repos de Marcory restent', async () => {
    await b.controleur.deletePlan(b.requete(MANAGER_A, 'DELETE'), angre.id);
    expect(reposDe(b, KOFFI)).toEqual(REPOS_GARDES);
    expect(reposDe(b, ALI)).toEqual([]);
  });

  it('le manager d’Angré change les dates de son planning : les repos de Marcory restent', async () => {
    await b.controleur.regeneratePlan(b.requete(MANAGER_A, 'POST'), angre.id, {
      periodStart: '2026-11-16',
      periodEnd: '2026-11-29',
    });
    expect(reposDe(b, KOFFI)).toEqual(REPOS_GARDES);
  });
});

describe('les repos de l’ancien restaurant ne mettent pas le livreur sur le planning du nouveau', () => {
  let b: Base;
  let marcory: Record<string, any>;
  beforeEach(() => {
    b = monterBase();
    // Koffi est sur le planning confirmé d'Angré (repos 26/10 et 02/11), puis rattaché à Marcory.
    b.planningAngre(CONFIRMED);
    b.db.deliverers.find((d) => d.id === KOFFI)!.restaurant_id = RESTO_B;
    marcory = planningFait(b, {
      restaurant: RESTO_B,
      debut: '2026-10-26',
      fin: '2026-11-08',
      statut: CONFIRMED,
      repos: { [LIVREUR_B]: ['2026-10-28', '2026-11-04'] },
    });
  });

  it('Marcory : Koffi n’est pas dans la grille, il est proposé à l’ajout et peut être ajouté', async () => {
    const detail = await b.controleur.getPlanDetail(b.requete(MANAGER_B, 'GET'), marcory.id);
    expect(idsDesLivreurs(detail.livreurs)).toEqual([LIVREUR_B]);
    const ajoutables = await b.controleur.livreursAjoutables(b.requete(MANAGER_B, 'GET'), marcory.id);
    expect(idsDesLivreurs(ajoutables)).toEqual([KOFFI]);

    await expect(b.controleur.addDeliverer(b.requete(MANAGER_B, 'POST'), marcory.id, KOFFI)).resolves.toEqual({
      added: expect.any(Number),
    });
    expect(affectations(b, marcory.id, KOFFI).length).toBeGreaterThan(0);
  });

  it('Marcory supprime son planning : Koffi n’est pas prévenu, ses repos d’Angré restent', async () => {
    await b.controleur.deletePlan(b.requete(MANAGER_B, 'DELETE'), marcory.id);
    expect(b.push.notifyPlanModifie.mock.calls.map(([n]) => n.delivererId)).toEqual([LIVREUR_B]);
    expect(reposDe(b, KOFFI)).toEqual(['2026-10-26 AUTO', '2026-11-02 AUTO', '2026-11-04 MANUAL_DELIVERER']);
  });
});

describe('planning archivé qui chevauche le planning en cours du restaurant', () => {
  let b: Base;
  let archive: Record<string, any>;
  let enCours: Record<string, any>;
  beforeEach(() => {
    b = monterBase();
    // Archivé du 26/10 au 08/11 ; en cours (confirmé) du 02/11 au 15/11.
    // Jours communs : 02/11 au 08/11 (Koffi au repos le 02/11, Ali le 03/11).
    archive = b.planningAngre(ARCHIVED);
    enCours = planningFait(b, {
      restaurant: RESTO_A,
      debut: '2026-11-02',
      fin: '2026-11-15',
      statut: CONFIRMED,
      repos: { [KOFFI]: ['2026-11-02', '2026-11-04', '2026-11-09'], [ALI]: ['2026-11-03', '2026-11-10'] },
    });
  });

  const MESSAGE = 'Ce jour est dans le planning du 02/11 au 15/11 (Confirmé). Changez-le depuis ce planning.';

  it('archivé, jour du planning en cours passé au travail : refus qui nomme ce planning, son repos reste', async () => {
    await expect(
      b.controleur.setDelivererDay(b.requete(MANAGER_A), archive.id, KOFFI, { date: '2026-11-02', mode: 'WORK' }),
    ).rejects.toThrow(new BadRequestException(MESSAGE));
    expect(reposDe(b, KOFFI)).toContain('2026-11-02 AUTO');
    expect(affectations(b, archive.id, KOFFI, '2026-11-02')).toHaveLength(0);
    expect(b.audit.record).not.toHaveBeenCalled();
  });

  it('archivé, jour du planning en cours passé en repos : refus, aucun repos posé', async () => {
    await expect(
      b.controleur.setDelivererDay(b.requete(MANAGER_A), archive.id, ALI, { date: '2026-11-05', mode: 'REST' }),
    ).rejects.toThrow(new BadRequestException(MESSAGE));
    expect(reposDe(b, ALI)).not.toContain('2026-11-05 MANUAL_ADMIN');
    expect(affectations(b, archive.id, ALI, '2026-11-05')).toHaveLength(2);
    expect(affectations(b, enCours.id, ALI, '2026-11-05')).toHaveLength(2);
  });

  it('archivé, jour que seul l’archivé couvre : le geste passe, noté au journal', async () => {
    await b.controleur.setDelivererDay(b.requete(MANAGER_A), archive.id, KOFFI, { date: '2026-10-27', mode: 'REST' });
    expect(reposDe(b, KOFFI)).toContain('2026-10-27 MANUAL_ADMIN');
    expect(b.audit.record).toHaveBeenCalledTimes(1);
  });

  it('retrait de l’archivé : ses repos du planning en cours restent, il reste sur ce planning', async () => {
    await b.controleur.removeDeliverer(b.requete(MANAGER_A, 'DELETE'), archive.id, KOFFI);
    expect(affectations(b, archive.id, KOFFI)).toHaveLength(0);
    expect(reposDe(b, KOFFI)).toEqual(['2026-11-02 AUTO', '2026-11-04 MANUAL_DELIVERER', '2026-11-09 AUTO']);
    const detail = await b.controleur.getPlanDetail(b.requete(MANAGER_A, 'GET'), enCours.id);
    expect(idsDesLivreurs(detail.livreurs)).toEqual([ALI, KOFFI].sort());
    expect(affectations(b, enCours.id, KOFFI)).toHaveLength(22);
  });

  it('ajout à l’archivé : aucun repos posé sur les jours du planning en cours, le livreur n’y entre pas', async () => {
    await b.controleur.addDeliverer(b.requete(MANAGER_A, 'POST'), archive.id, AWA);
    // Repos du calcul pour un livreur seul : les lundis 26/10 et 02/11 ; le 02/11 est au planning en cours.
    expect(reposDe(b, AWA)).toEqual(['2026-10-26 AUTO']);
    const detail = await b.controleur.getPlanDetail(b.requete(MANAGER_A, 'GET'), enCours.id);
    expect(idsDesLivreurs(detail.livreurs)).toEqual([ALI, KOFFI].sort());
    const ajoutables = await b.controleur.livreursAjoutables(b.requete(MANAGER_A, 'GET'), enCours.id);
    expect(idsDesLivreurs(ajoutables)).toEqual([AWA]);
  });

  it('un livreur du seul planning en cours n’apparaît pas dans l’archivé par ses repos', async () => {
    await b.controleur.addDeliverer(b.requete(MANAGER_A, 'POST'), enCours.id, AWA);
    expect(reposDe(b, AWA)).toContain('2026-11-02 AUTO');
    const detail = await b.controleur.getPlanDetail(b.requete(MANAGER_A, 'GET'), archive.id);
    expect(idsDesLivreurs(detail.livreurs)).toEqual([ALI, KOFFI].sort());
  });

  it('le planning en cours reste libre : jour changé et retrait passent, même sur les jours de l’archivé', async () => {
    await b.controleur.setDelivererDay(b.requete(MANAGER_A), enCours.id, KOFFI, { date: '2026-11-02', mode: 'WORK' });
    expect(reposDe(b, KOFFI)).not.toContain('2026-11-02 AUTO');
    expect(affectations(b, enCours.id, KOFFI, '2026-11-02')).toHaveLength(2);

    await b.controleur.removeDeliverer(b.requete(MANAGER_A, 'DELETE'), enCours.id, ALI);
    // Son repos du 03/11, commun avec l'archivé, part aussi : sinon il resterait sur le planning en cours.
    expect(reposDe(b, ALI)).toEqual(['2026-10-27 AUTO']);
    const detail = await b.controleur.getPlanDetail(b.requete(MANAGER_A, 'GET'), enCours.id);
    expect(idsDesLivreurs(detail.livreurs)).toEqual([KOFFI]);
  });
});
