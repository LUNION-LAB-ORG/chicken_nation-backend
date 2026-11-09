/**
 * Changer de restaurant en un geste (demande du 09/11) : « si demain on veut
 * l'envoyer dans un autre restaurant, on doit le réaffecter et encore
 * vérifier le planning ». Ses plannings suivent : les créneaux qui n'ont pas
 * commencé quittent l'ancien restaurant et rejoignent le nouveau.
 *
 * Base : planning d'Angré du 26/10 au 08/11 (Koffi et Ali, créneaux 9 h et
 * 15 h), planning de Marcory sur la même période (Yao seul).
 */
import { RestDaySource, SchedulePlanStatus, ShiftType } from '@prisma/client';

import { debutCreneau, jourAVenir, premiersDebutsParJour } from '../helpers/planning.rules';
import { ALI, Base, jour, KOFFI, LIVREUR_B, monterBase, RESTO_A, RESTO_B } from './planning.base-simulee-spec';

/** Planning de Marcory, même période que celui d'Angré, Yao sur tous les créneaux. */
function planningMarcory(b: Base, statut: SchedulePlanStatus = SchedulePlanStatus.SENT) {
  const plan = b.ajouterPlan({
    restaurant_id: RESTO_B,
    period_start: jour('2026-10-26'),
    period_end: jour('2026-11-08'),
    status: statut,
  });
  for (let d = new Date(plan.period_start); d <= plan.period_end; d = new Date(d.getTime() + 86_400_000)) {
    for (const type of [ShiftType.MORNING, ShiftType.EVENING]) {
      const s = b.ajouterShift({
        plan_id: plan.id,
        date: d,
        type,
        start_time: type === ShiftType.MORNING ? '09:00' : '15:00',
        end_time: type === ShiftType.MORNING ? '15:00' : '23:00',
        max_slots: 3,
      });
      b.ajouterAffectation({ shift_id: s.id, deliverer_id: LIVREUR_B });
    }
  }
  return plan;
}

/** Créneaux de Koffi dans un planning, « AAAA-MM-JJ matin|soir ». */
function creneauxDe(b: Base, planId: string, livreur = KOFFI): string[] {
  return b.db.assignments
    .filter((a) => a.deliverer_id === livreur)
    .map((a) => b.db.shifts.find((s) => s.id === a.shift_id)!)
    .filter((s) => s.plan_id === planId)
    .map((s) => `${s.date.toISOString().slice(0, 10)} ${s.type === ShiftType.MORNING ? 'matin' : 'soir'}`)
    .sort();
}

/** Koffi passe d'Angré à Marcory (le rattachement est écrit avant, comme le fait le service des livreurs). */
async function deplacerKoffi(b: Base, maintenant: Date) {
  b.db.deliverers.find((d) => d.id === KOFFI)!.restaurant_id = RESTO_B;
  return b.planning.deplacerLivreur({
    delivererId: KOFFI,
    ancienRestaurantId: RESTO_A,
    nouveauRestaurantId: RESTO_B,
    maintenant,
  });
}

describe('règles : un jour passe au nouveau restaurant si son premier créneau n’a pas commencé', () => {
  const shifts = [
    { date: jour('2026-11-03'), start_time: '15:00' },
    { date: jour('2026-11-03'), start_time: '09:00' },
  ];
  const premiers = premiersDebutsParJour(shifts);

  it('début d’un créneau : jour et heure, à l’heure d’Abidjan (UTC)', () => {
    expect(debutCreneau(jour('2026-11-03'), '09:00').toISOString()).toBe('2026-11-03T09:00:00.000Z');
    expect(debutCreneau(jour('2026-11-03'), 'oups').toISOString()).toBe('2026-11-03T00:00:00.000Z');
    expect(premiers.get('2026-11-03')!.toISOString()).toBe('2026-11-03T09:00:00.000Z');
  });

  it('changement à 7 h : la journée part ; à 10 h : elle reste ; jour sans créneau : à partir du lendemain', () => {
    expect(jourAVenir('2026-11-03', premiers, new Date('2026-11-03T07:00:00Z'))).toBe(true);
    expect(jourAVenir('2026-11-03', premiers, new Date('2026-11-03T10:00:00Z'))).toBe(false);
    expect(jourAVenir('2026-11-04', premiers, new Date('2026-11-03T10:00:00Z'))).toBe(true);
    expect(jourAVenir('2026-11-03', new Map(), new Date('2026-11-03T07:00:00Z'))).toBe(false);
  });
});

