import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';

import { avantDelai } from '../helpers/file-par-cle.helper';
import {
  cleDelaiEnvoi,
  FENETRE_ENVOIS_MS,
  messageDelaiEnvoi,
  PlafondEnvoi,
  plafondsEnvoi,
  secondesRestantes,
} from '../helpers/envois-otp.helper';
import { ClientRedisEnvois, REDIS_ENVOIS_OTP } from './redis-envois.provider';

// Au-delà, une commande Redis est abandonnée et l'envoi continue sans elle.
const DELAI_REDIS_MS = 1000;
// Un plafond commun atteint est journalisé au plus une fois par minute.
const INTERVALLE_JOURNAL_MS = 60 * 1000;

export interface DemandeEnvoiCode {
  /** Numéro sous sa forme canonique `+<indicatif>…`. */
  telephone: string;
  /** Un compte a déjà prouvé qu'il détient ce numéro (voir `plafondsEnvoi`). */
  compteConnu: boolean;
  /** Délai minimum entre deux envois au même numéro. */
  delaiMs: number;
}

/** Erreur de Redis (panne, délai dépassé), distincte d'un refus des plafonds. */
class PanneRedis extends Error {}

const texteErreur = (erreur: unknown) => (erreur instanceof Error ? erreur.message : String(erreur));

/**
 * Point de passage OBLIGÉ avant tout envoi de code à un numéro (clients et
 * livreurs). Voir envois-otp.helper pour les barrières.
 *
 * `encadrerEnvoi` appelle `reserver` AVANT de créer le code et de l'envoyer :
 *  1. délai entre deux envois : `SET NX PX`, un seul appel l'obtient même en
 *     rafale ; un refus ne compte rien ;
 *  2. compteurs : `INCR` atomique dans une transaction qui pose l'expiration à
 *     la création de la clé. Au premier plafond dépassé, tout ce qui a été pris
 *     est rendu (rien n'est parti), puis 429.
 *
 * Panne de Redis : l'envoi continue (la connexion des clients passe avant),
 * avec un journal d'erreur. Le délai en base (OtpService) reste en place.
 */
@Injectable()
export class EnvoisOtpService implements OnModuleDestroy {
  private readonly logger = new Logger(EnvoisOtpService.name);
  private readonly derniersJournaux = new Map<string, number>();

  constructor(@Inject(REDIS_ENVOIS_OTP) private readonly redis: ClientRedisEnvois) {}

