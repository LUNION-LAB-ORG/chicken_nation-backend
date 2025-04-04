import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Category } from './entities/category.entity';
import { MenuItem } from './entities/menuItem.entity';
import { MenuItemOption } from './entities/menuItemOption.entity';
import { CategoryService } from './services/category.service';
import { MenuItemService } from './services/menuItem.service';
import { CategoryController } from './controllers/category.controller';
import { MenuItemController } from './controllers/menuItem.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Category, MenuItem, MenuItemOption]),
    AuthModule,
  ],
  controllers: [CategoryController, MenuItemController],
  providers: [CategoryService, MenuItemService],
  exports: [CategoryService, MenuItemService],
})
export class MenuModule {}