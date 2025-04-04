import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between } from 'typeorm';
import { UserActivity, ActivityType } from '../entities/user-activity.entity';
import { TrackActivityDto } from '../dto/track-activity.dto';
import { Request } from 'express';

@Injectable()
export class UserActivityService {
  constructor(
    @InjectRepository(UserActivity)
    private userActivityRepository: Repository<UserActivity>,
  ) {}

  async trackActivity(userId: string, activityDto: TrackActivityDto, req: Request): Promise<UserActivity> {
    const userActivity = this.userActivityRepository.create({
      userId,
      activityType: activityDto.activityType,
      resourceId: activityDto.resourceId,
      metadata: activityDto.metadata,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    return this.userActivityRepository.save(userActivity);
  }

  async getUserActivities(userId: string, startDate?: Date, endDate?: Date): Promise<UserActivity[]> {
    const query = this.userActivityRepository.createQueryBuilder('activity')
      .where('activity.userId = :userId', { userId });

    if (startDate && endDate) {
      query.andWhere('activity.createdAt BETWEEN :startDate AND :endDate', {
        startDate,
        endDate,
      });
    }

    return query.orderBy('activity.createdAt', 'DESC').getMany();
  }

  async getActivityCounts(startDate: Date, endDate: Date): Promise<Record<ActivityType, number>> {
    const activities = await this.userActivityRepository
      .createQueryBuilder('activity')
      .select('activity.activityType', 'type')
      .addSelect('COUNT(activity.id)', 'count')
      .where('activity.createdAt BETWEEN :startDate AND :endDate', {
        startDate,
        endDate,
      })
      .groupBy('activity.activityType')
      .getRawMany();

    const result = {} as Record<ActivityType, number>;
    
    // Initialize all activity types with 0
    Object.values(ActivityType).forEach(type => {
      result[type] = 0;
    });

    // Update counts for activity types that have data
    activities.forEach(activity => {
      result[activity.type] = parseInt(activity.count, 10);
    });

    return result;
  }

  async getProductViewCounts(startDate: Date, endDate: Date, limit = 10): Promise<{ productId: string; count: number }[]> {
    return this.userActivityRepository
      .createQueryBuilder('activity')
      .select('activity.resourceId', 'productId')
      .addSelect('COUNT(activity.id)', 'count')
      .where('activity.activityType = :activityType', { activityType: ActivityType.VIEW_PRODUCT })
      .andWhere('activity.createdAt BETWEEN :startDate AND :endDate', {
        startDate,
        endDate,
      })
      .groupBy('activity.resourceId')
      .orderBy('count', 'DESC')
      .limit(limit)
      .getRawMany();
  }

  async getSearchTerms(startDate: Date, endDate: Date, limit = 10): Promise<{ term: string; count: number }[]> {
    const searchActivities = await this.userActivityRepository
      .createQueryBuilder('activity')
      .select('activity.metadata')
      .where('activity.activityType = :activityType', { activityType: ActivityType.SEARCH })
      .andWhere('activity.createdAt BETWEEN :startDate AND :endDate', {
        startDate,
        endDate,
      })
      .getRawMany();

    // Extract search terms and count occurrences
    const termCounts = {};
    searchActivities.forEach(activity => {
      const metadata = activity.metadata;
      if (metadata && metadata.searchQuery) {
        const term = metadata.searchQuery.toLowerCase();
        termCounts[term] = (termCounts[term] || 0) + 1;
      }
    });

    // Convert to array and sort
    const sortedTerms = Object.entries(termCounts)
      .map(([term, count]) => ({ term, count: count as number }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);

    return sortedTerms;
  }
}
