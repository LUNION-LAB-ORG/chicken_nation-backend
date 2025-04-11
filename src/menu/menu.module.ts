import { Module } from '@nestjs/common';
import { MenuService } from 'src/menu/services/menu.service';
import { MenuController } from 'src/menu/controllers/menu.controller';
import { CategoryController } from 'src/menu/controllers/category.controller';
import { DishController } from 'src/menu/controllers/dish.controller';
import { DishRestaurantController } from 'src/menu/controllers/dish-restaurant.controller';
import { DishSupplementController } from 'src/menu/controllers/dish-supplement.controller';
import { SupplementController } from 'src/menu/controllers/supplement.controller';
import { CategoryService } from 'src/menu/services/category.service';
import { DishService } from 'src/menu/services/dish.service';
import { DishRestaurantService } from 'src/menu/services/dish-restaurant.service';
import { DishSupplementService } from 'src/menu/services/dish-supplement.service';
import { SupplementService } from 'src/menu/services/supplement.service';

@Module({
  imports: [],
  controllers: [MenuController, CategoryController, DishController, DishRestaurantController, DishSupplementController, SupplementController],
  providers: [MenuService, CategoryService, DishService, DishRestaurantService, DishSupplementService, SupplementService],
})
export class MenuModule { }
