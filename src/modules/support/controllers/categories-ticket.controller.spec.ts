import { Test, TestingModule } from '@nestjs/testing';
import { CategoriesTicketController } from './categories-ticket.controller';

describe('CategoriesTicketController', () => {
  let controller: CategoriesTicketController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [CategoriesTicketController],
    }).compile();

    controller = module.get<CategoriesTicketController>(CategoriesTicketController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
