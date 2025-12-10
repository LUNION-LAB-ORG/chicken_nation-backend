import { Injectable } from "@nestjs/common";

@Injectable()
export class OrderHelper {
  async getClosestRestaurant(data: { restaurant_id?: string; address: string }) {
    return { id: "resto-123", distance: 2.5 };
  }

  async getDishesWithDetails(ids: string[]) {
    return ids.map(id => ({
      id,
      name: "Dish " + id,
      is_available: true,
      price: 1000,
    }));
  }
}
