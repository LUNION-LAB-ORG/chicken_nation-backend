import { Injectable, Logger } from '@nestjs/common';
import { DelivererStatus, EntityStatus } from '@prisma/client';

import { PrismaService } from 'src/database/services/prisma.service';
import { DispatchJournalService } from 'src/modules/course/services/dispatch-journal.service';
import { AppGateway } from 'src/socket-io/gateways/app.gateway';

import { DelivererScoringSettingsHelper } from '../helpers/deliverer-scoring-settings.helper';
import {
  ContexteAppli,
  STATUTS_COURSE_EN_COURS,
  appliActiveDepuis,
  estEnPause,
  estEnPauseAuto,
} from '../helpers/disponibilite.rules';

/**
 * Classe du verrou consultatif du suivi des applis (une seule instance relève
 * les passages à la fois). 727224 à 727226 sont au CRM, 727227 au code de
 * retrait, 727228 aux offres d'un livreur, 727229 au planificateur.
 */
export const CLASSE_VERROU_SUIVI_APPLIS = 727230;

/**
 * La présence (socket ouvert) est aussi demandée pour un signe de vie qui
 * deviendra trop vieux dans les 10 secondes : jugé un peu plus tard (sous un
 * verrou, dans une transaction), il ne passe pas « fermé » faute de l'avoir
 * demandée.
 */
export const MARGE_PRESENCE_MS = 10_000;

/** Passages suivis : livreurs dont l'appli a donné signe de vie dans les 12 dernières heures. */
export const FENETRE_SUIVI_APPLIS_MS = 12 * 3600_000;

/** Lignes du journal qui marquent un passage de l'appli. */
export type PassageAppli = 'APPLI_FERMEE' | 'APPLI_ACTIVE';

/** Ce que le contexte lit d'un livreur. */
export interface LignePresence {
  id: string;
  dernier_signal_at: Date | null;
}

/**
 * Passage à écrire au journal, d'après l'état de l'appli et le dernier passage
 * écrit. Sans passage écrit, l'appli est réputée active : seule sa fermeture
 * s'écrit.
 */
export function passageAEcrire(appliActive: boolean, dernier: PassageAppli | null): PassageAppli | null {
  if (!appliActive) return dernier === 'APPLI_FERMEE' ? null : 'APPLI_FERMEE';
  return dernier === 'APPLI_FERMEE' ? 'APPLI_ACTIVE' : null;
}

/** Livreurs dont le signe de vie ne suffit pas (ou bientôt plus) : leur présence est à demander. */
export function idsSansSignalSuffisant(
  lignes: readonly LignePresence[],
  maintenant: Date,
  appliFermeeApresS: number,
): string[] {
  const limite = maintenant.getTime() - Math.max(0, appliFermeeApresS * 1000 - MARGE_PRESENCE_MS);
  return lignes
    .filter((l) => l.dernier_signal_at === null || l.dernier_signal_at.getTime() <= limite)
    .map((l) => l.id);
}

/**
 * APPLI DU LIVREUR ACTIVE OU FERMÉE (demande du 24/10 : « c'est lorsqu'il
 * ferme la fenêtre que ça ne doit pas passer »).
 *
 * Appli active : au moins un socket ouvert (présence, AppGateway), OU un signe
 * de vie (position ou requête authentifiée, `Deliverer.dernier_signal_at`) de
 * moins de `deliverer.appli_fermee_apres_s` secondes (défaut 180, 0 = règle
 * coupée). En arrière-plan, l'appli envoie ses positions par la route
 * `POST /deliverers/me/location` et reste active ; glissée hors de la liste
 * des applis, elle se tait : après le délai, plus aucune offre (motif
 * `APPLI_FERMEE` de la règle unique), sans pause ni pénalité, jusqu'à sa
 * réouverture.
 *
 * Ce service fournit le contexte (réglage et sockets ouverts) que la règle
 * unique lit, en ne demandant la présence au serveur temps réel que pour les
 * livreurs dont le signe de vie ne suffit pas, et relève au journal de la
 * diffusion les passages « appli fermée » et « appli active ».
 */
