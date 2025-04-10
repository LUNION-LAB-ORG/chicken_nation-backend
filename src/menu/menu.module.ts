import { Module } from '@nestjs/common';
import { MenuService } from 'src/menu/services/menu.service';
import { MenuController } from 'src/menu/controllers/menu.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Category } from 'src/menu/entities/category.entity';
import { Dish } from 'src/menu/entities/dish.entity';
import { DishRestaurant } from 'src/menu/entities/dish-restaurant.entity';
import { DishSupplement } from 'src/menu/entities/dish-supplement.entity';
import { Supplement } from 'src/menu/entities/supplement.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Category, Dish, DishRestaurant, DishSupplement, Supplement])],
  controllers: [MenuController],
  providers: [MenuService],
})
export class MenuModule { }
