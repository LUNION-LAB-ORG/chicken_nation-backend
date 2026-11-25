import { API_PAYSTACK } from './paystack.rules';

/**
 * Appel à l'API de Paystack (`Authorization: Bearer <clé secrète>`), avec un
 * délai borné. Réseau, délai ou 5xx : INJOIGNABLE (à retenter). 404 ou
 * « not found » : INTROUVABLE. Autre refus : REFUS, avec le message de
 * Paystack (tronqué) pour le journal du serveur et l'écran d'administration,
 * jamais pour le client. La clé n'apparaît jamais dans une erreur.
 */
export type NatureErreurPaystack = 'INJOIGNABLE' | 'REFUS' | 'INTROUVABLE' | 'NON_CONFIGURE';

export class ErreurPaystack extends Error {
  constructor(
    public readonly nature: NatureErreurPaystack,
    public readonly statutHttp: number | null,
    public readonly messagePaystack: string | null,
  ) {
    super(
      nature === 'INJOIGNABLE'
        ? 'Paystack injoignable'
        : nature === 'INTROUVABLE'
          ? 'Inconnu chez Paystack'
          : nature === 'NON_CONFIGURE'
            ? "Paystack n'est pas configuré"
            : `Refusé par Paystack${messagePaystack ? ` : ${messagePaystack}` : ''}`,
    );
    this.name = 'ErreurPaystack';
  }
}

export interface ReponsePaystack {
  data: unknown;
  meta: Record<string, unknown> | null;
}

const objet = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

export async function appelerPaystack(
  cle: string | null,
  methode: 'GET' | 'POST' | 'PUT',
  chemin: string,
  corps: unknown = null,
  delaiMs = 10_000,
  apiUrl = API_PAYSTACK,
): Promise<ReponsePaystack> {
  if (!cle) throw new ErreurPaystack('NON_CONFIGURE', null, null);
  let reponse: Response;
  let texte: string;
  try {
    reponse = await fetch(`${apiUrl}${chemin}`, {
      method: methode,
      headers: { authorization: `Bearer ${cle}`, 'content-type': 'application/json', accept: 'application/json' },
      body: corps === null ? undefined : JSON.stringify(corps),
      signal: AbortSignal.timeout(delaiMs),
      redirect: 'error',
    });
    texte = await reponse.text();
  } catch {
    throw new ErreurPaystack('INJOIGNABLE', null, null);
  }
  let json: Record<string, unknown> | null = null;
  try {
    json = objet(JSON.parse(texte));
  } catch {
    json = null;
  }
  const message = typeof json?.message === 'string' ? json.message.slice(0, 200) : null;
  if (reponse.status >= 200 && reponse.status < 300 && json?.status !== false) {
    return { data: json?.data ?? null, meta: objet(json?.meta) };
  }
  if (reponse.status >= 500) throw new ErreurPaystack('INJOIGNABLE', reponse.status, message);
  if (reponse.status === 404 || /not found/i.test(message ?? '')) {
    throw new ErreurPaystack('INTROUVABLE', reponse.status, message);
  }
  throw new ErreurPaystack('REFUS', reponse.status, message);
}
