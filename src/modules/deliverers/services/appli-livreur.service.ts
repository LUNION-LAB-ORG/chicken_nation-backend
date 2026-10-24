import { Injectable } from '@nestjs/common';
import { DelivererStatus, EntityStatus } from '@prisma/client';

import { PrismaService } from 'src/database/services/prisma.service';
import { AppGateway } from 'src/socket-io/gateways/app.gateway';

import { DelivererScoringSettingsHelper } from '../helpers/deliverer-scoring-settings.helper';
import { ContexteAppli, appliActiveDepuis } from '../helpers/disponibilite.rules';

/**
 * La présence (socket ouvert) est aussi demandée pour un signe de vie qui
 * deviendra trop vieux dans les 10 secondes : jugé un peu plus tard (sous un
 * verrou, dans une transaction), il ne passe pas « fermé » faute de l'avoir
 * demandée.
 */
export const MARGE_PRESENCE_MS = 10_000;

/** Ce que le contexte lit d'un livreur. */
export interface LignePresence {
  id: string;
  dernier_signal_at: Date | null;
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
 * livreurs dont le signe de vie ne suffit pas.
 */
@Injectable()
export class AppliLivreurService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: AppGateway,
    private readonly settings: DelivererScoringSettingsHelper,
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
}
