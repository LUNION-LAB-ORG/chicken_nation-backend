import { Module } from '@nestjs/common';
import { CategoryController } from 'src/modules/menu/controllers/category.controller';
import { DishController } from 'src/modules/menu/controllers/dish.controller';
import { SupplementController } from 'src/modules/menu/controllers/supplement.controller';
import { CategoryService } from 'src/modules/menu/services/category.service';
import { DishService } from 'src/modules/menu/services/dish.service';
import { SupplementService } from 'src/modules/menu/services/supplement.service';
import { CategoryListenerService } from 'src/modules/menu/listeners/category-listener.service';
import { DishListenerService } from 'src/modules/menu/listeners/dish-listener.service';
import { DishEvent } from './events/dish.event';
import { CategoryEvent } from './events/category.event';
import { SupplementEvent } from './events/supplement.event';
import { CategoryNotificationsTemplate } from './templates/category-notifications.template';
import { DishNotificationsTemplate } from './templates/dish-notifications.template';

@Module({
  imports: [],
  controllers: [CategoryController, DishController, SupplementController],
  providers: [
    CategoryService,
    DishService,
    SupplementService,
    DishEvent,
    CategoryEvent,
    SupplementEvent,
    CategoryListenerService,
    DishListenerService,
    CategoryNotificationsTemplate,
    DishNotificationsTemplate,
  ],
  exports: [DishService],
})
export class MenuModule { }
