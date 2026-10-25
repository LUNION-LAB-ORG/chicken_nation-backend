/**
 * Planning modifiable dans ses quatre états (conception du 24/10, 11.6), de
 * bout en bout depuis le contrôleur : compte connecté lu dans `req.user`,
 * services et tâches planifiées RÉELS, base en mémoire qui évalue les `where`.
 *
 * Pour chaque état (Brouillon, Envoyé, Confirmé, Archivé) et chaque geste
 * (changer un jour, ajouter, retirer, modifier les dates, supprimer) : ce qui
 * change en base, qui est prévenu (envoyé ou confirmé seulement, une
 * notification par geste) et ce qui va au journal (archivé, et suppression
 * d'un planning confirmé). Puis le cloisonnement par restaurant.
 */
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { RestDaySource, SchedulePlanStatus, ShiftAssignmentStatus } from '@prisma/client';

import {
  MESSAGE_GENERER_AUTRE_RESTAURANT,
  MESSAGE_PLANNING_AUTRE_RESTAURANT,
} from '../helpers/planning.rules';
import {
  ADMIN,
  ALI,
  AWA,
  type Base,
  jour,
  KOFFI,
  LIVREUR_B,
  MANAGER_A,
  MANAGER_B,
  monterBase,
  OPS,
  RESTO_A,
  RESTO_B,
  SUSPENDU,
} from './planning.base-simulee-spec';

const { DRAFT, SENT, CONFIRMED, ARCHIVED } = SchedulePlanStatus;
const ETATS = [DRAFT, SENT, CONFIRMED, ARCHIVED] as const;
const NOM: Record<SchedulePlanStatus, string> = {
  DRAFT: 'Brouillon',
  SENT: 'Envoyé',
  CONFIRMED: 'Confirmé',
  ARCHIVED: 'Archivé',
};
const prevenu = (s: SchedulePlanStatus) => s === SENT || s === CONFIRMED;

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

