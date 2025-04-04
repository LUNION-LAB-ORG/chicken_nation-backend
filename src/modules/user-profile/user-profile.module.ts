import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

// Entités
import { User } from '../auth/entities/user.entity';
import { UserAddress } from './entities/user-address.entity';
import { NotificationSetting } from './entities/notification-setting.entity';
import { UserFavorite } from './entities/user-favorite.entity';

// Services
import { UserProfileService } from './services/user-profile.service';
import { UserAddressesService } from './services/user-addresses.service';
import { NotificationSettingsService } from './services/notification-settings.service';
import { UserFavoritesService } from './services/user-favorites.service';

// Contrôleurs
import { UserProfileController } from './controllers/user-profile.controller';
import { UserAddressesController } from './controllers/user-addresses.controller';
import { NotificationSettingsController } from './controllers/notification-settings.controller';
import { UserFavoritesController } from './controllers/user-favorites.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      UserAddress,
      NotificationSetting,
      UserFavorite
    ])
  ],
  controllers: [
    UserProfileController,
    UserAddressesController,
    NotificationSettingsController,
    UserFavoritesController
  ],
  providers: [
    UserProfileService,
    UserAddressesService,
    NotificationSettingsService,
    UserFavoritesService
  ],
  exports: [
    UserProfileService,
    UserAddressesService,
    NotificationSettingsService,
    UserFavoritesService
  ]
})
export class UserProfileModule {}
