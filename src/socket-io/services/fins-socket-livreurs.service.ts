import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { Redis } from 'ioredis';

import { JournalLimite, suffixeTues } from 'src/common/utils/journal-limite.util';
import type { FinSocket } from 'src/modules/deliverers/helpers/disponibilite.rules';

import {
  EVENEMENT_LIVREUR_CONNECTE,
  EVENEMENT_LIVREUR_DECONNECTE,
  LivreurDeconnecte,
} from '../utils/evenements-connexion.util';
import { REDIS_FINS_SOCKET } from './redis-fins-socket.provider';

/** Ce que le service utilise de ioredis (remplaçable par un double en test). */
export type ClientRedisFinsSocket = Pick<Redis, 'set' | 'del' | 'mget' | 'quit'>;

/** Clé Redis de la fin du dernier socket d'un livreur. */
export const cleFinSocket = (delivererId: string) => `livreur:fin-socket:${delivererId}`;

/**
 * Gardée jusqu'à la prochaine connexion du livreur (effacée à chaque ouverture
 * de socket) ; l'expiration de 30 jours ne sert qu'au ménage d'un compte qui
 * ne revient plus. Relecture du 26/10 : à 12 h, la preuve disparaissait alors
 * qu'une appli fermée laisse le livreur en service sans limite (rien ne le
 * sort de la file la nuit). Le matin, le même livreur passait de « Appli
 * fermée » à « Connexion coupée » sans rien changer chez lui.
 */
export const DUREE_FIN_SOCKET_S = 30 * 24 * 3600;

/** Au-delà, la lecture est abandonnée : aucune preuve (même délai que la présence des sockets). */
export const DELAI_FINS_SOCKET_MS = 1500;

/** Une panne de Redis au plus une fois par minute au journal. */
const INTERVALLE_JOURNAL_MS = 60_000;

const texteErreur = (erreur: unknown) => (erreur instanceof Error ? erreur.message : String(erreur));

function avantDelai<T>(promesse: Promise<T>, ms: number): Promise<T> {
  let minuteur: ReturnType<typeof setTimeout> | undefined;
  const delai = new Promise<never>((_, rejeter) => {
    minuteur = setTimeout(() => rejeter(new Error(`délai de ${ms} ms dépassé`)), ms);
  });
  return Promise.race([promesse, delai]).finally(() => clearTimeout(minuteur));
}

/** Fin lue dans Redis ; illisible ou incomplète : aucune (pas de preuve). */
function lireFin(brut: string | null): FinSocket | null {
  if (!brut) return null;
  try {
    const v = JSON.parse(brut) as { raison?: unknown; a?: unknown };
    if (typeof v.raison !== 'string' || typeof v.a !== 'string') return null;
    const a = new Date(v.a);
    return Number.isNaN(a.getTime()) ? null : { raison: v.raison, a };
  } catch {
    return null;
  }
}

/**
 * FIN DU DERNIER SOCKET DE CHAQUE LIVREUR (retour du client du 25/10 :
 * « Appli fermée » affiché pour une appli restée ouverte, réseau coupé ou
 * téléphone qui la bloque).
 *
 * La passerelle reçoit la raison socket.io de chaque fin de socket
 * (`EVENEMENT_LIVREUR_DECONNECTE`) : elle est gardée ici, dans Redis (toutes
 * les instances la lisent), jusqu'à ce qu'un nouveau socket du livreur
 * s'ouvre (`EVENEMENT_LIVREUR_CONNECTE`), 30 jours au plus. La règle unique n'en tire
 * « Appli fermée » que pour `client namespace disconnect` (l'appli a fermé
 * elle-même son socket) suivi d'aucun signe de vie (`fermetureProuvee`) ;
 * tout autre silence est une connexion coupée.
 *
 * Rien ne bloque ni n'échoue à cause de Redis : une écriture perdue ou une
 * lecture impossible (null) ne donne aucune preuve, donc « Connexion
 * coupée », jamais « Appli fermée ». Mêmes options que le minuteur en ligne
 * (pas de file hors ligne, un seul essai).
 */
@Injectable()
export class FinsSocketLivreursService implements OnModuleDestroy {
  private readonly logger = new Logger(FinsSocketLivreursService.name);
  private readonly journal = new JournalLimite(INTERVALLE_JOURNAL_MS);

  constructor(@Inject(REDIS_FINS_SOCKET) private readonly redis: ClientRedisFinsSocket) {}

  async onModuleDestroy(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      // déjà fermée
    }
  }

  /** Un socket du livreur vient de finir : sa raison et son heure remplacent la fin précédente. */
  @OnEvent(EVENEMENT_LIVREUR_DECONNECTE)
  async noterFin(p: LivreurDeconnecte): Promise<void> {
    if (!p?.delivererId) return;
    try {
      const valeur = JSON.stringify({ raison: String(p.raison ?? ''), a: p.a });
      await avantDelai(this.redis.set(cleFinSocket(p.delivererId), valeur, 'EX', DUREE_FIN_SOCKET_S), DELAI_FINS_SOCKET_MS);
    } catch (erreur) {
      this.signalerPanne('écriture', erreur);
    }
  }

  /** Un socket du livreur vient de s'ouvrir : l'ancienne fin ne vaut plus. */
  @OnEvent(EVENEMENT_LIVREUR_CONNECTE)
  async effacer(p: { delivererId: string }): Promise<void> {
    if (!p?.delivererId) return;
    try {
      await avantDelai(this.redis.del(cleFinSocket(p.delivererId)), DELAI_FINS_SOCKET_MS);
    } catch (erreur) {
      this.signalerPanne('effacement', erreur);
    }
  }

  /**
   * Fin du dernier socket de ces livreurs, en une commande. Livreur sans fin
   * gardée (socket rouvert, jamais connecté, plus de 30 jours) : absent. Null :
   * Redis muet ou trop lent, aucune preuve.
   */
  async lire(ids: readonly string[]): Promise<Map<string, FinSocket> | null> {
    const fins = new Map<string, FinSocket>();
    const voulus = [...new Set(ids)];
    if (voulus.length === 0) return fins;
    try {
      const valeurs = await avantDelai(this.redis.mget(...voulus.map(cleFinSocket)), DELAI_FINS_SOCKET_MS);
      voulus.forEach((id, i) => {
        const fin = lireFin(valeurs[i] ?? null);
        if (fin) fins.set(id, fin);
      });
      return fins;
    } catch (erreur) {
      this.signalerPanne('lecture', erreur);
      return null;
    }
  }

  /** `lire` pour les seuls livreurs sans socket ouvert ; présence inconnue (null) : tous. */
  async lireSansSocket(
    ids: readonly string[],
    connectes: ReadonlySet<string> | null,
  ): Promise<Map<string, FinSocket> | null> {
    return this.lire(ids.filter((id) => !connectes?.has(id)));
  }

  private signalerPanne(quoi: string, erreur: unknown): void {
    const tues = this.journal.autoriser('redis');
    if (tues === null) return;
    this.logger.warn(
      `Fins de socket des livreurs : ${quoi} impossible (${texteErreur(erreur)}), ` +
        `aucune appli dite fermée sans preuve${suffixeTues(tues)}`,
    );
  }
}