describe.each(ETATS)('planning %s', (statut) => {
  let b: Base;
  let plan: Record<string, any>;
  beforeEach(() => {
    b = monterBase();
    plan = b.planningAngre(statut);
  });

  const enTete = `Planning ${
    { DRAFT: 'en brouillon', SENT: 'envoyé', CONFIRMED: 'confirmé', ARCHIVED: 'archivé' }[statut]
  } d'Angré (26/10 au 08/11)`;

  describe('changer un jour', () => {
    it('travail → repos : affectations du jour retirées, repos posé par le restaurant', async () => {
      await b.controleur.setDelivererDay(b.requete(MANAGER_A), plan.id, KOFFI, { date: '2026-10-27', mode: 'REST' });

      expect(affectations(b, plan.id, KOFFI, '2026-10-27')).toHaveLength(0);
      expect(reposDe(b, KOFFI)).toContain('2026-10-27 MANUAL_ADMIN');
      // Les autres jours ne bougent pas.
      expect(affectations(b, plan.id, KOFFI, '2026-10-28')).toHaveLength(2);

      if (prevenu(statut)) {
        expect(b.push.notifyPlanModifie).toHaveBeenCalledTimes(1);
        expect(b.push.notifyPlanModifie).toHaveBeenCalledWith({
          delivererId: KOFFI,
          planId: plan.id,
          type: 'plan_modifie',
          titre: 'Planning modifié',
          texte: 'Mar. 27/10 : repos',
        });
      } else {
        expect(b.push.notifyPlanModifie).not.toHaveBeenCalled();
      }
      expect(b.push.notifyPlanSent).not.toHaveBeenCalled();

      if (statut === ARCHIVED) {
        expect(b.audit.record).toHaveBeenCalledTimes(1);
        expect(b.audit.record).toHaveBeenCalledWith(
          expect.objectContaining({
            actor_id: MANAGER_A.id,
            actor_name: 'Manager Angré',
            actor_role: 'MANAGER',
            restaurant_id: RESTO_A,
            action: 'PLANNING_ARCHIVE_MODIFIE',
            module: 'schedule',
            entity_id: plan.id,
            method: 'PATCH',
            path: '/api/v1/schedule/plans',
            summary: `${enTete} : Koffi Yao en repos le 27/10`,
          }),
        );
      } else {
        expect(b.audit.record).not.toHaveBeenCalled();
      }
    });

    it('repos → travail : affectations matin et soir recréées en attente, notification « à confirmer »', async () => {
      await b.controleur.setDelivererDay(b.requete(ADMIN), plan.id, KOFFI, { date: '2026-10-26', mode: 'WORK' });

      const jourTravaille = affectations(b, plan.id, KOFFI, '2026-10-26');
      expect(jourTravaille).toHaveLength(2);
      expect(jourTravaille.every((a) => a.status === ShiftAssignmentStatus.ASSIGNED)).toBe(true);
      expect(reposDe(b, KOFFI)).not.toContain('2026-10-26 AUTO');

      if (prevenu(statut)) {
        expect(b.push.notifyPlanModifie).toHaveBeenCalledWith({
          delivererId: KOFFI,
          planId: plan.id,
          type: 'plan_sent',
          titre: 'Planning modifié',
          texte: 'Lun. 26/10 : créneaux à confirmer',
        });
      } else {
        expect(b.push.notifyPlanModifie).not.toHaveBeenCalled();
      }
      if (statut === ARCHIVED) {
        expect(b.audit.record).toHaveBeenCalledWith(
          expect.objectContaining({ summary: `${enTete} : Koffi Yao au travail le 26/10` }),
        );
      }
    });

    it('le même choix deux fois : un seul geste, une seule notification, une seule ligne au journal', async () => {
      const req = b.requete(ADMIN);
      await b.controleur.setDelivererDay(req, plan.id, KOFFI, { date: '2026-10-27', mode: 'REST' });
      await b.controleur.setDelivererDay(req, plan.id, KOFFI, { date: '2026-10-27', mode: 'REST' });
      expect(b.push.notifyPlanModifie).toHaveBeenCalledTimes(prevenu(statut) ? 1 : 0);
      expect(b.audit.record).toHaveBeenCalledTimes(statut === ARCHIVED ? 1 : 0);
    });

    it('pas de repos un vendredi : refus avec la phrase de l’écran, rien ne change', async () => {
      await expect(
        b.controleur.setDelivererDay(b.requete(ADMIN), plan.id, KOFFI, { date: '2026-10-30', mode: 'REST' }),
      ).rejects.toThrow(new BadRequestException('Repos interdit ce jour-là : jour de forte activité.'));
      expect(affectations(b, plan.id, KOFFI, '2026-10-30')).toHaveLength(2);
      expect(b.push.notifyPlanModifie).not.toHaveBeenCalled();
    });

    it('jour hors du planning : refus', async () => {
      await expect(
        b.controleur.setDelivererDay(b.requete(ADMIN), plan.id, KOFFI, { date: '2026-11-09', mode: 'WORK' }),
      ).rejects.toThrow("Ce jour n'est pas dans le planning.");
    });
  });

  describe('ajouter un livreur', () => {
    it('livreurs ajoutables : actifs du restaurant hors planning seulement', async () => {
      const liste = await b.controleur.livreursAjoutables(b.requete(MANAGER_A, 'GET'), plan.id);
      // Ni Koffi ni Ali (déjà dessus), ni le suspendu, ni le livreur de Marcory.
      expect(liste).toEqual([{ id: AWA, first_name: 'Awa', last_name: 'Koné', image: null }]);
    });

    it('ajout : affectations hors de ses repos, prévenu par « Nouveau planning » si envoyé ou confirmé', async () => {
      const res = await b.controleur.addDeliverer(b.requete(MANAGER_A, 'POST'), plan.id, AWA);

      expect(res.added).toBeGreaterThan(0);
      expect(affectations(b, plan.id, AWA)).toHaveLength(res.added);
      if (prevenu(statut)) {
        expect(b.push.notifyPlanSent).toHaveBeenCalledWith({
          delivererId: AWA,
          periodStart: '2026-10-26',
          periodEnd: '2026-11-08',
          planId: plan.id,
        });
      } else {
        expect(b.push.notifyPlanSent).not.toHaveBeenCalled();
      }
      expect(b.push.notifyPlanModifie).not.toHaveBeenCalled();
      if (statut === ARCHIVED) {
        expect(b.audit.record).toHaveBeenCalledWith(
          expect.objectContaining({
            action: 'PLANNING_ARCHIVE_MODIFIE',
            method: 'POST',
            summary: `${enTete} : Awa Koné ajoutée`,
          }),
        );
      } else {
        expect(b.audit.record).not.toHaveBeenCalled();
      }
      // Elle n'est plus ajoutable.
      expect(await b.controleur.livreursAjoutables(b.requete(ADMIN, 'GET'), plan.id)).toEqual([]);
    });

    it('déjà sur le planning, ou livreur inactif ou d’un autre restaurant : refus', async () => {
      const req = b.requete(ADMIN, 'POST');
      await expect(b.controleur.addDeliverer(req, plan.id, KOFFI)).rejects.toThrow(
        'Ce livreur est déjà sur ce planning.',
      );
      await expect(b.controleur.addDeliverer(req, plan.id, SUSPENDU)).rejects.toThrow(
        "Ce livreur n'est pas actif dans ce restaurant.",
      );
      await expect(b.controleur.addDeliverer(req, plan.id, LIVREUR_B)).rejects.toThrow(
        "Ce livreur n'est pas actif dans ce restaurant.",
      );
      expect(b.push.notifyPlanSent).not.toHaveBeenCalled();
    });
  });

  describe('retirer un livreur', () => {
    it('retrait : ses affectations et les repos du planning effacés, ceux qu’il a posés restent', async () => {
      const res = await b.controleur.removeDeliverer(b.requete(MANAGER_A, 'DELETE'), plan.id, KOFFI);

      expect(res.removed).toBe(22); // 14 jours - 3 jours sans affectation, matin et soir
      expect(affectations(b, plan.id, KOFFI)).toHaveLength(0);
      expect(reposDe(b, KOFFI)).toEqual(['2026-11-04 MANUAL_DELIVERER']);
      // Ali ne bouge pas.
      expect(affectations(b, plan.id, ALI)).toHaveLength(24);
      expect(reposDe(b, ALI)).toEqual(['2026-10-27 AUTO', '2026-11-03 AUTO']);

      if (prevenu(statut)) {
        expect(b.push.notifyPlanModifie).toHaveBeenCalledTimes(1);
        expect(b.push.notifyPlanModifie).toHaveBeenCalledWith({
          delivererId: KOFFI,
          planId: plan.id,
          type: 'plan_modifie',
          titre: 'Planning modifié',
          texte: "Tu n'es plus sur le planning du 26/10 au 08/11",
        });
      } else {
        expect(b.push.notifyPlanModifie).not.toHaveBeenCalled();
      }
      expect(b.push.notifyPlanSent).not.toHaveBeenCalled();
      if (statut === ARCHIVED) {
        expect(b.audit.record).toHaveBeenCalledWith(
          expect.objectContaining({
            action: 'PLANNING_ARCHIVE_MODIFIE',
            method: 'DELETE',
            summary: `${enTete} : Koffi Yao retiré`,
          }),
        );
      } else {
        expect(b.audit.record).not.toHaveBeenCalled();
      }

      // Il redevient ajoutable, et le retirer encore est refusé.
      const ajoutables = await b.controleur.livreursAjoutables(b.requete(ADMIN, 'GET'), plan.id);
      expect(ajoutables.map((l) => l.id).sort()).toEqual([AWA, KOFFI].sort());
      await expect(b.controleur.removeDeliverer(b.requete(ADMIN, 'DELETE'), plan.id, KOFFI)).rejects.toThrow(
        new BadRequestException("Ce livreur n'est pas sur ce planning."),
      );
    });

    it('un livreur en repos tous les jours reste sur le planning, et peut en être retiré', async () => {
      // Awa n'a aucune affectation, seulement des repos posés par le restaurant.
      b.ajouterRepos({ deliverer_id: AWA, date: jour('2026-10-28'), source: RestDaySource.MANUAL_ADMIN });

      const detail = await b.controleur.getPlanDetail(b.requete(ADMIN, 'GET'), plan.id);
      expect(detail.livreurs.map((l) => l.first_name)).toEqual(['Ali', 'Awa', 'Koffi']);
      expect(await b.controleur.livreursAjoutables(b.requete(ADMIN, 'GET'), plan.id)).toEqual([]);

      await b.controleur.removeDeliverer(b.requete(ADMIN, 'DELETE'), plan.id, AWA);
      expect(reposDe(b, AWA)).toEqual([]);
      const apres = await b.controleur.getPlanDetail(b.requete(ADMIN, 'GET'), plan.id);
      expect(apres.livreurs.map((l) => l.first_name)).toEqual(['Ali', 'Koffi']);
    });

    it('les repos d’un livreur d’un autre restaurant ne le mettent pas sur le planning', async () => {
      b.ajouterRepos({ deliverer_id: LIVREUR_B, date: jour('2026-10-28'), source: RestDaySource.AUTO });
      const detail = await b.controleur.getPlanDetail(b.requete(ADMIN, 'GET'), plan.id);
      expect(detail.livreurs.map((l) => l.id)).toEqual([ALI, KOFFI]);
      expect(detail.repos.map((r) => r.deliverer_id)).not.toContain(LIVREUR_B);
    });

    it('un repos posé par le livreur seul ne le met pas sur le planning', async () => {
      b.ajouterRepos({ deliverer_id: AWA, date: jour('2026-10-28'), source: RestDaySource.MANUAL_DELIVERER });
      await expect(b.controleur.removeDeliverer(b.requete(ADMIN, 'DELETE'), plan.id, AWA)).rejects.toThrow(
        "Ce livreur n'est pas sur ce planning.",
      );
    });
  });

  describe('modifier les dates', () => {
    it('le planning est refait en brouillon pour les nouvelles dates, l’ancien disparaît', async () => {
      const neuf = await b.controleur.regeneratePlan(b.requete(MANAGER_A, 'POST'), plan.id, {
        periodStart: '2026-11-02',
        periodEnd: '2026-11-15',
      });

      expect(neuf.status).toBe(DRAFT);
      expect(neuf.restaurant_id).toBe(RESTO_A);
      expect(b.db.plans.map((p) => p.id)).toEqual([neuf.id]);
      expect(b.db.shifts.every((s) => s.plan_id === neuf.id)).toBe(true);
      // Les repos de l'ancien planning sont partis, sauf celui que Koffi a posé ;
      // le nouveau a les siens, tous dans sa période.
      expect(reposDe(b, KOFFI)).toContain('2026-11-04 MANUAL_DELIVERER');
      expect(reposDe(b, KOFFI)).not.toContain('2026-10-26 AUTO');
      expect(
        b.db.restDays
          .filter((r) => r.source === RestDaySource.AUTO)
          .every((r) => r.date >= jour('2026-11-02') && r.date <= jour('2026-11-15')),
      ).toBe(true);

      if (prevenu(statut)) {
        expect(b.push.notifyPlanModifie).toHaveBeenCalledTimes(2);
        for (const livreur of [KOFFI, ALI]) {
          expect(b.push.notifyPlanModifie).toHaveBeenCalledWith({
            delivererId: livreur,
            planId: plan.id,
            type: 'plan_modifie',
            titre: 'Planning modifié',
            texte: 'Le planning du 26/10 au 08/11 est refait',
          });
        }
      } else {
        expect(b.push.notifyPlanModifie).not.toHaveBeenCalled();
      }
      // Le nouveau est un brouillon : personne ne reçoit « Nouveau planning ».
      expect(b.push.notifyPlanSent).not.toHaveBeenCalled();
      if (statut === ARCHIVED) {
        expect(b.audit.record).toHaveBeenCalledWith(
          expect.objectContaining({
            action: 'PLANNING_ARCHIVE_MODIFIE',
            entity_id: plan.id,
            summary: `${enTete} : dates changées pour le 02/11 au 15/11`,
          }),
        );
      } else {
        expect(b.audit.record).not.toHaveBeenCalled();
      }
    });

    it('échec (un autre planning couvre ces dates) : l’ancien planning revient tel quel, repos compris', async () => {
      b.ajouterPlan({
        restaurant_id: RESTO_A,
        period_start: jour('2026-11-10'),
        period_end: jour('2026-11-23'),
        status: DRAFT,
      });
      const avant = { statut: b.db.plans[0].status, archive: b.db.plans[0].archived_at, repos: reposDe(b, KOFFI) };

      await expect(
        b.controleur.regeneratePlan(b.requete(ADMIN, 'POST'), plan.id, {
          periodStart: '2026-11-09',
          periodEnd: '2026-11-15',
        }),
      ).rejects.toThrow(BadRequestException);

      const ancien = b.db.plans.find((p) => p.id === plan.id)!;
      expect({ statut: ancien.status, archive: ancien.archived_at, repos: reposDe(b, KOFFI) }).toEqual(avant);
      expect(affectations(b, plan.id, KOFFI)).toHaveLength(22);
      expect(b.push.notifyPlanModifie).not.toHaveBeenCalled();
      expect(b.audit.record).not.toHaveBeenCalled();
    });
  });

  describe('supprimer', () => {
    it('planning, créneaux et affectations effacés ; livreurs prévenus lus avant la suppression', async () => {
      const res = await b.controleur.deletePlan(b.requete(MANAGER_A, 'DELETE'), plan.id);

      expect(res).toEqual({ id: plan.id, deleted: true });
      expect(b.db.plans).toHaveLength(0);
      expect(b.db.shifts).toHaveLength(0);
      expect(b.db.assignments).toHaveLength(0);
      // Le livreur ne voit plus ces repos ; celui qu'il a posé reste.
      expect(b.db.restDays.map((r) => `${r.deliverer_id} ${r.source}`)).toEqual([
        `${KOFFI} MANUAL_DELIVERER`,
      ]);

      if (prevenu(statut)) {
        expect(b.push.notifyPlanModifie).toHaveBeenCalledTimes(2);
        for (const livreur of [KOFFI, ALI]) {
          expect(b.push.notifyPlanModifie).toHaveBeenCalledWith({
            delivererId: livreur,
            planId: plan.id,
            type: 'plan_modifie',
            titre: 'Planning annulé',
            texte: 'Le planning du 26/10 au 08/11 est annulé',
          });
        }
      } else {
        expect(b.push.notifyPlanModifie).not.toHaveBeenCalled();
      }

      if (statut === CONFIRMED || statut === ARCHIVED) {
        expect(b.audit.record).toHaveBeenCalledTimes(1);
        expect(b.audit.record).toHaveBeenCalledWith(
          expect.objectContaining({
            action: 'PLANNING_SUPPRIME',
            module: 'schedule',
            entity_id: plan.id,
            method: 'DELETE',
            summary: `${enTete} supprimé`,
          }),
        );
      } else {
        expect(b.audit.record).not.toHaveBeenCalled();
      }

      // Un second clic : le planning n'existe plus.
      await expect(b.controleur.deletePlan(b.requete(ADMIN, 'DELETE'), plan.id)).rejects.toThrow(NotFoundException);
    });

    it('les repos des jours couverts par un autre planning du restaurant restent', async () => {
      b.ajouterPlan({
        restaurant_id: RESTO_A,
        period_start: jour('2026-10-19'),
        period_end: jour('2026-11-01'),
        status: ARCHIVED,
      });
      await b.controleur.deletePlan(b.requete(ADMIN, 'DELETE'), plan.id);
      expect(reposDe(b, KOFFI)).toEqual(['2026-10-26 AUTO', '2026-11-04 MANUAL_DELIVERER']);
      expect(reposDe(b, ALI)).toEqual(['2026-10-27 AUTO']);
    });
  });

  it(`détail : livreurs, repos et règles (${NOM[statut]})`, async () => {
    const detail = await b.controleur.getPlanDetail(b.requete(OPS, 'GET'), plan.id);
    // Les champs d'avant restent.
    expect(detail.restaurant).toEqual({ id: RESTO_A, name: 'Angré', address: undefined });
    expect(detail.shifts).toHaveLength(28);
    expect(detail.shifts[0].assignments[0].deliverer).toEqual(
      expect.objectContaining({ id: expect.any(String), phone: expect.any(String) }),
    );
    expect(detail.livreurs).toEqual([
      { id: ALI, first_name: 'Ali', last_name: 'Traoré', image: null },
      { id: KOFFI, first_name: 'Koffi', last_name: 'Yao', image: null },
    ]);
    expect(detail.repos).toEqual(
      expect.arrayContaining([
        { deliverer_id: KOFFI, date: jour('2026-10-26'), source: RestDaySource.AUTO },
        { deliverer_id: KOFFI, date: jour('2026-11-04'), source: RestDaySource.MANUAL_DELIVERER },
      ]),
    );
    expect(detail.repos).toHaveLength(5);
    expect(detail.regles).toEqual({ jours_sans_repos: ['friday', 'saturday', 'sunday'] });
  });
});

