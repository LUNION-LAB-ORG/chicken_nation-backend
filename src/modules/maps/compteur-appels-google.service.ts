import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';

import { SettingsService } from 'src/modules/settings/settings.service';

import { ClientRedisCompteur, REDIS_COMPTEUR_GOOGLE } from './redis-compteur-google.provider';

/**
 * Fonctions de Google comptées, une clé par fonction et par jour.
 *
 * Plafonnées (`FONCTIONS_PLAFONNEES`) : celles du REGROUPEMENT, qui ont un
 * repli sans Google et dont la coupure ne bloque rien (tracés de la règle de
 * direction, détour, temps de trajet des livreurs). Les autres sont comptées
 * mais JAMAIS coupées : la distance routière des frais de livraison et de
 * l'acheminement (couper ramènerait le vol d'oiseau au travers de la lagune
 * et des frais différents pour une même adresse, relecture du 23/10), la
 * saisie d'une adresse ou le trajet affiché au livreur.
 */
export type FonctionGoogle =
  /** `itineraireRoutier` pour les frais de livraison et l'acheminement (`distanceRoutiereMetres`). */
  | 'itineraire'
  /** `itineraireRoutier` pour la règle « même direction » du planificateur (tracés). */
  | 'trace_direction'
  /** `detourSansTrafic` : trajet restaurant → client proche → client lointain. */
  | 'detour'
  /** `getTravelTimes` : temps de trajet des livreurs jusqu'au restaurant. */
  | 'temps_trajet'
  /** `getDirections` : trajet avec trafic (applis, suivi du client, durée de tournée). */
  | 'trajet_trafic'
  | 'geocodage_inverse'
  | 'saisie_adresse'
  | 'details_lieu'
  | 'vignette';

export const FONCTIONS_GOOGLE: readonly FonctionGoogle[] = [
  'itineraire',
  'trace_direction',
  'detour',
  'temps_trajet',
  'trajet_trafic',
  'geocodage_inverse',
  'saisie_adresse',
  'details_lieu',
  'vignette',
];

export const FONCTIONS_PLAFONNEES: ReadonlySet<FonctionGoogle> = new Set<FonctionGoogle>([
  'trace_direction',
  'detour',
  'temps_trajet',
]);

/** Réglage : plafond quotidien des appels plafonnés. */
export const CLE_PLAFOND_APPELS_JOUR = 'maps.plafond_appels_jour';
export const PLAFOND_APPELS_JOUR_DEFAUT = 2000;

/** Les compteurs d'un jour restent lisibles une semaine. */
const DUREE_COMPTEUR_S = 8 * 24 * 60 * 60;
/** Au-delà, une commande Redis est abandonnée et Google reste utilisé sans compteur. */
const DELAI_REDIS_MS = 500;
/** Un même avertissement au plus une fois par minute. */
const INTERVALLE_JOURNAL_MS = 60 * 1000;

/**
 * Plafond lu dans les réglages. 0 est accepté et veut dire « aucun appel
 * plafonné » (repli sans Google pour ces fonctions). Négatif ou illisible :
 * refusé, défaut 2 000, et signalé.
 */
export function lirePlafondAppels(brut: string | null | undefined): { plafond: number; refuse: boolean } {
  if (brut === null || brut === undefined || brut.trim() === '') {
    return { plafond: PLAFOND_APPELS_JOUR_DEFAUT, refuse: false };
  }
  const n = Number(brut.trim());
  if (!Number.isFinite(n) || n < 0) return { plafond: PLAFOND_APPELS_JOUR_DEFAUT, refuse: true };
  return { plafond: Math.floor(n), refuse: false };
}

/** Jour du compteur, `AAAA-MM-JJ`. Abidjan vit à l'heure UTC : minuit est le même. */
export function jourCompteur(maintenant: Date): string {
  return maintenant.toISOString().slice(0, 10);
}

