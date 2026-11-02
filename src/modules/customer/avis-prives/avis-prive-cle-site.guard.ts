import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'crypto';

/** En-tête qui porte la clé partagée entre le serveur du site et l'API. */
export const ENTETE_CLE_SITE = 'x-cle-site';
/** Longueur minimale de la clé (`openssl rand -hex 32` en donne 64). */
export const CLE_SITE_MIN = 32;

export const MESSAGE_CLE_SITE_REFUSEE = 'Accès refusé.';
export const MESSAGE_CLE_SITE_ABSENTE = "L'envoi des avis est momentanément indisponible.";

/** Clé `CLE_SERVEUR_SITE` de l'API, ou `null` si elle est absente ou trop courte. */
export function cleSiteConfiguree(env: NodeJS.ProcessEnv = process.env): string | null {
  const cle = (env.CLE_SERVEUR_SITE ?? '').trim();
  return cle.length >= CLE_SITE_MIN ? cle : null;
}

const empreinte = (texte: string) => createHash('sha256').update(texte).digest();

/**
 * La requête porte-t-elle la clé du serveur du site ? Comparaison à temps
 * constant (empreintes de même longueur) : la durée de la réponse ne dit rien
 * de la clé. Faux si l'API n'a pas de clé configurée.
 */
export function cleSiteValide(
  req: { headers?: Record<string, unknown> } | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const attendue = cleSiteConfiguree(env);
  const recue = req?.headers?.[ENTETE_CLE_SITE];
  if (!attendue || typeof recue !== 'string' || !recue) return false;
  return timingSafeEqual(empreinte(attendue), empreinte(recue));
}

/**
 * Réserve l'envoi public d'un avis (POST /avis-prives) au SERVEUR DU SITE.
 *
 * L'API est publique et `trust proxy` lui fait lire l'adresse du visiteur
 * dans X-Forwarded-For, que n'importe quel appelant peut écrire. Sans cette
 * garde, un script appelant l'API en direct changeait d'adresse à chaque
 * envoi : la limite par IP ne comptait plus rien, et le plafond global de
 * l'heure devenait un moyen de bloquer tous les vrais clients. Le serveur du
 * site ajoute la clé (variable `CLE_SERVEUR_SITE`, la même des deux côtés),
 * un appel direct n'a pas la clé : 403, avant toute limite, écriture ou cloche.
 *
 * Clé absente ou trop courte dans l'API : 503 et une erreur au journal (au
 * plus une par minute). On refuse plutôt que de rouvrir la faille.
 */
@Injectable()
export class AvisPriveCleSiteGuard implements CanActivate {
  private readonly logger = new Logger(AvisPriveCleSiteGuard.name);
  private dernierJournal = 0;

  canActivate(context: ExecutionContext): boolean {
    if (!cleSiteConfiguree()) {
      const maintenant = Date.now();
      if (maintenant - this.dernierJournal > 60_000) {
        this.dernierJournal = maintenant;
        this.logger.error(
          `CLE_SERVEUR_SITE absente ou de moins de ${CLE_SITE_MIN} caractères : les avis du site sont refusés.`,
        );
      }
      throw new ServiceUnavailableException(MESSAGE_CLE_SITE_ABSENTE);
    }
    if (!cleSiteValide(context.switchToHttp().getRequest())) {
      throw new ForbiddenException(MESSAGE_CLE_SITE_REFUSEE);
    }
    return true;
  }
}
