
import { join } from 'path';

export const statisticsIcons = {
    revenue: {
        url: join(process.env.BASE_URL ?? "", 'uploads', 'assets/statistics/icons/money-bag.svg'),
        color: "#FFC107"
    },
    menusSold: {
        url: join(process.env.BASE_URL ?? "", 'uploads', 'assets/statistics/icons/food.svg'),
        color: "#FFC107"
    },
    totalOrders: {
        url: join(process.env.BASE_URL ?? "", 'uploads', 'assets/statistics/icons/shopping-cart.svg'),
        color: "#FFC107"
    },
    totalCustomers: {
        url: join(process.env.BASE_URL ?? "", 'uploads', 'assets/statistics/icons/users.svg'),
        color: "#FFC107"
    },
}