@Injectable()
export class AppliLivreurService {
  private readonly logger = new Logger(AppliLivreurService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: AppGateway,
    private readonly settings: DelivererScoringSettingsHelper,
    private readonly journal: DispatchJournalService,
  ) {}

  /** Réglage `deliverer.appli_fermee_apres_s` ; 0 : règle coupée. */
  async seuilS(): Promise<number> {
    return (await this.settings.load()).appliFermeeApresS;
  }

  /** Contexte pour juger l'appli de ces livreurs, déjà lus (`id`, `dernier_signal_at`). */
  async contexte(lignes: readonly LignePresence[], maintenant = new Date()): Promise<ContexteAppli> {
    return this.contexteAvec(await this.seuilS(), lignes, maintenant);
  }

  /** Contexte pour juger l'appli de ces livreurs, lus en base. */
  async contextePour(ids: readonly string[], maintenant = new Date()): Promise<ContexteAppli> {
    const appliFermeeApresS = await this.seuilS();
    if (!(appliFermeeApresS > 0)) return { appliFermeeApresS, connectes: null };
    if (ids.length === 0) return { appliFermeeApresS, connectes: new Set() };
    const lignes = await this.prisma.deliverer.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, dernier_signal_at: true },
    });
    return this.contexteAvec(appliFermeeApresS, lignes, maintenant);
  }

  /** L'appli de ce livreur est-elle active ? Livreur introuvable : oui (rien à juger). */
  async estActive(delivererId: string, maintenant = new Date()): Promise<boolean> {
    const appliFermeeApresS = await this.seuilS();
    if (!(appliFermeeApresS > 0)) return true;
    const ligne = await this.prisma.deliverer.findUnique({
      where: { id: delivererId },
      select: { id: true, dernier_signal_at: true },
    });
    if (!ligne) return true;
    const appli = await this.contexteAvec(appliFermeeApresS, [ligne], maintenant);
    return appliActiveDepuis(ligne, appli, maintenant);
  }

  /**
   * Contexte de la SÉLECTION des candidats d'un restaurant (filtre Prisma de
   * la règle unique) : présence demandée pour les livreurs en service dont le
   * signe de vie ne suffit pas.
   */
  async contexteSelection(restaurantId: string, maintenant = new Date()): Promise<ContexteAppli> {
    const appliFermeeApresS = await this.seuilS();
    if (!(appliFermeeApresS > 0)) return { appliFermeeApresS, connectes: null };
    const limite = new Date(maintenant.getTime() - Math.max(0, appliFermeeApresS * 1000 - MARGE_PRESENCE_MS));
    const aVerifier = await this.prisma.deliverer.findMany({
      where: {
        restaurant_id: restaurantId,
        status: DelivererStatus.ACTIVE,
        is_operational: true,
        entity_status: EntityStatus.ACTIVE,
        last_available_at: { not: null },
        OR: [{ dernier_signal_at: null }, { dernier_signal_at: { lte: limite } }],
      },
      select: { id: true },
    });
    if (aVerifier.length === 0) return { appliFermeeApresS, connectes: new Set() };
    return { appliFermeeApresS, connectes: await this.presence(aVerifier.map((l) => l.id)) };
  }

  /**
   * Relève au journal les passages de l'appli (cron, 10 s) : `APPLI_FERMEE`
   * quand l'appli d'un livreur vient d'être réputée fermée, `APPLI_ACTIVE` à
   * sa réouverture. Une seule instance à la fois (verrou consultatif) ; le
   * dernier passage écrit est relu au journal : jamais deux fois le même.
   *
   * @returns le nombre de passages écrits.
   */
  async suivrePassages(maintenant = new Date()): Promise<number> {
    const appliFermeeApresS = await this.seuilS();
    if (!(appliFermeeApresS > 0)) return 0;
    const ecrits = await this.prisma.$transaction(
      async (tx) => {
        const verrou = await tx.$queryRaw<{ pris: boolean }[]>`SELECT pg_try_advisory_xact_lock(${CLASSE_VERROU_SUIVI_APPLIS}::int, 0) AS pris`;
        if (!verrou?.[0]?.pris) return 0;
        return this.relever(appliFermeeApresS, maintenant);
      },
      { maxWait: 10_000, timeout: 30_000 },
    );
    return ecrits ?? 0;
  }

  // ============================================================
  // HELPERS PRIVÉS
  // ============================================================

  private async contexteAvec(
    appliFermeeApresS: number,
    lignes: readonly LignePresence[],
    maintenant: Date,
  ): Promise<ContexteAppli> {
    if (!(appliFermeeApresS > 0)) return { appliFermeeApresS, connectes: null };
    const ids = idsSansSignalSuffisant(lignes, maintenant, appliFermeeApresS);
    if (ids.length === 0) return { appliFermeeApresS, connectes: new Set() };
    return { appliFermeeApresS, connectes: await this.presence(ids) };
  }

  /** Sockets ouverts parmi ces livreurs ; null si la présence n'a pas pu être lue. */
  private async presence(ids: string[]): Promise<Set<string> | null> {
    try {
      return await this.gateway.livreursConnectes(ids);
    } catch {
      return null;
    }
  }

  private async relever(appliFermeeApresS: number, maintenant: Date): Promise<number> {
    const livreurs = await this.prisma.deliverer.findMany({
      where: {
        status: DelivererStatus.ACTIVE,
        is_operational: true,
        entity_status: EntityStatus.ACTIVE,
        dernier_signal_at: { gte: new Date(maintenant.getTime() - FENETRE_SUIVI_APPLIS_MS) },
      },
      select: {
        id: true,
        restaurant_id: true,
        dernier_signal_at: true,
        last_available_at: true,
        pause_until: true,
        auto_pause_until: true,
        _count: { select: { courses: { where: { statut: { in: STATUTS_COURSE_EN_COURS } } } } },
      },
    });
    if (livreurs.length === 0) return 0;

    const appli = await this.contexteAvec(appliFermeeApresS, livreurs, maintenant);
    const derniers = await this.derniersPassages(livreurs.map((l) => l.id));

    let ecrits = 0;
    for (const l of livreurs) {
      const active = appliActiveDepuis(l, appli, maintenant);
      const dernier = derniers.get(l.id) ?? null;
      const passage = passageAEcrire(active, dernier?.type ?? null);
      if (!passage) continue;
      const details: Record<string, unknown> = {
        appli_vue_a: l.dernier_signal_at?.toISOString() ?? null,
        seuil_s: appliFermeeApresS,
        en_service: l.last_available_at !== null,
        en_pause: estEnPause(l, maintenant) || estEnPauseAuto(l, maintenant),
        en_course: l._count.courses > 0,
      };
      if (passage === 'APPLI_FERMEE') details.presence_connue = appli.connectes !== null;
      else {
        details.fermee_a = dernier?.a.toISOString() ?? null;
        details.par = appli.connectes?.has(l.id) ? 'socket' : 'signal';
      }
      await this.journal.ecrire({
        type: passage,
        source: 'serveur',
        deliverer_id: l.id,
        restaurant_id: l.restaurant_id,
        details,
      });
      ecrits++;
    }
    if (ecrits > 0) this.logger.log(`${ecrits} passage(s) d'appli livreur au journal`);
    return ecrits;
  }

  /** Dernier passage écrit pour chaque livreur, et son heure. */
  private async derniersPassages(ids: string[]): Promise<Map<string, { type: PassageAppli; a: Date }>> {
    const groupes = await this.prisma.dispatchEvenement.groupBy({
      by: ['deliverer_id', 'type'],
      where: { deliverer_id: { in: ids }, type: { in: ['APPLI_FERMEE', 'APPLI_ACTIVE'] } },
      _max: { created_at: true },
    });
    const derniers = new Map<string, { type: PassageAppli; a: Date }>();
    for (const g of groupes) {
      const a = g._max.created_at;
      if (!g.deliverer_id || !a) continue;
      const connu = derniers.get(g.deliverer_id);
      if (!connu || a.getTime() > connu.a.getTime()) {
        derniers.set(g.deliverer_id, { type: g.type as PassageAppli, a });
      }
    }
    return derniers;
  }
}