describe('transitions : prises atomiques', () => {
  it('envoyer deux fois : un seul envoi, chaque livreur prévenu une fois', async () => {
    const b = monterBase();
    const plan = b.planningAngre(DRAFT);
    await b.controleur.sendPlan(b.requete(MANAGER_A), plan.id);
    await expect(b.controleur.sendPlan(b.requete(MANAGER_A), plan.id)).rejects.toThrow(
      'Seul un planning en brouillon peut être envoyé.',
    );
    expect(b.db.plans[0].status).toBe(SENT);
    expect(b.push.notifyPlanSent).toHaveBeenCalledTimes(2); // Koffi et Ali
  });

  it('confirmer deux fois : refus la seconde fois', async () => {
    const b = monterBase();
    const plan = b.planningAngre(SENT);
    const confirme = await b.controleur.confirmPlan(b.requete(ADMIN), plan.id);
    expect(confirme.status).toBe(CONFIRMED);
    await expect(b.controleur.confirmPlan(b.requete(ADMIN), plan.id)).rejects.toThrow(
      'Seul un planning envoyé peut être confirmé.',
    );
  });

  it('confirmer pendant qu’un autre geste change l’état : refus, rien n’est écrasé', async () => {
    const b = monterBase();
    const plan = b.planningAngre(SENT);
    // L'état change entre la lecture et l'écriture (tâche planifiée, autre écran).
    const lire = b.prisma.schedulePlan.findUnique.getMockImplementation()!;
    b.prisma.schedulePlan.findUnique.mockImplementationOnce(async (a: unknown) => {
      const lu = await lire(a);
      b.db.plans[0].status = ARCHIVED;
      return lu;
    });
    await expect(b.planning.confirmPlan(plan.id)).rejects.toThrow(ConflictException);
    expect(b.db.plans[0].status).toBe(ARCHIVED);
  });

  it('archiver deux fois : le planning est rendu tel quel, date d’archivage inchangée', async () => {
    const b = monterBase();
    const plan = b.planningAngre(CONFIRMED);
    const premier = await b.controleur.archivePlan(b.requete(ADMIN), plan.id);
    const second = await b.controleur.archivePlan(b.requete(ADMIN), plan.id);
    expect(second.status).toBe(ARCHIVED);
    expect(second.archived_at).toEqual(premier.archived_at);
  });

  it('supprimer un planning dont l’état vient de changer : refus, le planning reste', async () => {
    const b = monterBase();
    const plan = b.planningAngre(SENT);
    const lire = b.prisma.schedulePlan.findUnique.getMockImplementation()!;
    b.prisma.schedulePlan.findUnique
      .mockImplementationOnce(lire) // contrôleur : cloisonnement
      .mockImplementationOnce(async (a: unknown) => {
        const lu = await lire(a);
        b.db.plans[0].status = CONFIRMED;
        return lu;
      });
    await expect(b.controleur.deletePlan(b.requete(ADMIN, 'DELETE'), plan.id)).rejects.toThrow(
      new ConflictException('Ce planning vient de changer. Rechargez la page.'),
    );
    expect(b.db.plans).toHaveLength(1);
    expect(b.push.notifyPlanModifie).not.toHaveBeenCalled();
  });
});

