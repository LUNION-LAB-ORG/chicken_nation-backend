import { HttpException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/database/services/prisma.service';
import { CreateRetentionCallbackDto } from './dto/create-retention-callback.dto';
import { UpdateRetentionCallbackDto } from './dto/update-retention-callback.dto';
import { QueryRetentionCallbackDto } from './dto/query-retention-callback.dto';
import { EntityStatus, RetentionCallbackStatus } from '@prisma/client';

const callbackInclude = {
  customer: { select: { id: true, first_name: true, last_name: true, phone: true, email: true, image: true } },
  caller: { select: { id: true, fullname: true, email: true, image: true } },
  reason: { select: { id: true, name: true } },
  followups: {
    where: { entity_status: { not: EntityStatus.DELETED } },
    orderBy: { called_at: 'desc' as const },
    include: {
      caller: { select: { id: true, fullname: true } },
      reason: { select: { id: true, name: true } },
    },
  },
};

@Injectable()
export class RetentionCallbackService {
  private readonly logger = new Logger(RetentionCallbackService.name);

  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateRetentionCallbackDto, callerUserId: string) {
    const customer = await this.prisma.customer.findUnique({ where: { id: dto.customer_id } });
    if (!customer) throw new HttpException('Client non trouvé', 404);

    return this.prisma.retentionCallback.create({
      data: {
        customer_id: dto.customer_id,
        caller_user_id: callerUserId,
        reason_id: dto.reason_id || undefined,
        status: dto.status || RetentionCallbackStatus.CALLED,
        notes: dto.notes,
        next_callback_at: dto.next_callback_at ? new Date(dto.next_callback_at) : undefined,
        parent_id: dto.parent_id || undefined,
      },
      include: callbackInclude,
    });
  }

  async findAll(query: QueryRetentionCallbackDto) {
    const { page = 1, limit = 20, status, reason_id, caller_user_id, customer_id, dateFrom, dateTo, search } = query;

    const where: any = { entity_status: { not: EntityStatus.DELETED } };

    if (status?.length) where.status = { in: status };
    if (reason_id?.length) where.reason_id = { in: reason_id };
    if (caller_user_id?.length) where.caller_user_id = { in: caller_user_id };
    if (customer_id) where.customer_id = customer_id;
    if (dateFrom || dateTo) {
      where.called_at = {};
      if (dateFrom) where.called_at.gte = new Date(dateFrom);
      if (dateTo) where.called_at.lte = new Date(dateTo);
    }
    if (search) {
      where.OR = [
        { notes: { contains: search, mode: 'insensitive' } },
        { customer: { first_name: { contains: search, mode: 'insensitive' } } },
        { customer: { last_name: { contains: search, mode: 'insensitive' } } },
        { customer: { phone: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const [data, total] = await Promise.all([
      this.prisma.retentionCallback.findMany({
        where,
        include: callbackInclude,
        orderBy: { called_at: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.retentionCallback.count({ where }),
    ]);

    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async findDue() {
    const now = new Date();
    const endOfDay = new Date(now);
    endOfDay.setHours(23, 59, 59, 999);
    return this.prisma.retentionCallback.findMany({
      where: {
        entity_status: { not: EntityStatus.DELETED },
        status: RetentionCallbackStatus.CALLBACK_SCHEDULED,
        next_callback_at: { lte: endOfDay },
      },
      include: callbackInclude,
      orderBy: { next_callback_at: 'asc' },
    });
  }

  async getCalledCustomerIds() {
    const results = await this.prisma.retentionCallback.findMany({
      where: { entity_status: { not: EntityStatus.DELETED } },
      select: { customer_id: true, status: true },
    });
    const customerMap = new Map<string, string>();
    results.forEach((r) => {
      // Keep the most relevant status per customer
      customerMap.set(r.customer_id, r.status);
    });
    return {
      calledCustomerIds: [...customerMap.keys()],
      customerStatuses: Object.fromEntries(customerMap),
    };
  }

  async findByCustomer(customerId: string) {
    return this.prisma.retentionCallback.findMany({
      where: {
        customer_id: customerId,
        entity_status: { not: EntityStatus.DELETED },
      },
      include: callbackInclude,
      orderBy: { called_at: 'desc' },
    });
  }

  async findOne(id: string) {
    const callback = await this.prisma.retentionCallback.findUnique({
      where: { id },
      include: callbackInclude,
    });
    if (!callback || callback.entity_status === EntityStatus.DELETED) {
      throw new HttpException('Appel non trouvé', 404);
    }
    return callback;
  }

  async update(id: string, dto: UpdateRetentionCallbackDto) {
    await this.findOne(id);
    const data: any = { ...dto };
    if (dto.next_callback_at) data.next_callback_at = new Date(dto.next_callback_at);
    if (dto.status === RetentionCallbackStatus.RECONQUERED) {
      data.reconquered_at = new Date();
    }
    return this.prisma.retentionCallback.update({
      where: { id },
      data,
      include: callbackInclude,
    });
  }

  async remove(id: string) {
    await this.findOne(id);
    return this.prisma.retentionCallback.update({
      where: { id },
      data: { entity_status: EntityStatus.DELETED },
    });
  }

  // === STATS ===

  private buildStatsWhere(dateFrom?: string, dateTo?: string) {
    const where: any = { entity_status: { not: EntityStatus.DELETED } };
    if (dateFrom || dateTo) {
      where.called_at = {};
      if (dateFrom) where.called_at.gte = new Date(dateFrom);
      if (dateTo) where.called_at.lte = new Date(dateTo);
    }
    return where;
  }

  async getOverview(dateFrom?: string, dateTo?: string) {
    const baseWhere = this.buildStatsWhere(dateFrom, dateTo);

    const [total, byStatus, reconquered] = await Promise.all([
      this.prisma.retentionCallback.count({ where: baseWhere }),
      this.prisma.retentionCallback.groupBy({
        by: ['status'],
        where: baseWhere,
        _count: true,
      }),
      this.prisma.retentionCallback.count({
        where: { ...baseWhere, status: RetentionCallbackStatus.RECONQUERED },
      }),
    ]);

    const statusMap: Record<string, number> = {};
    byStatus.forEach((s) => (statusMap[s.status] = s._count));

    return {
      total,
      called: statusMap[RetentionCallbackStatus.CALLED] || 0,
      noAnswer: statusMap[RetentionCallbackStatus.NO_ANSWER] || 0,
      scheduled: statusMap[RetentionCallbackStatus.CALLBACK_SCHEDULED] || 0,
      reconquered: statusMap[RetentionCallbackStatus.RECONQUERED] || 0,
      lost: statusMap[RetentionCallbackStatus.LOST] || 0,
      reconquestRate: total > 0 ? Math.round((reconquered / total) * 100) : 0,
    };
  }

  async getByReason(dateFrom?: string, dateTo?: string) {
    const baseWhere = this.buildStatsWhere(dateFrom, dateTo);
    const result = await this.prisma.retentionCallback.groupBy({
      by: ['reason_id'],
      where: { ...baseWhere, reason_id: { not: null } },
      _count: true,
    });

    const reasonIds = result.map((r) => r.reason_id).filter(Boolean) as string[];
    const reasons = await this.prisma.retentionCallbackReason.findMany({
      where: { id: { in: reasonIds } },
      select: { id: true, name: true },
    });
    const reasonMap = Object.fromEntries(reasons.map((r) => [r.id, r.name]));

    return result.map((r) => ({
      reasonId: r.reason_id,
      reasonName: reasonMap[r.reason_id!] || 'Inconnu',
      count: r._count,
    }));
  }

  async getAgentPerformance(dateFrom?: string, dateTo?: string) {
    const baseWhere = this.buildStatsWhere(dateFrom, dateTo);

    const grouped = await this.prisma.retentionCallback.groupBy({
      by: ['caller_user_id', 'status'],
      where: baseWhere,
      _count: true,
    });

    const agentMap = new Map<string, { total: number; reconquered: number }>();
    grouped.forEach((g) => {
      const current = agentMap.get(g.caller_user_id) || { total: 0, reconquered: 0 };
      current.total += g._count;
      if (g.status === RetentionCallbackStatus.RECONQUERED) current.reconquered += g._count;
      agentMap.set(g.caller_user_id, current);
    });

    const userIds = [...agentMap.keys()];
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, fullname: true, image: true },
    });
    const userMap = Object.fromEntries(users.map((u) => [u.id, u]));

    return userIds.map((id) => {
      const stats = agentMap.get(id)!;
      const user = userMap[id];
      return {
        userId: id,
        fullname: user?.fullname || 'Inconnu',
        image: user?.image || null,
        totalCalls: stats.total,
        reconquered: stats.reconquered,
        reconquestRate: stats.total > 0 ? Math.round((stats.reconquered / stats.total) * 100) : 0,
      };
    });
  }

  async getFunnel(dateFrom?: string, dateTo?: string) {
    const baseWhere = this.buildStatsWhere(dateFrom, dateTo);

    const [called, scheduled, reconquered, lost] = await Promise.all([
      this.prisma.retentionCallback.count({ where: baseWhere }),
      this.prisma.retentionCallback.count({
        where: { ...baseWhere, status: RetentionCallbackStatus.CALLBACK_SCHEDULED },
      }),
      this.prisma.retentionCallback.count({
        where: { ...baseWhere, status: RetentionCallbackStatus.RECONQUERED },
      }),
      this.prisma.retentionCallback.count({
        where: { ...baseWhere, status: RetentionCallbackStatus.LOST },
      }),
    ]);

    return { called, scheduled, reconquered, lost };
  }

  async getTrend(days = 30, dateFrom?: string, dateTo?: string) {
    const baseWhere = this.buildStatsWhere(dateFrom, dateTo);
    if (!baseWhere.called_at) {
      const since = new Date();
      since.setDate(since.getDate() - days);
      baseWhere.called_at = { gte: since };
    }

    const callbacks = await this.prisma.retentionCallback.findMany({
      where: baseWhere,
      select: { called_at: true, status: true },
      orderBy: { called_at: 'asc' },
    });

    const dailyMap = new Map<string, { total: number; reconquered: number }>();
    callbacks.forEach((cb) => {
      const day = cb.called_at.toISOString().split('T')[0];
      const current = dailyMap.get(day) || { total: 0, reconquered: 0 };
      current.total++;
      if (cb.status === RetentionCallbackStatus.RECONQUERED) current.reconquered++;
      dailyMap.set(day, current);
    });

    return [...dailyMap.entries()].map(([date, stats]) => ({
      date,
      total: stats.total,
      reconquered: stats.reconquered,
    }));
  }

  // === AUTO RECONQUEST CHECK ===

  async checkAutoReconquest() {
    const pendingCallbacks = await this.prisma.retentionCallback.findMany({
      where: {
        entity_status: { not: EntityStatus.DELETED },
        status: { in: [RetentionCallbackStatus.CALLED, RetentionCallbackStatus.CALLBACK_SCHEDULED] },
      },
      select: { id: true, customer_id: true, called_at: true },
    });

    if (!pendingCallbacks.length) return { checked: 0, reconquered: 0 };

    let reconqueredCount = 0;

    for (const cb of pendingCallbacks) {
      const newOrder = await this.prisma.order.findFirst({
        where: {
          customer_id: cb.customer_id,
          status: 'COMPLETED',
          paied: true,
          created_at: { gt: cb.called_at },
        },
      });

      if (newOrder) {
        await this.prisma.retentionCallback.update({
          where: { id: cb.id },
          data: {
            status: RetentionCallbackStatus.RECONQUERED,
            reconquered_at: new Date(),
          },
        });
        reconqueredCount++;
        this.logger.log(`Client ${cb.customer_id} reconquis après appel ${cb.id}`);
      }
    }

    return { checked: pendingCallbacks.length, reconquered: reconqueredCount };
  }
}
