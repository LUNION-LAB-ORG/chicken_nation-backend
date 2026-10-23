/**
 * Câblage du module Maps : MapsService reçoit son compteur d'appels, qui
 * reçoit sa connexion Redis et les réglages (module global). Sans ce test,
 * un fournisseur oublié ne se verrait qu'au démarrage du serveur.
 */
import { CacheModule } from '@nestjs/cache-manager';
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { SettingsService } from 'src/modules/settings/settings.service';

import { CompteurAppelsGoogleService } from './compteur-appels-google.service';
import { MapsModule } from './maps.module';
import { MapsService } from './maps.service';
import { REDIS_COMPTEUR_GOOGLE } from './redis-compteur-google.provider';

@Global()
@Module({
  providers: [{ provide: SettingsService, useValue: { get: jest.fn(async () => null) } }],
  exports: [SettingsService],
})
class ReglagesSimulesModule {}

describe('MapsModule', () => {
  it('fournit MapsService avec son compteur d’appels Google', async () => {
    const module = await Test.createTestingModule({
      imports: [CacheModule.register({ isGlobal: true }), ReglagesSimulesModule, MapsModule],
    })
      .overrideProvider(REDIS_COMPTEUR_GOOGLE)
      .useValue({ multi: jest.fn(), mget: jest.fn(async () => []), quit: jest.fn(async () => 'OK') })
      .compile();

    expect(module.get(MapsService)).toBeInstanceOf(MapsService);
    expect(module.get(CompteurAppelsGoogleService)).toBeInstanceOf(CompteurAppelsGoogleService);
    await module.close();
  });
});