describe('tâches planifiées après ces changements', () => {
  it('closeOverduePlans : un planning envoyé dont le délai est passé est confirmé, une seule fois', async () => {
    const b = monterBase();
    const plan = b.planningAngre(SENT, { sent_at: new Date(Date.now() - 49 * 3600_000) });
    await b.taches.closeOverduePlans();
    await b.taches.closeOverduePlans();
    const p = b.db.plans.find((x) => x.id === plan.id)!;
    expect(p.status).toBe(CONFIRMED);
    expect(p.confirmed_count).toBe(2);
    expect(b.db.assignments.every((a) => a.status === ShiftAssignmentStatus.CONFIRMED)).toBe(true);
  });

  it('closeOverduePlans : un planning envoyé récemment ne bouge pas', async () => {
    const b = monterBase();
    b.planningAngre(SENT, { sent_at: new Date() });
    await b.taches.closeOverduePlans();
    expect(b.db.plans[0].status).toBe(SENT);
  });

  it('archiveOldPlans : un planning confirmé terminé est archivé, la seconde passe ne change rien', async () => {
    const b = monterBase();
    const ancien = b.ajouterPlan({
      restaurant_id: RESTO_A,
      period_start: jour('2020-01-06'),
      period_end: jour('2020-01-19'),
      status: CONFIRMED,
    });
    await b.taches.archiveOldPlans();
    const archiveLe = b.db.plans.find((p) => p.id === ancien.id)!.archived_at;
    expect(b.db.plans.find((p) => p.id === ancien.id)!.status).toBe(ARCHIVED);
    await b.taches.archiveOldPlans();
    expect(b.db.plans.find((p) => p.id === ancien.id)!.archived_at).toBe(archiveLe);
  });
});

