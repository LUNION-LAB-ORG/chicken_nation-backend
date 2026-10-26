import { Module, Global } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JsonWebTokenModule } from 'src/json-web-token/json-web-token.module';
import { AppGateway } from './gateways/app.gateway';
import { MenuRealtimeListener } from './listeners/menu-realtime.listener';
import { RevocationSallesListener } from './listeners/revocation-salles.listener';
import { FinsSocketLivreursService } from './services/fins-socket-livreurs.service';
import { redisFinsSocketProvider } from './services/redis-fins-socket.provider';
@Global()
@Module({
  imports: [ConfigModule, JsonWebTokenModule],
  providers: [
    AppGateway,
    MenuRealtimeListener,
    RevocationSallesListener,
    // Fin du dernier socket de chaque livreur : « Appli fermée » ou « Connexion coupée ».
    redisFinsSocketProvider,
    FinsSocketLivreursService,
  ],
  exports: [
    AppGateway,
    FinsSocketLivreursService,
  ],
})
export class SocketIoModule { }