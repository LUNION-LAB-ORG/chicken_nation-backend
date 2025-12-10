import { Test, TestingModule } from '@nestjs/testing';
import { OrderService } from './order.service';
import { PrismaService } from 'src/database/services/prisma.service';
import { prismaMock } from '../../../../test/prisma-mock/prisma.mock';
import { CreateOrderDto } from '../dto/create-order.dto';
import { OrderType } from "src/modules/order/enums/order-type.enum";
import { OrderHelper } from '../helpers/order.helper';
import { GenerateDataService } from 'src/common/services/generate-data.service';
import { OrderEvent } from '../events/order.event';
import { OrderWebSocketService } from '../websockets/order-websocket.service';
import { TurboService } from 'src/turbo/services/turbo.service';
import { orderHelperMock } from '../../../../test/data-mock/order.helper.mock';
import { generateDataServiceMock } from '../../../../test/data-mock/generate.data.service.mock';
import { orderEventMock } from '../../../../test/data-mock/order.event.mock';
import { websocketMock } from '../../../../test/data-mock/order.web.socket.service';
import { turboServiceMock } from '../../../../test/data-mock/turbo.service.mock';


// ===========================
//           MOCKS
// ===========================

export enum OrderTypeMock {
  DELIVERY = 'DELIVERY',
  PICKUP = 'PICKUP',
}

;







// ===========================
//         TEST SUITE
// ===========================

describe('OrderService - create()', () => {
  let service: OrderService;

  beforeEach(async () => {

    // Mock transaction
    prismaMock.$transaction = jest.fn().mockImplementation(async (fn) => fn(prismaMock));

    // Mock prisma.order.create
    prismaMock.order.create = jest.fn().mockResolvedValue({
      id: "order-1",
      reference: "REF123",
      amount: 23,
      status: "PENDING",
      order_items: [],
      restaurant: { id: "uuid-restaurant" },
      customer: { id: "uuid-customer" },
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrderService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: OrderHelper, useValue: orderHelperMock },
        { provide: GenerateDataService, useValue: generateDataServiceMock },
        { provide: OrderEvent, useValue: orderEventMock },
        { provide: OrderWebSocketService, useValue: websocketMock },
        { provide: TurboService, useValue: turboServiceMock },
      ],
    }).compile();

    service = module.get<OrderService>(OrderService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should create an order', async () => {

    const req: any = {
      user: {
        id: 'uuid-customer',
        first_name: "John"
      }
    };

    const dto: CreateOrderDto = {
      type: OrderType.DELIVERY,
      address: JSON.stringify({
        title: "Home",
        address: "Cocody Angré",
        latitude: 5.356,
        longitude: -3.988,
      }),
      code_promo: undefined,
      date: "15/12/2025",
      time: "10:00",
      items: [],
      paiement_id: undefined,
      customer_id: undefined,
      restaurant_id: undefined,
      promotion_id: undefined,
      points: 0,
    };

    const result = await service.create(req, dto);

    // ===========================
    //       ASSERTIONS
    // ===========================
    
    expect(orderHelperMock.resolveCustomerData).toHaveBeenCalled();
    expect(orderHelperMock.getClosestRestaurant).toHaveBeenCalled();
    expect(orderHelperMock.calculateOrderDetails).toHaveBeenCalled();

    expect(prismaMock.$transaction).toHaveBeenCalled();
    expect(prismaMock.order.create).toHaveBeenCalled();

    expect(result.id).toBeDefined();
    expect(result.reference).toBe('REF123');
  });
  
  
});
