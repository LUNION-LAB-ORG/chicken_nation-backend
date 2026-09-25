/**
 * Signature des callbacks HubRise (en-tête X-HubRise-Hmac-SHA256).
 *
 * Sans cette vérification, n'importe qui peut poster un faux événement avec la
 * location d'un restaurant relié : l'API interroge alors HubRise avec NOTRE
 * jeton (quota épuisé, synchro réelle bloquée) et resynchronise commandes et
 * clients à la demande de l'attaquant.
 */

import { createHmac } from 'crypto';
import { verifierSignatureHubrise } from './signature-webhook.util';

const SECRET = 'client-secret-de-test';
const CORPS = Buffer.from(
  JSON.stringify({
    resource_type: 'order',
    event_type: 'create',
    location_id: '3r4s3-0',
    resource_id: '5dpm9',
  }),
  'utf8',
);
const signer = (corps: Buffer, secret = SECRET) =>
  createHmac('sha256', secret).update(corps).digest('hex');

describe('verifierSignatureHubrise', () => {
  it('accepte la signature exacte du corps brut', () => {
    expect(verifierSignatureHubrise(CORPS, signer(CORPS), SECRET)).toBe(true);
  });

  it('accepte l’hexadécimal en majuscules et les espaces autour', () => {
    expect(verifierSignatureHubrise(CORPS, ` ${signer(CORPS).toUpperCase()} `, SECRET)).toBe(true);
  });

  it('calcule sur les OCTETS : un accent réencodé change la signature', () => {
    const corps = Buffer.from('{"name":"Crème brûlée"}', 'utf8');
    const latin1 = Buffer.from('{"name":"Crème brûlée"}', 'latin1');
    expect(verifierSignatureHubrise(corps, signer(corps), SECRET)).toBe(true);
    expect(verifierSignatureHubrise(latin1, signer(corps), SECRET)).toBe(false);
  });

  it('refuse un corps modifié', () => {
    const modifie = Buffer.from(CORPS.toString('utf8').replace('5dpm9', '5dpm8'), 'utf8');
    expect(verifierSignatureHubrise(modifie, signer(CORPS), SECRET)).toBe(false);
  });

  it('refuse une signature altérée', () => {
    const sig = signer(CORPS);
    const alteree = (sig[0] === '0' ? '1' : '0') + sig.slice(1);
    expect(verifierSignatureHubrise(CORPS, alteree, SECRET)).toBe(false);
  });

  it('refuse une signature calculée avec une autre clé', () => {
    expect(verifierSignatureHubrise(CORPS, signer(CORPS, 'autre-secret'), SECRET)).toBe(false);
  });

  it('refuse un en-tête absent ou vide', () => {
    expect(verifierSignatureHubrise(CORPS, undefined, SECRET)).toBe(false);
    expect(verifierSignatureHubrise(CORPS, '', SECRET)).toBe(false);
  });

  it('refuse une longueur différente', () => {
    const sig = signer(CORPS);
    expect(verifierSignatureHubrise(CORPS, sig.slice(0, 62), SECRET)).toBe(false);
    expect(verifierSignatureHubrise(CORPS, `${sig}00`, SECRET)).toBe(false);
  });

  it('refuse un hexadécimal invalide ou un autre encodage', () => {
    expect(verifierSignatureHubrise(CORPS, 'z'.repeat(64), SECRET)).toBe(false);
    const base64 = createHmac('sha256', SECRET).update(CORPS).digest('base64');
    expect(verifierSignatureHubrise(CORPS, base64, SECRET)).toBe(false);
    expect(verifierSignatureHubrise(CORPS, `sha256=${signer(CORPS)}`, SECRET)).toBe(false);
  });

  it('refuse tout quand le secret est vide (jamais « valide par défaut »)', () => {
    expect(verifierSignatureHubrise(CORPS, signer(CORPS, ''), '')).toBe(false);
  });

  it('refuse sans corps brut', () => {
    expect(verifierSignatureHubrise(undefined, signer(CORPS), SECRET)).toBe(false);
  });
});
