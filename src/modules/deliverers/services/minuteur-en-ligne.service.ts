import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';

import { PrismaService } from 'src/database/services/prisma.service';

import { DelivererScoringSettingsHelper } from '../helpers/deliverer-scoring-settings.helper';
import { EtatLivreur, STATUTS_COURSE_EN_COURS } from '../helpers/disponibilite.rules';
import {
  DUREE_VIE_MINUTEUR_S,
  INTERVALLE_MINUTEUR_MS,
  SCRIPT_AVANCER_MINUTEUR,
  SCRIPT_LIRE_MINUTEURS,
  cleMinuteurEnLigne,
  ecartMaxMinuteurMs,
  estEnLigne,
  lireEtatMinuteur,
  secondesEnLigne,
} from '../helpers/minuteur-en-ligne.rules';
import { ClientRedisMinuteur, REDIS_MINUTEUR_EN_LIGNE } from './redis-minuteur-en-ligne.provider';

/** Ce que le minuteur lit d'un livreur pour savoir s'il est en ligne. */
export type EtatPauseLivreur = Pick<EtatLivreur, 'pause_until' | 'auto_pause_until' | 'last_available_at'>;

/** Au-delà, une commande Redis est abandonnée (le temps n'est pas compté). */
const DELAI_REDIS_MS = 500;
/** Une panne au plus une fois par minute au journal. */
const INTERVALLE_JOURNAL_MS = 60_000;
/** Au-delà, la mémoire des derniers signes de vie traités est vidée. */
const TAILLE_MAX_MEMOIRE = 5000;

const texteErreur = (erreur: unknown) => (erreur instanceof Error ? erreur.message : String(erreur));

function avantDelai<T>(promesse: Promise<T>, ms: number): Promise<T> {
  let minuteur: ReturnType<typeof setTimeout> | undefined;
  const delai = new Promise<never>((_, rejeter) => {
    minuteur = setTimeout(() => rejeter(new Error(`délai de ${ms} ms dépassé`)), ms);
  });
  return Promise.race([promesse, delai]).finally(() => clearTimeout(minuteur));
}

/**
 * Minuteur « en ligne » du livreur (règle : minuteur-en-ligne.rules.ts).
 *
 * Nourri par les signes de vie (requête authentifiée, position) et par les
 * changements d'état dans la file (pause, reprise, pause automatique), lu
 * par `GET /deliverers/me/scoring-info` (`en_ligne_aujourdhui_s`). Ne
 * bloque ni ne fait échouer aucune requête : Redis coupé, le temps n'est pas
 * compté et la lecture rend `null`.
 */
@Injectable()
export class MinuteurEnLigneService implements OnModuleDestroy {
  private readonly logger = new Logger(MinuteurEnLigneService.name);
  /** Dernier signe de vie traité par CE serveur, par livreur. */
  private readonly derniersTraites = new Map<string, number>();
  private dernierJournal = 0;

  constructor(
    @Inject(REDIS_MINUTEUR_EN_LIGNE) private readonly redis: ClientRedisMinuteur,
    private readonly prisma: PrismaService,
    private readonly settings: DelivererScoringSettingsHelper,
  ) {}

