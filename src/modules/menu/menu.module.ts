import { Module } from '@nestjs/common';
import { CategoryController } from 'src/modules/menu/controllers/category.controller';
import { DishController } from 'src/modules/menu/controllers/dish.controller';
import { DishRestaurantController } from 'src/modules/menu/controllers/dish-restaurant.controller';
import { DishSupplementController } from 'src/modules/menu/controllers/dish-supplement.controller';
import { SupplementController } from 'src/modules/menu/controllers/supplement.controller';
import { CategoryService } from 'src/modules/menu/services/category.service';
import { DishService } from 'src/modules/menu/services/dish.service';
import { DishRestaurantService } from 'src/modules/menu/services/dish-restaurant.service';
import { DishSupplementService } from 'src/modules/menu/services/dish-supplement.service';
import { SupplementService } from 'src/modules/menu/services/supplement.service';
import { CategoryListenerService } from 'src/modules/menu/listeners/category-listener.service';
import { DishListenerService } from 'src/modules/menu/listeners/dish-listener.service';
import { DishEvent } from './events/dish.event';
import { CategoryEvent } from './events/category.event';
import { CategoryNotificationsTemplate } from './templates/category-notifications.template';
import { DishNotificationsTemplate } from './templates/dish-notifications.template';
import { CategoryEmailTemplates } from './templates/category-email.template';
import { DishEmailTemplates } from './templates/dish-email.template';

@Module({
  imports: [],
  controllers: [CategoryController, DishController, DishRestaurantController, DishSupplementController, SupplementController],
  providers: [
    CategoryService,
    DishService,
    DishRestaurantService,
    DishSupplementService,
    SupplementService,
    DishEvent,
    CategoryEvent,
    CategoryListenerService,
    DishListenerService,
    CategoryNotificationsTemplate,
    DishNotificationsTemplate,
    CategoryEmailTemplates,
    DishEmailTemplates,
  ],
  exports: [DishRestaurantService],
})
export class MenuModule { }