describe('cloisonnement par restaurant', () => {
  let b: Base;
  let planMarcory: Record<string, any>;
  beforeEach(() => {
    b = monterBase();
    b.planningAngre(CONFIRMED);
    planMarcory = b.ajouterPlan({
      restaurant_id: RESTO_B,
      period_start: jour('2026-10-26'),
      period_end: jour('2026-11-08'),
      status: CONFIRMED,
    });
  });

  it('un manager d’Angré reçoit 403 sur chaque route d’un planning de Marcory, et rien ne change', async () => {
    const req = b.requete(MANAGER_A);
    const c = b.controleur;
    const id = planMarcory.id;
    const appels: [string, () => Promise<unknown>][] = [
      ['détail', () => c.getPlanDetail(req, id)],
      ['compteurs', () => c.getPlanStats(req, id)],
      ['envoyer', () => c.sendPlan(req, id)],
      ['confirmer', () => c.confirmPlan(req, id)],
      ['archiver', () => c.archivePlan(req, id)],
      ['supprimer', () => c.deletePlan(req, id)],
      ['jour', () => c.setDelivererDay(req, id, LIVREUR_B, { date: '2026-10-27', mode: 'REST' })],
      ['ajoutables', () => c.livreursAjoutables(req, id)],
      ['ajouter', () => c.addDeliverer(req, id, LIVREUR_B)],
      ['retirer', () => c.removeDeliverer(req, id, LIVREUR_B)],
      ['dates', () => c.regeneratePlan(req, id, { periodStart: '2026-11-02' })],
    ];
    for (const [nom, appel] of appels) {
      const issue = await appel().then(
        () => 'passé',
        (e: Error) => [e.constructor.name, e.message],
      );
      expect([nom, issue]).toEqual([nom, ['ForbiddenException', MESSAGE_PLANNING_AUTRE_RESTAURANT]]);
    }
    expect(b.db.plans.find((p) => p.id === id)!.status).toBe(CONFIRMED);
    expect(b.push.notifyPlanModifie).not.toHaveBeenCalled();
    expect(b.push.notifyPlanSent).not.toHaveBeenCalled();
    expect(b.audit.record).not.toHaveBeenCalled();
  });

  it('liste : un manager ne voit que les plannings de son restaurant, même s’il en demande un autre', async () => {
    const liste = await b.controleur.listPlans(b.requete(MANAGER_A, 'GET'), RESTO_B);
    expect(liste.map((p) => p.restaurant_id)).toEqual([RESTO_A]);
    const siege = await b.controleur.listPlans(b.requete(OPS, 'GET'));
    expect(siege.map((p) => p.restaurant_id).sort()).toEqual([RESTO_A, RESTO_B].sort());
    const filtre = await b.controleur.listPlans(b.requete(ADMIN, 'GET'), RESTO_B);
    expect(filtre.map((p) => p.restaurant_id)).toEqual([RESTO_B]);
  });

  it('nouveau planning : un manager ne le fait que pour son restaurant', async () => {
    await expect(
      b.controleur.generatePlan(b.requete(MANAGER_B, 'POST'), {
        restaurantId: RESTO_A,
        periodStart: jour('2026-11-09'),
      }),
    ).rejects.toThrow(new ForbiddenException(MESSAGE_GENERER_AUTRE_RESTAURANT));
    const neuf = await b.controleur.generatePlan(b.requete(MANAGER_B, 'POST'), {
      restaurantId: RESTO_B,
      periodStart: jour('2026-11-09'),
    });
    expect(neuf.restaurant_id).toBe(RESTO_B);
  });

  it('l’administrateur agit sur tous les restaurants ; le manager sur le sien', async () => {
    await expect(b.controleur.getPlanStats(b.requete(ADMIN, 'GET'), planMarcory.id)).resolves.toBeDefined();
    const angre = b.db.plans.find((p) => p.restaurant_id === RESTO_A)!;
    await expect(b.controleur.removeDeliverer(b.requete(MANAGER_A, 'DELETE'), angre.id, ALI)).resolves.toEqual({
      removed: 24,
    });
  });

  it('planning inconnu : 404', async () => {
    await expect(
      b.controleur.getPlanDetail(b.requete(ADMIN, 'GET'), '00000000-0000-4000-8000-000000000000'),
    ).rejects.toThrow(new NotFoundException("Ce planning n'existe plus."));
  });
});

