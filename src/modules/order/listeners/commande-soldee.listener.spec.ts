import { ConflictException } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import { CommandeSoldeeListener } from './commande-soldee.listener';

describe('CommandeSoldeeListener : commande en attente soldée à la main (14/11)', () => {
  const evenement = { orderId: 'o-1', etaitBrouillon: true, userId: 'u-1', role: 'ADMIN' };

  it('accepte la commande par le chemin ordinaire, conditionné à l’attente, en disant qu’elle était un brouillon', async () => {
    const orderService = { updateStatus: jest.fn().mockResolvedValue({}) };
    const listener = new CommandeSoldeeListener(orderService as never);

    await expect(listener.confirmer(evenement)).resolves.toBe(true);
    expect(orderService.updateStatus).toHaveBeenCalledWith(
      'o-1',
      OrderStatus.ACCEPTED,
      { userId: 'u-1', role: 'ADMIN' },
      { conditionEcriture: { status: OrderStatus.PENDING }, etaitBrouillon: true },
    );
  });

  it('acceptée entre-temps, ou refusée : ne lève jamais, rend faux', async () => {
    const orderService = {
      updateStatus: jest.fn().mockRejectedValue(new ConflictException('Cette commande vient de changer : actualisez la liste.')),
    };
    const listener = new CommandeSoldeeListener(orderService as never);

    await expect(listener.confirmer(evenement)).resolves.toBe(false);
  });
});
