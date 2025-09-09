import { Test, TestingModule } from '@nestjs/testing';
import { CategoriesTicketService } from './categories-ticket.service';

describe('CategoriesTicketService', () => {
  let service: CategoriesTicketService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [CategoriesTicketService],
    }).compile();

    service = module.get<CategoriesTicketService>(CategoriesTicketService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
