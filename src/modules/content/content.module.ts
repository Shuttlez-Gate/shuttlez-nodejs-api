import { Module } from '@nestjs/common';
import { ContentController } from './content.controller';
import { ContentService } from './content.service';
import { MediaController } from './media.controller';

@Module({
  controllers: [ContentController, MediaController],
  providers: [ContentService],
  exports: [ContentService],
})
export class ContentModule {}
