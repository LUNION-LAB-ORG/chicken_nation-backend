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
import { MenuEvent } from 'src/modules/menu/events/menu.event';

@Module({
  imports: [],
  controllers: [CategoryController, DishController, DishRestaurantController, DishSupplementController, SupplementController],
  providers: [CategoryService, DishService, DishRestaurantService, DishSupplementService, SupplementService, MenuEvent],
  exports: [DishRestaurantService],
})
export class MenuModule { }
