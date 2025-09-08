import { Test, TestingModule } from '@nestjs/testing';
import { TicketMessageService } from './message.service';

describe('MessageService', () => {
  let service: TicketMessageService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [TicketMessageService],
    }).compile();

    service = module.get<TicketMessageService>(TicketMessageService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
