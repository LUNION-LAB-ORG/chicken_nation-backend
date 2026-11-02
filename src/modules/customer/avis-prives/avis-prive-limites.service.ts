import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  Provider,
} from '@nestjs/common';
import { Redis, type RedisOptions } from 'ioredis';
import { avantDelai } from 'src/modules/auth/helpers/file-par-cle.helper';
import {
  DELAI_DOUBLON_MS,
  FENETRE_GLOBALE_MS,
  FENETRE_NUMERO_MS,
  MAX_AVIS_PAR_HEURE_DEFAUT,
  MAX_AVIS_PAR_NUMERO,
  MESSAGE_PLAFOND_GLOBAL,
  MESSAGE_PLAFOND_NUMERO,
} from './avis-prive.rules';

/** Jeton d'injection de la connexion Redis des barrières de l'envoi public. */
export const REDIS_AVIS_PRIVES = Symbol('REDIS_AVIS_PRIVES');

/** Ce que le service emploie de ioredis (remplaçable par un double en test). */
export type ClientRedisAvis = Pick<Redis, 'set' | 'del' | 'multi' | 'quit'>;

/**
 * Connexion dédiée, même configuration que les plafonds des codes clients
 * (`redis-envois.provider.ts`) : une commande échoue tout de suite quand Redis
 * est coupé, au lieu d'attendre la reconnexion. L'avis passe alors, avec un
 * journal d'erreur et un repli en base pour le plafond par numéro.
 */
export const redisAvisPrivesProvider: Provider = {
  provide: REDIS_AVIS_PRIVES,
  useFactory: (): ClientRedisAvis => {
    const logger = new Logger('RedisAvisPrives');
    const password = process.env.REDIS_PASSWORD || '';
    const options: RedisOptions = {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      db: parseInt(process.env.REDIS_DB || '0', 10),
      ...(password ? { username: process.env.REDIS_USERNAME || 'default', password } : {}),
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      retryStrategy: (essais) => Math.min(essais * 200, 5000),
    };
    const client = new Redis(options);
    client.on('error', (erreur) => logger.error(`[Redis avis privés] ${erreur.message}`));
    return client;
  },
};

/** Au-delà, une commande Redis est abandonnée et l'avis passe sans elle. */
const DELAI_REDIS_MS = 1000;
const INTERVALLE_JOURNAL_MS = 60_000;

/**
 * Issue de la réservation d'un envoi :
 *  - `ok` : rien de semblable, plafonds respectés ; `cleDoublon` est à rendre
 *    si l'écriture échoue ensuite ;
 *  - `doublon` : le même avis vient d'arriver (double appui), on répond comme
 *    si c'était fait, sans second avis ;
 *  - `panne` : Redis ne répond pas ; l'avis passe et le service se replie sur
 *    la base pour le plafond par numéro.
 */
export type ReservationAvis = { etat: 'ok'; cleDoublon: string } | { etat: 'doublon' } | { etat: 'panne' };

class PanneRedis extends Error {}

const texteErreur = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const cleDoublon = (numero: string, empreinte: string) => `avis:doublon:${numero}:${empreinte}`;
export const clePlafondNumero = (numero: string) => `avis:plafond:numero:${numero}`;
export const CLE_PLAFOND_GLOBAL = 'avis:plafond:global';