  async onModuleDestroy(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      // déjà fermée
    }
  }

  /**
   * Réserve l'envoi d'un code, ou lève 429 (délai, plafond par numéro ou
   * plafond commun) sans rien compter.
   */
  async reserver({ telephone, compteConnu, delaiMs }: DemandeEnvoiCode): Promise<void> {
    const cleDelai = cleDelaiEnvoi(telephone);
    try {
      const pose = await this.commande(() => this.redis.set(cleDelai, '1', 'PX', delaiMs, 'NX'));
      if (pose !== 'OK') {
        const reste = await this.commande(() => this.redis.pttl(cleDelai)).catch(() => null);
        throw new HttpException(
          messageDelaiEnvoi(secondesRestantes(reste, delaiMs)),
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    } catch (erreur) {
      if (erreur instanceof HttpException) throw erreur;
      this.journaliserPanne(erreur);
      return;
    }

    const pris: string[] = [];
    try {
      for (const plafond of plafondsEnvoi(telephone, compteConnu, process.env)) {
        const envois = await this.incrementer(plafond.cle);
        pris.push(plafond.cle);
        if (envois > plafond.max) throw this.refus(plafond);
      }
    } catch (erreur) {
      if (!(erreur instanceof HttpException)) {
        // Panne en cours de route : le code part quand même, ce qui est déjà
        // compté le reste.
        this.journaliserPanne(erreur);
        return;
      }
      // Refus : rien ne part, on rend les compteurs pris et le délai.
      await this.rendre(pris, cleDelai);
      throw erreur;
    }
  }

  /**
   * Réserve l'envoi (`reserver`), puis exécute `envoi` : écritures, création
   * et envoi du code. C'est la forme à employer pour tout envoi de code.
   *
   * Si `envoi` échoue autrement que par un refus 429, aucun code n'est parti
   * (Twilio en échec, base indisponible) : le délai est levé, sinon la
   * nouvelle tentative, que l'application relance d'elle-même après une
   * réponse 500, serait refusée par « Un code vient d'être envoyé ». Un refus
   * 429 (délai en base) garde le délai : un code est bien parti il y a peu.
   */
  async encadrerEnvoi<T>(demande: DemandeEnvoiCode, envoi: () => Promise<T>): Promise<T> {
    await this.reserver(demande);
    try {
      return await envoi();
    } catch (erreur) {
      const refus =
        erreur instanceof HttpException && erreur.getStatus() === HttpStatus.TOO_MANY_REQUESTS;
      if (!refus) await this.liberer(demande.telephone);
      throw erreur;
    }
  }

  /**
   * Lève le délai du numéro. Les compteurs restent pris (Twilio a pu facturer
   * un essai).
   */
  async liberer(telephone: string): Promise<void> {
    try {
      await this.commande(() => this.redis.del(cleDelaiEnvoi(telephone)));
    } catch (erreur) {
      this.journaliserPanne(erreur);
    }
  }

  /** `SET NX PX` puis `INCR`, d'un bloc : la clé ne peut pas naître sans expiration. */
  private async incrementer(cle: string): Promise<number> {
    const resultats = await this.commande(() =>
      this.redis.multi().set(cle, '0', 'PX', FENETRE_ENVOIS_MS, 'NX').incr(cle).exec(),
    );
    const [erreur, valeur] = resultats?.[1] ?? [new Error('transaction annulée'), null];
    if (erreur) throw new PanneRedis(texteErreur(erreur));
    if (typeof valeur !== 'number') throw new PanneRedis(`réponse inattendue : ${String(valeur)}`);
    return valeur;
  }

  /**
   * Rend les compteurs pris et lève le délai. Le `SET NX PX` précède le DECR
   * pour la même raison qu'à l'incrément : si la clé vient d'expirer, un DECR
   * seul la recréerait à -1 SANS expiration, et ce compteur ne repartirait
   * plus jamais de zéro (plafond commun bloqué pour de bon).
   */
  private async rendre(cles: string[], cleDelai: string): Promise<void> {
    for (const cle of cles) {
      try {
        await this.commande(() =>
          this.redis.multi().set(cle, '0', 'PX', FENETRE_ENVOIS_MS, 'NX').decr(cle).exec(),
        );
      } catch (erreur) {
        this.journaliserPanne(erreur);
      }
    }
    try {
      await this.commande(() => this.redis.del(cleDelai));
    } catch (erreur) {
      this.journaliserPanne(erreur);
    }
  }

  private refus(plafond: PlafondEnvoi): HttpException {
    if (plafond.commun) {
      const maintenant = Date.now();
      const dernier = this.derniersJournaux.get(plafond.cle) ?? 0;
      if (maintenant - dernier >= INTERVALLE_JOURNAL_MS) {
        this.derniersJournaux.set(plafond.cle, maintenant);
        this.logger.error(
          `Plafond d'envoi de codes atteint (${plafond.cle}, ${plafond.max} par heure) : envois suspendus.`,
        );
      }
    }
    return new HttpException(plafond.message, HttpStatus.TOO_MANY_REQUESTS);
  }

  /** Commande Redis bornée dans le temps ; toute erreur devient une PanneRedis. */
  private async commande<T>(appel: () => Promise<T>): Promise<T> {
    try {
      return await avantDelai(appel(), DELAI_REDIS_MS);
    } catch (erreur) {
      throw erreur instanceof PanneRedis ? erreur : new PanneRedis(texteErreur(erreur));
    }
  }

  private journaliserPanne(erreur: unknown): void {
    this.logger.error(`Plafonds d'envoi de codes indisponibles (Redis) : ${texteErreur(erreur)}`);
  }
}
