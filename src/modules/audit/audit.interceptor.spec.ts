/**
 * Journal d'audit : ce qui est copié du corps et de la requête.
 *
 * Retours privés « Ton avis compte » : le contenu personnel (commentaire,
 * numéro, prénom, notes des agents, recherche) n'est jamais copié dans
 * audit_logs. Sinon il survivrait à la suppression de l'avis (droit à
 * l'effacement annoncé sur le site : « Pour le faire supprimer : 27 21 71 21 30 »).
 */
import { CallHandler, ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';
import { AuditInterceptor } from './audit.interceptor';
import { AuditEntry } from './audit.service';

const AVIS = '11111111-1111-4111-8111-111111111111';
const AGENT = { id: 'u-cc', fullname: 'Gbonhi Max', role: 'CALL_CENTER', restaurant_id: null };

async function journaliser(
  req: Record<string, unknown>,
  statut = 201,
  erreur?: { status: number },
): Promise<AuditEntry | undefined> {
  const entrees: AuditEntry[] = [];
  const intercepteur = new AuditInterceptor({ record: (e: AuditEntry) => entrees.push(e) } as never);
  const contexte = {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => ({ headers: {}, ...req }), getResponse: () => ({ statusCode: statut }) }),
  } as unknown as ExecutionContext;
  const suite: CallHandler = { handle: () => (erreur ? throwError(() => erreur) : of({ ok: true })) };
  await lastValueFrom(intercepteur.intercept(contexte, suite)).catch(() => undefined);
  return entrees[0];
}

describe('AuditInterceptor : contenu personnel des retours privés', () => {
  it('note du journal d’un avis : masquée, l’action et le résultat restent', async () => {
    const entree = await journaliser({
      method: 'POST',
      originalUrl: `/api/v1/avis-prives/${AVIS}/journal`,
      user: AGENT,
      body: { action: 'APPEL', resultat: 'JOINT', note: 'Awa Koné, Riviera 3, rembourser sur Wave au 0707000001' },
    });
    expect(entree?.entity_id).toBe(AVIS);
    expect(entree?.metadata).toEqual({ body: { action: 'APPEL', resultat: 'JOINT', note: '***' } });
    expect(JSON.stringify(entree)).not.toContain('Riviera');
  });

  it('envoi public qui finit en erreur serveur : commentaire, numéro et prénom masqués', async () => {
    const entree = await journaliser(
      {
        method: 'POST',
        originalUrl: '/api/v1/avis-prives',
        body: {
          ressenti: 'PAS_CONTENT',
          canal: 'TELEPHONE',
          commentaire: 'Livreur impoli, je vis à Riviera 3.',
          telephone: '+2250707000001',
          prenom: 'Awa',
        },
      },
      500,
      { status: 500 },
    );
    expect(entree?.metadata).toEqual({
      body: { ressenti: 'PAS_CONTENT', canal: 'TELEPHONE', commentaire: '***', telephone: '***', prenom: '***' },
    });
  });

  it('recherche d’un numéro dans la liste, refusée : masquée dans la requête journalisée', async () => {
    const entree = await journaliser(
      {
        method: 'GET',
        originalUrl: '/api/v1/avis-prives?recherche=0707000001&periode=hier',
        user: AGENT,
        query: { recherche: '0707000001', periode: 'hier' },
      },
      400,
      { status: 400 },
    );
    expect(entree?.metadata).toEqual({ query: { recherche: '***', periode: 'hier' } });
  });

  it('ailleurs, rien ne change : une note d’un autre module reste journalisée', async () => {
    const entree = await journaliser({
      method: 'PATCH',
      originalUrl: '/api/v1/orders/abc/note',
      user: AGENT,
      body: { note: 'Sans piment', password: 'secret' },
    });
    expect(entree?.metadata).toEqual({ body: { note: 'Sans piment', password: '***' } });
  });
});
