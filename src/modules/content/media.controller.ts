import { Controller, Get, Header, Param, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { PrismaService } from '../../database/prisma/prisma.service';
import { readStoredDocument } from '../../common/utils/document-storage';

@ApiTags('media')
@Controller('api/v1/media')
export class MediaController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('driver-documents/:id')
  @Header('Cache-Control', 'public, max-age=86400')
  async driverDocument(@Param('id') id: string, @Res() res: Response) {
    const doc = await this.prisma.driverDocument.findFirst({
      where: { id, isDeleted: false },
    });
    if (!doc) {
      res.status(404).send('المرفق غير موجود');
      return;
    }
    if (doc.storagePath.startsWith('http://') || doc.storagePath.startsWith('https://')) {
      res.redirect(doc.storagePath);
      return;
    }
    const stored = readStoredDocument(doc.storagePath, doc.contentType);
    if (!stored) {
      res.status(404).send('الملف غير متاح');
      return;
    }
    res.setHeader('Content-Type', stored.contentType);
    res.setHeader(
      'Content-Disposition',
      `inline; filename*=UTF-8''${encodeURIComponent(doc.fileName || 'document')}`,
    );
    res.send(stored.buffer);
  }
}