describe('aperçu des plannings', () => {
  it('en cours avec ses réponses, suivant, prévus aujourd’hui ; restaurant sans planning : « Aucun »', async () => {
    const b = monterBase();
    const enCours = b.planningAngre(CONFIRMED);
    // Une réponse de chaque sorte, un refus d'Ali le mercredi 28/10 au soir.
    const ali28 = b.db.assignments.filter(
      (a) => a.deliverer_id === ALI && a.shift.date.toISOString().startsWith('2026-10-28'),
    );
    ali28[0].status = ShiftAssignmentStatus.REFUSED;
    ali28[1].status = ShiftAssignmentStatus.CONFIRMED;
    const suivant = b.ajouterPlan({
      restaurant_id: RESTO_A,
      period_start: jour('2026-11-09'),
      period_end: jour('2026-11-22'),
      status: DRAFT,
    });
    // Un archivé qui couvre aujourd'hui ne compte pas.
    b.ajouterPlan({
      restaurant_id: RESTO_B,
      period_start: jour('2026-10-26'),
      period_end: jour('2026-11-08'),
      status: ARCHIVED,
    });

    const apercu = await b.requetes.apercu(ADMIN, undefined, new Date('2026-10-28T10:00:00Z'));

    expect(apercu).toEqual([
      {
        restaurant: { id: RESTO_A, nom: 'Angré' },
        en_cours: {
          id: enCours.id,
          statut: CONFIRMED,
          debut: jour('2026-10-26'),
          fin: jour('2026-11-08'),
          reponses: { confirmees: 1, en_attente: 44, refusees: 1 },
        },
        suivant: { id: suivant.id, statut: DRAFT, debut: jour('2026-11-09'), fin: jour('2026-11-22') },
        // Koffi et Ali travaillent le 28/10 ; le refus du soir d'Ali ne l'enlève pas (matin confirmé).
        prevus_aujourdhui: 2,
      },
      { restaurant: { id: RESTO_B, nom: 'Marcory' }, en_cours: null, suivant: null, prevus_aujourdhui: 0 },
    ]);
  });

  it('prévus aujourd’hui : même règle que le bandeau (envoyé ou confirmé, repos retirés, journée de service)', async () => {
    // Un brouillon, que les livreurs ne voient pas : personne n'est prévu.
    const brouillon = monterBase();
    brouillon.planningAngre(DRAFT);
    const [angreBrouillon] = await brouillon.requetes.apercu(ADMIN, RESTO_A, new Date('2026-10-28T10:00:00Z'));
    expect(angreBrouillon.prevus_aujourdhui).toBe(0);

    // Koffi pose lui-même un repos le 28/10 et garde ses créneaux : il n'est pas prévu.
    const b = monterBase();
    const plan = b.planningAngre(CONFIRMED);
    b.ajouterRepos({ deliverer_id: KOFFI, date: jour('2026-10-28'), source: RestDaySource.MANUAL_DELIVERER });
    const [angre] = await b.requetes.apercu(ADMIN, RESTO_A, new Date('2026-10-28T10:00:00Z'));
    expect(angre.prevus_aujourdhui).toBe(1);

    // Lundi 26/10 à 0 h 30, c'est encore la journée de service du dimanche : le planning n'a pas commencé.
    const [nuit] = await b.requetes.apercu(ADMIN, RESTO_A, new Date('2026-10-26T00:30:00Z'));
    expect(nuit).toMatchObject({ en_cours: null, suivant: { id: plan.id }, prevus_aujourdhui: 0 });
  });

  it('un manager ne reçoit que la ligne de son restaurant', async () => {
    const b = monterBase();
    const apercu = await b.controleur.apercu(b.requete(MANAGER_B, 'GET'), RESTO_A);
    expect(apercu.map((l) => l.restaurant.nom)).toEqual(['Marcory']);
  });
});
