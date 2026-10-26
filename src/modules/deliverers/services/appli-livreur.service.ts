import { Injectable, Logger, Optional } from '@nestjs/common';
import { DelivererStatus, EntityStatus } from '@prisma/client';

import { JournalLimite, suffixeTues } from 'src/common/utils/journal-limite.util';
import { PrismaService } from 'src/database/services/prisma.service';
import { DispatchJournalService } from 'src/modules/course/services/dispatch-journal.service';
import { AppGateway } from 'src/socket-io/gateways/app.gateway';
import { FinsSocketLivreursService } from 'src/socket-io/services/fins-socket-livreurs.service';

import { DelivererScoringSettingsHelper } from '../helpers/deliverer-scoring-settings.helper';
import {
  ContexteAppli,
  EtatAppli,
  FinSocket,
  STATUTS_COURSE_EN_COURS,
  appliActiveDepuis,
  estEnPause,
  estEnPauseAuto,
  filtreAppelsVivantsLivreurs,
  idsSansJeton,
  livreursDesAppels,
  PROTOCOLE_APPLI_FERMEE,
  etatAppliDepuis,
  regleAppliPour,
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

/**
 * Lignes du journal qui marquent un passage de l'appli : fermée par le
 * livreur (prouvé), connexion coupée (tout autre silence, 25/10), active.
 */
export type PassageAppli = 'APPLI_FERMEE' | 'CONNEXION_COUPEE' | 'APPLI_ACTIVE';

const PASSAGES_APPLI: PassageAppli[] = ['APPLI_FERMEE', 'CONNEXION_COUPEE', 'APPLI_ACTIVE'];

const estSilence = (passage: PassageAppli | null) => passage === 'APPLI_FERMEE' || passage === 'CONNEXION_COUPEE';

/** Ce que le contexte lit d'un livreur. */
export interface LignePresence {
  id: string;
  dernier_signal_at: Date | null;
  /** Appli d'avant le protocole 4 : la règle ne la vise pas, rien à demander. */
  protocole_appli: number | null;
  /**
   * Jeton de notification, quand la ligne l'a lu : la joignabilité n'est
   * jugée que pour ces lignes (absent : non jugée, réputé joignable).
   */
  expo_push_token?: string | null;
  /** En service (dans la file) : seuls ceux-là sont signalés injoignables au journal du serveur. */
  last_available_at?: Date | null;
}

/** Réglages qui décident de ce qu'il faut demander au serveur temps réel. */
interface ReglagesPresence {
  /** `deliverer.appli_fermee_apres_s` ; 0 : règle de l'appli fermée coupée. */
  appliFermeeApresS: number;
  /** `course.offre_joignables_seulement` : offre aux seuls livreurs joignables. */
  joignablesSeulement: boolean;
  /** Livreurs en appel avec le service client écartés des offres. */
  horsAppel: boolean;
}

/**
 * L'appli seule (filet hors service, passages au journal) : la joignabilité
 * et l'appel en cours ne gardent que la création d'une offre.
 */
const SANS_JOIGNABILITE = (appliFermeeApresS: number): ReglagesPresence => ({
  appliFermeeApresS,
  joignablesSeulement: false,
  horsAppel: false,
});

/**
 * Passage à écrire au journal, d'après l'état de l'appli et le dernier passage
 * écrit. Sans passage écrit, l'appli est réputée active : seule sa fermeture
 * ou sa coupure s'écrit.
 *
 * @param finsLues  Les fins de socket ont pu être lues. Sinon une fermeture
 *   ne peut pas être prouvée : déjà fermée ou coupée au journal, rien n'est
 *   réécrit (Redis qui hoquette ne remplit pas le journal toutes les 10 s).
 */
export function passageAEcrire(etat: EtatAppli, dernier: PassageAppli | null, finsLues = true): PassageAppli | null {
  if (etat === 'ACTIVE') return estSilence(dernier) ? 'APPLI_ACTIVE' : null;
  const voulu: PassageAppli = etat === 'FERMEE' ? 'APPLI_FERMEE' : 'CONNEXION_COUPEE';
  if (voulu === dernier) return null;
  if (!finsLues && estSilence(dernier)) return null;
  return voulu;
}

/** Livreurs dont le signe de vie ne suffit pas (ou bientôt plus) : leur présence est à demander. */
export function idsSansSignalSuffisant(
  lignes: readonly LignePresence[],
  maintenant: Date,
  appliFermeeApresS: number,
): string[] {
  const limite = maintenant.getTime() - Math.max(0, appliFermeeApresS * 1000 - MARGE_PRESENCE_MS);
  return lignes
    .filter((l) => regleAppliPour(l.protocole_appli, appliFermeeApresS))
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
 * diffusion les passages « appli fermée », « connexion coupée » et « appli
 * active ».
 *
 * APPLI FERMÉE OU CONNEXION COUPÉE (retour du client du 25/10) : pour les
 * livreurs sans socket ouvert dont le signe de vie ne suffit pas, le contexte
 * porte aussi la fin de leur dernier socket (`finsSocket`, une lecture
 * Redis). « Appli fermée » seulement quand l'appli a fermé elle-même son
 * socket et que rien n'est venu d'elle ensuite ; tout autre silence est une
 * connexion coupée, avec les mêmes effets (aucune offre, offre en attente
 * close sans pénalité).
 *
 * LIVREUR JOIGNABLE (défaut signalé le 24/10 : « proposée » au backoffice,
 * rien reçu par le livreur) : socket ouvert dans sa salle `deliverer_{id}`,
 * OU jeton de notification. Réglage `course.offre_joignables_seulement`
 * (défaut 1). Le contexte porte alors `injoignables` : livreurs dont le jeton
 * a été lu, absent, et sans socket. La présence est celle de TOUS les
 * serveurs (adaptateur Redis de socket.io, `AppGateway.livreursConnectes`) ;
 * un serveur qui ne répond pas à temps rend la présence inconnue, et personne
 * n'est alors réputé injoignable.
 *
 * LIVREUR EN APPEL (relecture du 24/10) : un appel avec le service client qui
 * sonne ou en ligne l'écarte des nouvelles offres (`enAppel`), l'écran d'appel
 * recouvrant l'offre. Appels illisibles : personne n'est réputé en appel.
 */
@Injectable()
export class AppliLivreurService {
  private readonly logger = new Logger(AppliLivreurService.name);
  /** Une ligne par livreur injoignable toutes les 10 min au plus (le planificateur passe toutes les 5 s). */
  private readonly injoignablesLimite = new JournalLimite(10 * 60_000);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: AppGateway,
    private readonly settings: DelivererScoringSettingsHelper,
    private readonly journal: DispatchJournalService,
    // Fin du dernier socket (module temps réel, global) : « Appli fermée » ou « Connexion coupée ».
    @Optional() private readonly fins?: FinsSocketLivreursService,
  ) {}

  /** Réglage `deliverer.appli_fermee_apres_s` ; 0 : règle coupée. */
  async seuilS(): Promise<number> {
    return (await this.settings.load()).appliFermeeApresS;
  }

  /** Contexte pour juger l'appli de ces livreurs, déjà lus (`id`, `dernier_signal_at`, et `expo_push_token` pour la joignabilité). */
  async contexte(lignes: readonly LignePresence[], maintenant = new Date()): Promise<ContexteAppli> {
    return this.contexteAvec(await this.reglagesPresence(), lignes, maintenant);
  }

  /** Contexte pour juger l'appli et la joignabilité de ces livreurs, lus en base. */
  async contextePour(ids: readonly string[], maintenant = new Date()): Promise<ContexteAppli> {
    const reglages = await this.reglagesPresence();
    if (!(reglages.appliFermeeApresS > 0) && !reglages.joignablesSeulement) {
      return this.avecAppels(reglages, { appliFermeeApresS: reglages.appliFermeeApresS, connectes: null }, maintenant);
    }
    if (ids.length === 0) return this.assembler(reglages, [], [], maintenant);
    const lignes = await this.prisma.deliverer.findMany({
      where: { id: { in: [...ids] } },
      select: {
        id: true,
        dernier_signal_at: true,
        protocole_appli: true,
        ...(reglages.joignablesSeulement ? { expo_push_token: true } : {}),
      },
    });
    return this.contexteAvec(reglages, lignes, maintenant);
  }

  /**
   * La règle de l'appli fermée vise-t-elle ce livreur ? Réglage au-dessus de 0
   * et appli au protocole 4 au moins. Sinon l'état de son appli est inconnu.
   */
  async regleActivePour(delivererId: string): Promise<boolean> {
    const appliFermeeApresS = await this.seuilS();
    if (!(appliFermeeApresS > 0)) return false;
    const ligne = await this.prisma.deliverer.findUnique({
      where: { id: delivererId },
      select: { protocole_appli: true },
    });
    return regleAppliPour(ligne?.protocole_appli ?? null, appliFermeeApresS);
  }

  /** L'appli de ce livreur est-elle active ? Livreur introuvable : oui (rien à juger). */
  async estActive(delivererId: string, maintenant = new Date()): Promise<boolean> {
    const appliFermeeApresS = await this.seuilS();
    if (!(appliFermeeApresS > 0)) return true;
    const ligne = await this.prisma.deliverer.findUnique({
      where: { id: delivererId },
      select: { id: true, dernier_signal_at: true, protocole_appli: true },
    });
    if (!ligne) return true;
    const appli = await this.contexteAvec(SANS_JOIGNABILITE(appliFermeeApresS), [ligne], maintenant);
    return appliActiveDepuis(ligne, appli, maintenant);
  }

  /**
   * Contexte de la SÉLECTION des candidats d'un restaurant (filtre Prisma de
   * la règle unique) : présence demandée pour les livreurs en service dont le
   * signe de vie ne suffit pas, et pour ceux sans jeton de notification
   * (joignabilité).
   */
  async contexteSelection(restaurantId: string, maintenant = new Date()): Promise<ContexteAppli> {
    const reglages = await this.reglagesPresence();
    const { appliFermeeApresS, joignablesSeulement } = reglages;
    if (!(appliFermeeApresS > 0) && !joignablesSeulement) {
      return this.avecAppels(reglages, { appliFermeeApresS, connectes: null }, maintenant);
    }
    const enService = {
      restaurant_id: restaurantId,
      status: DelivererStatus.ACTIVE,
      is_operational: true,
      entity_status: EntityStatus.ACTIVE,
      last_available_at: { not: null },
    };
    const limite = new Date(maintenant.getTime() - Math.max(0, appliFermeeApresS * 1000 - MARGE_PRESENCE_MS));
    const aVerifier =
      appliFermeeApresS > 0
        ? await this.prisma.deliverer.findMany({
            where: {
              ...enService,
              protocole_appli: { gte: PROTOCOLE_APPLI_FERMEE },
              OR: [{ dernier_signal_at: null }, { dernier_signal_at: { lte: limite } }],
            },
            select: { id: true },
          })
        : [];
    // Sans jeton de notification : seul un socket ouvert les rend joignables.
    const sansJeton = joignablesSeulement
      ? await this.prisma.deliverer.findMany({
          where: { ...enService, OR: [{ expo_push_token: null }, { expo_push_token: '' }] },
          select: { id: true },
        })
      : [];
    const contexte = await this.assembler(
      reglages,
      aVerifier.map((l) => l.id),
      sansJeton.map((l) => l.id),
      maintenant,
    );
    this.signalerInjoignables(contexte.injoignables);
    return contexte;
  }

  /**
   * Relève au journal les passages de l'appli (cron, 10 s) : `APPLI_FERMEE`
   * quand l'appli d'un livreur vient d'être fermée par lui (prouvé),
   * `CONNEXION_COUPEE` quand elle se tait sans cette preuve (avec la raison
   * de la fin de son socket), `APPLI_ACTIVE` à son retour. Une seule instance
   * à la fois (verrou consultatif) ; le dernier passage écrit est relu au
   * journal : jamais deux fois le même.
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

  /** Réglages de l'appli fermée et de la joignabilité, en une lecture. */
  private async reglagesPresence(): Promise<ReglagesPresence> {
    const r = await this.settings.load();
    return {
      appliFermeeApresS: r.appliFermeeApresS,
      joignablesSeulement: r.offreJoignablesSeulement === true,
      horsAppel: true,
    };
  }

  /**
   * Livreurs en appel avec le service client (qui sonne ou en ligne,
   * `filtreAppelsVivantsLivreurs`) ; null si les appels n'ont pas pu être lus.
   */
  async livreursEnAppel(maintenant = new Date()): Promise<Set<string> | null> {
    try {
      const appels = await this.prisma.call.findMany({
        where: filtreAppelsVivantsLivreurs(maintenant),
        select: { caller_deliverer_id: true, target_deliverer_id: true },
      });
      return livreursDesAppels(appels);
    } catch {
      return null;
    }
  }

  /** Livreurs en appel ajoutés au contexte d'une offre (absent : personne). */
  private async avecAppels(
    reglages: ReglagesPresence,
    contexte: ContexteAppli,
    maintenant: Date,
  ): Promise<ContexteAppli> {
    if (!reglages.horsAppel) return contexte;
    const enAppel = await this.livreursEnAppel(maintenant);
    if (enAppel && enAppel.size > 0) contexte.enAppel = enAppel;
    return contexte;
  }

  private async contexteAvec(
    reglages: ReglagesPresence,
    lignes: readonly LignePresence[],
    maintenant: Date,
  ): Promise<ContexteAppli> {
    const { appliFermeeApresS, joignablesSeulement } = reglages;
    if (!(appliFermeeApresS > 0) && !joignablesSeulement) {
      return this.avecAppels(reglages, { appliFermeeApresS, connectes: null }, maintenant);
    }
    const contexte = await this.assembler(
      reglages,
      appliFermeeApresS > 0 ? idsSansSignalSuffisant(lignes, maintenant, appliFermeeApresS) : [],
      joignablesSeulement ? idsSansJeton(lignes) : [],
      maintenant,
    );
    // Hors service ou en pause (déconnecté, jeton effacé) : pas candidat de toute façon, rien à signaler.
    const horsFile = new Set(lignes.filter((l) => l.last_available_at === null).map((l) => l.id));
    this.signalerInjoignables([...(contexte.injoignables ?? [])].filter((id) => !horsFile.has(id)));
    return contexte;
  }

  /**
   * Une seule demande de présence pour les deux règles : livreurs au signe de
   * vie insuffisant (appli fermée) et livreurs sans jeton (joignabilité).
   * Règle de l'appli coupée : `connectes` reste null, comme avant. Règle des
   * joignables coupée : pas d'`injoignables`.
   */
  private async assembler(
    reglages: ReglagesPresence,
    idsAppli: readonly string[],
    idsSansJetonLus: readonly string[],
    maintenant: Date,
  ): Promise<ContexteAppli> {
    const { appliFermeeApresS, joignablesSeulement } = reglages;
    const aDemander = [...new Set([...idsAppli, ...idsSansJetonLus])];
    const presence = aDemander.length > 0 ? await this.presence(aDemander) : new Set<string>();
    const contexte: ContexteAppli = { appliFermeeApresS, connectes: appliFermeeApresS > 0 ? presence : null };
    if (appliFermeeApresS > 0) {
      // Fin du dernier socket des seuls livreurs qui se taisent sans socket ouvert.
      contexte.finsSocket = await this.finsDe(idsAppli.filter((id) => !presence?.has(id)));
    }
    if (joignablesSeulement) {
      contexte.injoignables = presence ? new Set(idsSansJetonLus.filter((id) => !presence.has(id))) : null;
    }
    return this.avecAppels(reglages, contexte, maintenant);
  }

  /** Fin du dernier socket de ces livreurs ; null : Redis muet ou service absent, aucune preuve. */
  private async finsDe(ids: readonly string[]): Promise<ReadonlyMap<string, FinSocket> | null> {
    if (ids.length === 0) return new Map();
    if (!this.fins) return null;
    try {
      return await this.fins.lire(ids);
    } catch {
      return null;
    }
  }

  /** Livreurs passés faute d'être joignables : visibles dans les journaux, une ligne par livreur toutes les 10 min. */
  private signalerInjoignables(injoignables: Iterable<string> | null | undefined): void {
    for (const id of injoignables ?? []) {
      const tues = this.injoignablesLimite.autoriser(id);
      if (tues === null) continue;
      this.logger.warn(
        `Livreur ${id.slice(0, 8)} injoignable (ni socket ouvert, ni jeton de notification) : ` +
          `aucune offre tant qu'il ne l'est pas${suffixeTues(tues)}`,
      );
    }
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
        protocole_appli: true,
        last_available_at: true,
        pause_until: true,
        auto_pause_until: true,
        _count: { select: { courses: { where: { statut: { in: STATUTS_COURSE_EN_COURS } } } } },
      },
    });
    if (livreurs.length === 0) return 0;

    const appli = await this.contexteAvec(SANS_JOIGNABILITE(appliFermeeApresS), livreurs, maintenant);
    const derniers = await this.derniersPassages(livreurs.map((l) => l.id));

    const finsLues = appli.finsSocket !== null && appli.finsSocket !== undefined;
    let ecrits = 0;
    for (const l of livreurs) {
      // Appli d'avant le protocole 4 : la règle ne la vise pas, réputée active.
      const etat = etatAppliDepuis(l, appli, maintenant) ?? 'ACTIVE';
      const dernier = derniers.get(l.id) ?? null;
      const passage = passageAEcrire(etat, dernier?.type ?? null, finsLues);
      if (!passage) continue;
      const details: Record<string, unknown> = {
        appli_vue_a: l.dernier_signal_at?.toISOString() ?? null,
        seuil_s: appliFermeeApresS,
        en_service: l.last_available_at !== null,
        en_pause: estEnPause(l, maintenant) || estEnPauseAuto(l, maintenant),
        en_course: l._count.courses > 0,
      };
      if (passage === 'APPLI_ACTIVE') {
        details.fermee_a = dernier?.a.toISOString() ?? null;
        details.par = appli.connectes?.has(l.id) ? 'socket' : 'signal';
      } else {
        // Fermée ou coupée : la fin du dernier socket qui l'a décidé (null : aucune connue ou illisible).
        const fin = appli.finsSocket?.get(l.id);
        details.presence_connue = appli.connectes !== null;
        details.raison_socket = fin?.raison ?? null;
        details.fin_socket_a = fin?.a.toISOString() ?? null;
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
      where: { deliverer_id: { in: ids }, type: { in: PASSAGES_APPLI } },
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
