import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiResponse } from '../../common/api-response';
import { CurrentUserService } from '../../common/current-user.service';
import { PrismaService } from '../../database/prisma/prisma.service';

@ApiTags('reviews')
@Controller('api/v1/reviews')
export class RiderReviewsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly currentUser: CurrentUserService,
  ) {}

  @Get('me')
  async mine() {
    const userId = this.currentUser.requireUserId();
    const reviews = await this.prisma.review.findMany({
      where: { userId, isDeleted: false },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const tripIds = [...new Set(reviews.map((review) => review.tripId))];
    const trips = tripIds.length
      ? await this.prisma.trip.findMany({
          where: { id: { in: tripIds } },
          select: { id: true, route: { select: { name: true } } },
        })
      : [];
    const routeByTrip = new Map(trips.map((trip) => [trip.id, trip.route.name]));
    const counts = [1, 2, 3, 4, 5].map(
      (stars) => reviews.filter((review) => review.stars === stars).length,
    );
    const max = Math.max(1, ...counts);
    const total = reviews.length;
    const average = total
      ? reviews.reduce((sum, review) => sum + review.stars, 0) / total
      : 0;
    const five = counts[4];
    return ApiResponse.ok({
      tripsCount: total,
      averageRating: Number(average.toFixed(1)),
      fiveStarPercent: total ? Math.round((five / total) * 100) : 0,
      distribution: [5, 4, 3, 2, 1].map((stars) => ({
        stars,
        ratio: counts[stars - 1] / max,
        count: counts[stars - 1],
      })),
      filters: [],
      reviews: reviews.map((review) => ({
        id: review.id,
        stars: review.stars,
        comment: review.comment ?? '',
        createdAt: review.createdAt,
        routeName: routeByTrip.get(review.tripId) ?? '',
      })),
    });
  }
}