export function cleCompteur(jour: string, suffixe: FonctionGoogle | 'plafonnes' | 'refuses'): string {
  return `maps:appels:${jour}:${suffixe}`;
}

export interface CompteursGoogleDuJour {
  jour: string;
  parFonction: Record<FonctionGoogle, number>;
  /** Appels plafonnés passés aujourd'hui. */
  plafonnes: number;
  /** Appels refusés par le plafond (repli sans Google). */
  refuses: number;
  plafond: number;
}

const texteErreur = (erreur: unknown) => (erreur instanceof Error ? erreur.message : String(erreur));

function avantDelai<T>(promesse: Promise<T>, ms: number): Promise<T> {
  let minuteur: ReturnType<typeof setTimeout> | undefined;
  const delai = new Promise<never>((_, rejeter) => {
    minuteur = setTimeout(() => rejeter(new Error(`délai de ${ms} ms dépassé`)), ms);
  });
  return Promise.race([promesse, delai]).finally(() => clearTimeout(minuteur));
}

/**
 * Compteur d'appels à Google, par fonction et par jour, dans Redis, et
 * plafond quotidien (`maps.plafond_appels_jour`) au-delà duquel les fonctions
 * plafonnées passent au repli sans Google jusqu'à minuit.
 *
 * Seuls les appels réellement envoyés sont comptés : une réponse servie par
 * le cache ne coûte rien et ne passe pas ici.
 */
@Injectable()
export class CompteurAppelsGoogleService implements OnModuleDestroy {
  private readonly logger = new Logger(CompteurAppelsGoogleService.name);
  private readonly derniersJournaux = new Map<string, number>();

  constructor(
    @Inject(REDIS_COMPTEUR_GOOGLE) private readonly redis: ClientRedisCompteur,
    private readonly settings: SettingsService,
  ) {}

