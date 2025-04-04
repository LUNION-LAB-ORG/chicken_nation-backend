import { DataSource } from 'typeorm';
import { config } from 'dotenv';
import { User } from './modules/auth/entities/user.entity';
import { Role } from './modules/auth/entities/role.entity';
import { Otp } from './modules/auth/entities/otp.entity';
import { Category } from './modules/menu/entities/category.entity';
import { MenuItem } from './modules/menu/entities/menuItem.entity';
import { MenuItemOption } from './modules/menu/entities/menuItemOption.entity'; 

 
config();

export const AppDataSource = new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  entities: [User, Role, Otp, Category, MenuItem, MenuItemOption],
 
  ssl: {
    rejectUnauthorized: false,
  },
});