  async onModuleDestroy(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      // déjà fermée
    }
  }

  /**
   * Signe de vie de l'appli. `etat` : l'état du livreur à l'arrivée du signe
   * de vie, quand l'appelant l'a déjà lu (requête authentifiée, avant que la
   * requête ne le change) ; sinon il est relu en base.
   */
  async noterSignal(delivererId: string, maintenant: Date = new Date(), etat?: EtatPauseLivreur): Promise<void> {
    const a = maintenant.getTime();
    const precedent = this.derniersTraites.get(delivererId);
    if (precedent !== undefined && a >= precedent && a - precedent < INTERVALLE_MINUTEUR_MS) return;
    if (this.derniersTraites.size >= TAILLE_MAX_MEMOIRE) this.derniersTraites.clear();
    this.derniersTraites.set(delivererId, a);

    try {
      const enLigne = await this.enLigne(delivererId, maintenant, etat);
      if (enLigne === null) return;
      await this.avancer(delivererId, maintenant, enLigne, enLigne);
    } catch (erreur) {
      this.journaliserPanne(erreur);
    }
  }

  /**
   * Changement d'état dans la file (pause, reprise, entrée dans la file,
   * pause automatique, déconnexion) : le temps est compté jusqu'à cet
   * instant selon l'état d'avant, puis le compte suit le nouvel état.
   */
  async noterChangement(delivererId: string, maintenant: Date = new Date()): Promise<void> {
    try {
      const enLigne = await this.enLigne(delivererId, maintenant);
      if (enLigne === null) return;
      await this.avancer(delivererId, maintenant, true, enLigne);
    } catch (erreur) {
      this.journaliserPanne(erreur);
    }
  }

  /**
   * Secondes en ligne aujourd'hui, à l'instant. `null` : Redis ne répond
   * pas (l'appli garde alors sa dernière valeur).
   */
  async lire(
    delivererId: string,
    enLigneMaintenant: boolean,
    appliFermeeApresS: number,
    maintenant: Date = new Date(),
  ): Promise<number | null> {
    try {
      const valeurs = await avantDelai(
        this.redis.hmget(cleMinuteurEnLigne(delivererId, maintenant), 'ms', 'dernier', 'en_ligne'),
        DELAI_REDIS_MS,
      );
      return secondesEnLigne(
        lireEtatMinuteur(valeurs),
        maintenant.getTime(),
        enLigneMaintenant,
        ecartMaxMinuteurMs(appliFermeeApresS),
      );
    } catch (erreur) {
      this.journaliserPanne(erreur);
      return null;
    }
  }

  /**
   * Secondes en ligne aujourd'hui de plusieurs livreurs, en une seule
   * commande Redis (vue Livreurs « Aujourd'hui »). `enLigne` : en ligne à
   * l'instant (`estEnLigne`). `null` : Redis ne répond pas.
   */
  async lirePlusieurs(
    livreurs: readonly { id: string; enLigne: boolean }[],
    appliFermeeApresS: number,
    maintenant: Date = new Date(),
  ): Promise<Map<string, number> | null> {
    const secondes = new Map<string, number>();
    if (livreurs.length === 0) return secondes;
    try {
      const cles = livreurs.map((l) => cleMinuteurEnLigne(l.id, maintenant));
      const brut = await avantDelai(this.redis.eval(SCRIPT_LIRE_MINUTEURS, cles.length, ...cles), DELAI_REDIS_MS);
      const lignes = Array.isArray(brut) ? brut : [];
      livreurs.forEach((l, i) => {
        const valeurs = Array.isArray(lignes[i]) ? (lignes[i] as (string | null)[]) : [];
        secondes.set(
          l.id,
          secondesEnLigne(
            lireEtatMinuteur(valeurs),
            maintenant.getTime(),
            l.enLigne,
            ecartMaxMinuteurMs(appliFermeeApresS),
          ),
        );
      });
      return secondes;
    } catch (erreur) {
      this.journaliserPanne(erreur);
      return null;
    }
  }

  /** En ligne à cet instant ; `null` : livreur introuvable. */
  private async enLigne(delivererId: string, maintenant: Date, etat?: EtatPauseLivreur): Promise<boolean | null> {
    const l =
      etat ??
      (await this.prisma.deliverer.findUnique({
        where: { id: delivererId },
        select: { pause_until: true, auto_pause_until: true, last_available_at: true },
      }));
    if (!l) return null;
    // Sorti de la file en acceptant une course : toujours en ligne. La course
    // n'est cherchée que si elle peut changer la réponse.
    if (estEnLigne(l, false, maintenant)) return true;
    if (!estEnLigne(l, true, maintenant)) return false;
    const course = await this.prisma.course.findFirst({
      where: { deliverer_id: delivererId, statut: { in: STATUTS_COURSE_EN_COURS } },
      select: { id: true },
    });
    return course !== null;
  }

  private async avancer(
    delivererId: string,
    maintenant: Date,
    enLigneJusquIci: boolean,
    enLigneDesormais: boolean,
  ): Promise<void> {
    const { appliFermeeApresS } = await this.settings.load();
    await avantDelai(
      this.redis.eval(
        SCRIPT_AVANCER_MINUTEUR,
        1,
        cleMinuteurEnLigne(delivererId, maintenant),
        String(maintenant.getTime()),
        enLigneJusquIci ? '1' : '0',
        enLigneDesormais ? '1' : '0',
        String(ecartMaxMinuteurMs(appliFermeeApresS)),
        String(DUREE_VIE_MINUTEUR_S),
      ),
      DELAI_REDIS_MS,
    );
  }

  private journaliserPanne(erreur: unknown): void {
    const maintenant = Date.now();
    if (maintenant - this.dernierJournal < INTERVALLE_JOURNAL_MS) return;
    this.dernierJournal = maintenant;
    this.logger.error(`[Minuteur en ligne] Temps non compté : ${texteErreur(erreur)}`);
  }
}
