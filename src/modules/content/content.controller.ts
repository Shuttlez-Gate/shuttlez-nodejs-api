import { Controller, Get, Headers, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiResponse } from '../../common/api-response';
import { ContentService } from './content.service';

@ApiTags('content')
@Controller('api/v1/content')
export class ContentController {
  constructor(private readonly content: ContentService) {}

  @Get('faq')
  async getFaq() {
    return ApiResponse.ok(await this.content.getFaq());
  }

  @Get('legal/:slug')
  async getLegal(
    @Param('slug') slug: string,
    @Query('lang') lang?: string,
    @Query('language') language?: string,
    @Headers('accept-language') acceptLanguage?: string,
  ) {
    const requested = lang ?? language ?? acceptLanguage;
    return ApiResponse.ok(await this.content.getLegal(slug, requested));
  }
}