  async onModuleDestroy(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      // déjà fermée
    }
  }

  /**
   * Réserve un appel à Google avant de l'envoyer. `false` : plafond du jour
   * atteint, l'appelant passe à son repli sans Google. Une fonction non
   * plafonnée est seulement comptée. Redis en panne : `true` (on ne coupe pas
   * les cartes faute de compteur), avec un journal d'erreur.
   */
  async reserver(fonction: FonctionGoogle, maintenant: Date = new Date()): Promise<boolean> {
    if (!FONCTIONS_PLAFONNEES.has(fonction)) {
      this.compter(fonction, maintenant);
      return true;
    }

    const jour = jourCompteur(maintenant);
    const plafond = await this.plafond();
    if (plafond === 0) {
      void this.noterRefus(jour);
      this.journaliserUneFois('plafond-zero', `[Maps] Plafond d'appels Google à 0 : repli sans Google (${fonction}).`);
      return false;
    }

    const cleTotal = cleCompteur(jour, 'plafonnes');
    const cleFonction = cleCompteur(jour, fonction);
    try {
      const resultats = await this.commande(() =>
        this.redis
          .multi()
          .incr(cleTotal)
          .expire(cleTotal, DUREE_COMPTEUR_S)
          .incr(cleFonction)
          .expire(cleFonction, DUREE_COMPTEUR_S)
          .exec(),
      );
      const [erreur, total] = resultats?.[0] ?? [new Error('transaction annulée'), null];
      if (erreur) throw erreur;
      if (typeof total !== 'number') throw new Error(`réponse inattendue : ${String(total)}`);

      if (total > plafond) {
        // Rien n'est parti : on rend ce qui vient d'être pris.
        try {
          await this.commande(() =>
            this.redis
              .multi()
              .decr(cleTotal)
              .decr(cleFonction)
              .incr(cleCompteur(jour, 'refuses'))
              .expire(cleCompteur(jour, 'refuses'), DUREE_COMPTEUR_S)
              .exec(),
          );
        } catch (erreurRendu) {
          this.journaliserPanne(erreurRendu);
        }
        this.journaliserUneFois(
          'plafond',
          `[Maps] Plafond quotidien d'appels Google atteint (${plafond}) : repli sans Google jusqu'à minuit (${fonction}).`,
        );
        return false;
      }
      return true;
    } catch (erreur) {
      this.journaliserPanne(erreur);
      return true;
    }
  }

  /** Compte un appel non plafonné, sans le faire attendre ni jamais échouer. */
  compter(fonction: FonctionGoogle, maintenant: Date = new Date()): void {
    const cle = cleCompteur(jourCompteur(maintenant), fonction);
    void this.commande(() => this.redis.multi().incr(cle).expire(cle, DUREE_COMPTEUR_S).exec()).catch((erreur) =>
      this.journaliserPanne(erreur),
    );
  }

  /** Compteurs du jour, par fonction, pour le suivi de la consommation. */
  async compteursDuJour(maintenant: Date = new Date()): Promise<CompteursGoogleDuJour> {
    const jour = jourCompteur(maintenant);
    const cles = [
      ...FONCTIONS_GOOGLE.map((f) => cleCompteur(jour, f)),
      cleCompteur(jour, 'plafonnes'),
      cleCompteur(jour, 'refuses'),
    ];
    let valeurs: (string | null)[] = [];
    try {
      valeurs = await this.commande(() => this.redis.mget(...cles));
    } catch (erreur) {
      this.journaliserPanne(erreur);
    }
    const nombre = (i: number) => {
      const n = Number(valeurs[i] ?? 0);
      return Number.isFinite(n) && n > 0 ? n : 0;
    };
    const parFonction = Object.fromEntries(FONCTIONS_GOOGLE.map((f, i) => [f, nombre(i)])) as Record<
      FonctionGoogle,
      number
    >;
    return {
      jour,
      parFonction,
      plafonnes: nombre(FONCTIONS_GOOGLE.length),
      refuses: nombre(FONCTIONS_GOOGLE.length + 1),
      plafond: await this.plafond(),
    };
  }

  /** Plafond relu à chaque appel (réglage modifiable au backoffice) ; base muette : défaut. */
  private async plafond(): Promise<number> {
    let brut: string | null = null;
    try {
      brut = await this.settings.get(CLE_PLAFOND_APPELS_JOUR);
    } catch (erreur) {
      this.journaliserUneFois('reglage', `[Maps] Plafond d'appels illisible (${texteErreur(erreur)}) : défaut ${PLAFOND_APPELS_JOUR_DEFAUT}.`);
      return PLAFOND_APPELS_JOUR_DEFAUT;
    }
    const { plafond, refuse } = lirePlafondAppels(brut);
    if (refuse) {
      this.journaliserUneFois(
        'reglage',
        `[Maps] Valeur refusée pour ${CLE_PLAFOND_APPELS_JOUR} : « ${brut} ». Défaut appliqué : ${PLAFOND_APPELS_JOUR_DEFAUT}.`,
      );
    }
    return plafond;
  }

  private async noterRefus(jour: string): Promise<void> {
    const cle = cleCompteur(jour, 'refuses');
    try {
      await this.commande(() => this.redis.multi().incr(cle).expire(cle, DUREE_COMPTEUR_S).exec());
    } catch (erreur) {
      this.journaliserPanne(erreur);
    }
  }

  private commande<T>(appel: () => Promise<T>): Promise<T> {
    return avantDelai(Promise.resolve().then(appel), DELAI_REDIS_MS);
  }

  private journaliserPanne(erreur: unknown): void {
    this.journaliserUneFois('panne', `[Maps] Compteur d'appels Google indisponible (Redis) : ${texteErreur(erreur)}`, true);
  }

  private journaliserUneFois(sujet: string, message: string, erreur = false): void {
    const maintenant = Date.now();
    if (maintenant - (this.derniersJournaux.get(sujet) ?? 0) < INTERVALLE_JOURNAL_MS) return;
    this.derniersJournaux.set(sujet, maintenant);
    if (erreur) this.logger.error(message);
    else this.logger.warn(message);
  }
}