/** Plafond global de l'heure (`AVIS_MAX_PAR_HEURE`, 200 par défaut). */
export function maxAvisParHeure(env: NodeJS.ProcessEnv = process.env): number {
  const v = parseInt(env.AVIS_MAX_PAR_HEURE ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : MAX_AVIS_PAR_HEURE_DEFAUT;
}

/**
 * Barrières de l'envoi public, dans Redis (partagées entre les serveurs) :
 *  1. doublon : `SET NX PX` sur le numéro et l'empreinte du commentaire ;
 *  2. plafonds : `INCR` atomique dans une transaction qui pose l'expiration à
 *     la création de la clé (par numéro sur 24 h, puis global sur l'heure).
 *     Au premier refus, tout ce qui a été pris est rendu, doublon compris,
 *     puis 429.
 */
@Injectable()
export class AvisPriveLimitesService implements OnModuleDestroy {
  private readonly logger = new Logger(AvisPriveLimitesService.name);
  private dernierJournalGlobal = 0;

  constructor(@Inject(REDIS_AVIS_PRIVES) private readonly redis: ClientRedisAvis) {}

  async onModuleDestroy(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      // déjà fermée
    }
  }

  async reserver(numero: string, empreinte: string): Promise<ReservationAvis> {
    const doublon = cleDoublon(numero, empreinte);
    try {
      const pose = await this.commande(() => this.redis.set(doublon, '1', 'PX', DELAI_DOUBLON_MS, 'NX'));
      if (pose !== 'OK') return { etat: 'doublon' };
    } catch (erreur) {
      this.journaliserPanne(erreur);
      return { etat: 'panne' };
    }

    const plafonds = [
      { cle: clePlafondNumero(numero), max: MAX_AVIS_PAR_NUMERO, fenetre: FENETRE_NUMERO_MS, message: MESSAGE_PLAFOND_NUMERO, global: false },
      { cle: CLE_PLAFOND_GLOBAL, max: maxAvisParHeure(), fenetre: FENETRE_GLOBALE_MS, message: MESSAGE_PLAFOND_GLOBAL, global: true },
    ];
    const pris: { cle: string; fenetre: number }[] = [];
    try {
      for (const plafond of plafonds) {
        const valeur = await this.incrementer(plafond.cle, plafond.fenetre);
        pris.push(plafond);
        if (valeur > plafond.max) {
          if (plafond.global) this.journaliserPlafondGlobal(plafond.max);
          throw new HttpException(plafond.message, HttpStatus.TOO_MANY_REQUESTS);
        }
      }
    } catch (erreur) {
      if (!(erreur instanceof HttpException)) {
        // Panne en cours de route : ce qui est compté le reste, l'avis passe.
        this.journaliserPanne(erreur);
        return { etat: 'panne' };
      }
      await this.rendre(pris, doublon);
      throw erreur;
    }
    return { etat: 'ok', cleDoublon: doublon };
  }

  /**
   * L'écriture a échoué : le doublon est levé, sinon le nouvel essai du client
   * serait pris pour un double appui et « réussirait » sans rien enregistrer.
   * Les plafonds restent pris.
   */
  async annuler(reservation: ReservationAvis): Promise<void> {
    if (reservation.etat !== 'ok') return;
    try {
      await this.commande(() => this.redis.del(reservation.cleDoublon));
    } catch (erreur) {
      this.journaliserPanne(erreur);
    }
  }

  /** `SET NX PX` puis `INCR`, d'un bloc : la clé ne peut pas naître sans expiration. */
  private async incrementer(cle: string, fenetre: number): Promise<number> {
    const resultats = await this.commande(() =>
      this.redis.multi().set(cle, '0', 'PX', fenetre, 'NX').incr(cle).exec(),
    );
    const [erreur, valeur] = resultats?.[1] ?? [new Error('transaction annulée'), null];
    if (erreur) throw new PanneRedis(texteErreur(erreur));
    if (typeof valeur !== 'number') throw new PanneRedis(`réponse inattendue : ${String(valeur)}`);
    return valeur;
  }

  /** Rend les compteurs pris (même garde qu'à l'incrément) et lève le doublon. */
  private async rendre(pris: { cle: string; fenetre: number }[], doublon: string): Promise<void> {
    for (const { cle, fenetre } of pris) {
      try {
        await this.commande(() => this.redis.multi().set(cle, '0', 'PX', fenetre, 'NX').decr(cle).exec());
      } catch (erreur) {
        this.journaliserPanne(erreur);
      }
    }
    try {
      await this.commande(() => this.redis.del(doublon));
    } catch (erreur) {
      this.journaliserPanne(erreur);
    }
  }

  private async commande<T>(appel: () => Promise<T>): Promise<T> {
    try {
      return await avantDelai(appel(), DELAI_REDIS_MS);
    } catch (erreur) {
      throw erreur instanceof PanneRedis ? erreur : new PanneRedis(texteErreur(erreur));
    }
  }

  private journaliserPlafondGlobal(max: number): void {
    const maintenant = Date.now();
    if (maintenant - this.dernierJournalGlobal < INTERVALLE_JOURNAL_MS) return;
    this.dernierJournalGlobal = maintenant;
    this.logger.error(`Plafond des avis atteint (${max} par heure) : envois refusés.`);
  }

  private journaliserPanne(erreur: unknown): void {
    this.logger.error(`Barrières des avis indisponibles (Redis) : ${texteErreur(erreur)}`);
  }
}
