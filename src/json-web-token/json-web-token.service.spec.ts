import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { JsonWebTokenService, MESSAGE_JETON_EXPIRE } from './json-web-token.service';

/**
 * `verifyToken` (passerelle temps réel) : un jeton bien signé mais périmé est
 * distingué d'un jeton refusé. La passerelle en tire le motif `JETON_EXPIRE`
 * et lit le livreur du jeton pour son journal : cela n'a de sens que si la
 * signature a été contrôlée AVANT l'échéance.
 */

const SECRET_LIVREUR = 'secret-livreur-test';

function creerService() {
  const valeurs: Record<string, string> = { DELIVERER_TOKEN_SECRET: SECRET_LIVREUR };
  const config = { get: (cle: string, defaut?: string) => valeurs[cle] ?? defaut };
  const jwt = new JwtService();
  return { service: new JsonWebTokenService(jwt, config as never), jwt };
}

const ilYA = (secondes: number) => Math.floor(Date.now() / 1000) - secondes;

async function motifRefus(promesse: Promise<unknown>): Promise<string> {
  try {
    await promesse;
  } catch (erreur) {
    expect(erreur).toBeInstanceOf(UnauthorizedException);
    return (erreur as Error).message;
  }
  throw new Error('jeton accepté');
}

describe('JsonWebTokenService.verifyToken', () => {
  it('jeton valide : charge rendue', async () => {
    const { service, jwt } = creerService();
    const jeton = jwt.sign({ sub: 'livreur-1' }, { secret: SECRET_LIVREUR, expiresIn: '1h' });
    await expect(service.verifyToken(jeton, 'deliverer')).resolves.toMatchObject({ sub: 'livreur-1' });
  });

  it('jeton bien signé mais périmé : « Token expiré »', async () => {
    const { service, jwt } = creerService();
    const jeton = jwt.sign({ sub: 'livreur-1', exp: ilYA(60) }, { secret: SECRET_LIVREUR });
    expect(await motifRefus(service.verifyToken(jeton, 'deliverer'))).toBe(MESSAGE_JETON_EXPIRE);
  });

  it('jeton périmé signé avec un autre secret : « Token invalide », jamais « expiré »', async () => {
    const { service, jwt } = creerService();
    const jeton = jwt.sign({ sub: 'livreur-1', exp: ilYA(60) }, { secret: 'autre-secret' });
    expect(await motifRefus(service.verifyToken(jeton, 'deliverer'))).toBe('Token invalide');
  });

  it('jeton abîmé : « Token invalide »', async () => {
    const { service } = creerService();
    expect(await motifRefus(service.verifyToken('pas.un.jeton', 'deliverer'))).toBe('Token invalide');
  });
});