describe('deplacerLivreur : les plannings suivent le changement de restaurant', () => {
  it('à 10 h le 03/11 : le matin reste à Angré, le soir et les jours suivants passent à Marcory', async () => {
    const b = monterBase();
    const angre = b.planningAngre(SchedulePlanStatus.SENT);
    const marcory = planningMarcory(b);

    const r = await deplacerKoffi(b, new Date('2026-11-03T10:00:00Z'));

    // Angré : tout jusqu'au 03/11 matin reste (le 02/11 est son repos, le 04/11 un repos posé par lui).
    const resteAngre = creneauxDe(b, angre.id);
    expect(resteAngre[resteAngre.length - 1]).toBe('2026-11-03 matin');
    expect(resteAngre).not.toContain('2026-11-03 soir');
    // Marcory : du 03/11 soir au 08/11 (seul livreur ajouté : repos les lundis, déjà passés).
    const marcoryKoffi = creneauxDe(b, marcory.id);
    expect(marcoryKoffi[0]).toBe('2026-11-03 soir');
    expect(marcoryKoffi).toHaveLength(1 + 5 * 2);
    expect(r).toEqual({
      retire_de: [{ plan_id: angre.id, restaurant_id: RESTO_A, creneaux: 1 + 4 * 2 }],
      ajoute_a: [{ plan_id: marcory.id, restaurant_id: RESTO_B, creneaux: 11 }],
    });
    // Ali et Yao ne bougent pas.
    expect(creneauxDe(b, angre.id, ALI).length).toBeGreaterThan(20);
    expect(creneauxDe(b, marcory.id, LIVREUR_B)).toHaveLength(28);
    // Prévenu une fois : « Nouveau planning » à Marcory, pas de « Planning modifié ».
    expect(b.push.notifyPlanSent).toHaveBeenCalledWith(expect.objectContaining({ delivererId: KOFFI, planId: marcory.id }));
    expect(b.push.notifyPlanModifie).not.toHaveBeenCalled();
  });

  it('à 7 h le 03/11 : la journée entière passe à Marcory', async () => {
    const b = monterBase();
    const angre = b.planningAngre(SchedulePlanStatus.SENT);
    const marcory = planningMarcory(b);

    const r = await deplacerKoffi(b, new Date('2026-11-03T07:00:00Z'));

    expect(creneauxDe(b, angre.id)).not.toContain('2026-11-03 matin');
    expect(creneauxDe(b, marcory.id)[0]).toBe('2026-11-03 matin');
    expect(r.retire_de[0].creneaux).toBe(2 + 4 * 2);
    expect(r.ajoute_a[0].creneaux).toBe(12);
  });

  it('les repos du planning à venir partent, le passé et ceux qu’il a posés lui-même restent', async () => {
    const b = monterBase();
    b.planningAngre(SchedulePlanStatus.SENT);
    b.ajouterRepos({ deliverer_id: KOFFI, date: jour('2026-11-06'), source: RestDaySource.MANUAL_ADMIN });

    await deplacerKoffi(b, new Date('2026-11-03T10:00:00Z'));

    const repos = b.db.restDays.filter((x) => x.deliverer_id === KOFFI).map((x) => `${x.date.toISOString().slice(0, 10)} ${x.source}`);
    expect(repos.sort()).toEqual(['2026-10-26 AUTO', '2026-11-02 AUTO', '2026-11-04 MANUAL_DELIVERER']);
  });

  it('aucun planning au nouveau restaurant : retiré d’Angré et prévenu « Planning modifié »', async () => {
    const b = monterBase();
    const angre = b.planningAngre(SchedulePlanStatus.CONFIRMED);

    const r = await deplacerKoffi(b, new Date('2026-11-03T10:00:00Z'));

    expect(r.ajoute_a).toEqual([]);
    expect(r.retire_de).toEqual([expect.objectContaining({ plan_id: angre.id })]);
    expect(b.push.notifyPlanModifie).toHaveBeenCalledTimes(1);
    expect(b.push.notifyPlanModifie).toHaveBeenCalledWith(expect.objectContaining({ delivererId: KOFFI, planId: angre.id }));
  });

  it('planning archivé ou déjà fini : jamais touché', async () => {
    const b = monterBase();
    const archive = b.planningAngre(SchedulePlanStatus.ARCHIVED);

    const r = await deplacerKoffi(b, new Date('2026-11-03T10:00:00Z'));
    const fini = await deplacerKoffi(b, new Date('2026-11-20T10:00:00Z'));

    expect(r.retire_de).toEqual([]);
    expect(fini.retire_de).toEqual([]);
    expect(creneauxDe(b, archive.id)).toContain('2026-11-08 soir');
  });

  it('déjà sur le planning du nouveau restaurant : rien n’est ajouté deux fois, aucune erreur', async () => {
    const b = monterBase();
    b.planningAngre(SchedulePlanStatus.SENT);
    const marcory = planningMarcory(b);
    await deplacerKoffi(b, new Date('2026-11-03T10:00:00Z'));

    const encore = await deplacerKoffi(b, new Date('2026-11-03T11:00:00Z'));

    expect(encore.ajoute_a).toEqual([]);
    expect(creneauxDe(b, marcory.id)).toHaveLength(11);
  });
});
