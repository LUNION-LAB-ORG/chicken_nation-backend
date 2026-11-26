import { CallStatus, UserRole } from '@prisma/client';

import {
  APPLI_CLIENT_PRETE_JOURS,
  APPLI_CLIENT_RAFRAICHIE_MS,
  CorrespondantClient,
  LIBELLE_CLIENT,
  ROLES_APPEL_CLIENT,
} from '../constants/calls.constants';

/**
 * Appels avec les clients dans l'appli Chicken Nation (demande du 26/11) :
 * règles pures, sans base ni socket, testées à part.
 *
 *  - Le client appelle le service client : la sonnerie du centre d'appels dit
 *    qui appelle et pour quelle commande (`appelantClient`).
 *  - Le client appelle le livreur de sa commande : le livreur voit le prénom
 *    du client, jamais son numéro (`nomClientPourLivreur`).
 *  - Le service client appelle un client dans l'appli : seuls l'admin et le
 *    rôle CALL_CENTER le peuvent (`peutAppelerClient`), et seulement si
 *    l'appli du client sait prendre un appel (`appliClientPrete`).
 */

/** Client tel qu'il est lu pour un appel. */
export interface ClientLu {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
  phone?: string | null;
}

/**
 * Le client qui appelle, tel que le personnel le voit : sur `call:incoming`,
 * sur chaque entrée de `GET /calls/ringing` et sur `GET /calls/active`.
 */
export interface AppelantClient {
  id: string;
  /** « Awa Koné » ; à défaut son téléphone ; à défaut « Client ». */
  nom: string;
  /** Numéro complet (+225…). */
  telephone: string | null;
  /** Commande dont il parle : identifiant et référence, null sans commande. */
  commande_id: string | null;
  commande_reference: string | null;
}

const texte = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null;

/** « Awa Koné » ; à défaut son téléphone ; à défaut « Client ». Pour le personnel. */
export function nomClient(c: Pick<ClientLu, 'first_name' | 'last_name' | 'phone'> | null | undefined): string {
  if (!c) return LIBELLE_CLIENT;
  const nom = [texte(c.first_name), texte(c.last_name)].filter(Boolean).join(' ');
  return nom || texte(c.phone) || LIBELLE_CLIENT;
}

/**
 * Ce que le livreur voit du client qui l'appelle : son prénom (à défaut son
 * nom), jamais son numéro. Sans nom : « Client ».
 */
export function nomClientPourLivreur(c: Pick<ClientLu, 'first_name' | 'last_name'> | null | undefined): string {
  if (!c) return LIBELLE_CLIENT;
  return texte(c.first_name) ?? texte(c.last_name) ?? LIBELLE_CLIENT;
}

export function appelantClient(
  c: ClientLu,
  commande?: { id?: string | null; reference?: string | null } | null,
): AppelantClient {
  return {
    id: c.id,
    nom: nomClient(c),
    telephone: texte(c.phone),
    commande_id: texte(commande?.id),
    commande_reference: texte(commande?.reference),
  };
}

/** Ce rôle du personnel peut-il appeler un client dans l'appli ? */
export function peutAppelerClient(role: UserRole | string | null | undefined): boolean {
  return !!role && (ROLES_APPEL_CLIENT as readonly string[]).includes(role);
}

/**
 * L'appli du client sait-elle prendre un appel ? Elle l'a dit récemment
 * (`Customer.appels_appli_at`, écrit à l'ouverture de l'appli). Jamais dit, ou
 * il y a trop longtemps : le service client appelle au téléphone.
 */
export function appliClientPrete(appelsAppliAt: Date | null | undefined, maintenant: number): boolean {
  if (!appelsAppliAt) return false;
  const ms = appelsAppliAt.getTime();
  if (!Number.isFinite(ms)) return false;
  return maintenant - ms <= APPLI_CLIENT_PRETE_JOURS * 24 * 60 * 60 * 1000;
}

/** Faut-il réécrire `appels_appli_at` ? Une fois par jour au plus. */
export function appliClientARafraichir(appelsAppliAt: Date | null | undefined, maintenant: number): boolean {
  if (!appelsAppliAt) return true;
  return maintenant - appelsAppliAt.getTime() >= APPLI_CLIENT_RAFRAICHIE_MS;
}

/** Qui le client a au bout du fil : le livreur de sa commande, sinon le service client. */
export function correspondantDuClient(appel: {
  caller_customer_id: string | null;
  target_deliverer_id: string | null;
}): CorrespondantClient {
  return appel.caller_customer_id && appel.target_deliverer_id ? 'LIVREUR' : 'SERVICE_CLIENT';
}

/**
 * Où en est l'appel, vu du client (`GET /calls/customer/active`) :
 *  - `calling`   : il appelle, ça sonne ;
 *  - `ringing`   : le service client l'appelle, il peut décrocher ;
 *  - `connected` : en ligne.
 */
export function phasePourClient(
  appel: { status: CallStatus; caller_customer_id: string | null },
  customerId: string,
): { direction: 'outgoing' | 'incoming'; phase: 'calling' | 'ringing' | 'connected' } {
  const sortant = appel.caller_customer_id === customerId;
  if (appel.status === CallStatus.ONGOING) {
    return { direction: sortant ? 'outgoing' : 'incoming', phase: 'connected' };
  }
  return sortant
    ? { direction: 'outgoing', phase: 'calling' }
    : { direction: 'incoming', phase: 'ringing' };
}

/** Ce qu'on lit d'un client pour un appel (inclusions Prisma des appels). */
export const SELECT_CLIENT_APPEL = {
  id: true,
  first_name: true,
  last_name: true,
  phone: true,
} as const;
