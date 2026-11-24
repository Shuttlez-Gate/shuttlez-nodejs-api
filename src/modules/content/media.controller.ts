import { Controller, Get, Param, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUserService } from '../../common/current-user.service';
import { UserType } from '../../common/enums';
import { PrismaService } from '../../database/prisma/prisma.service';
import { readStoredDocument } from '../../common/utils/document-storage';

@ApiTags('media')
@Controller('api/v1/media')
export class MediaController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly currentUser: CurrentUserService,
  ) {}

  @Get('driver-documents/:id')
  async driverDocument(@Param('id') id: string, @Res() res: Response) {
    setPrivateNoStoreHeaders(res);
    const userId = this.currentUser.requireUserId('Authentication is required');
    if (!isUuid(id)) return res.status(404).send('Document not found');
    const caller = await this.prisma.user.findFirst({
      where: { id: userId, isDeleted: false },
      select: { id: true, userType: true, isActive: true },
    });
    if (!caller?.isActive) {
      return res.status(404).send('Document not found');
    }

    const doc = await this.prisma.driverDocument.findFirst({
      where: { id, isDeleted: false },
      include: {
        driver: {
          select: {
            userId: true,
            isDeleted: true,
          },
        },
      },
    });
    const isAdmin = caller.userType === UserType.Admin;
    const isOwner = caller.userType === UserType.Driver &&
      doc?.driver?.isDeleted === false && doc.driver.userId === caller.id;
    if (!doc || (!isAdmin && !isOwner)) {
      return res.status(404).send('Document not found');
    }
    const stored = readStoredDocument(doc.storagePath, doc.contentType);
    if (!stored) {
      return res.status(404).send('Document not found');
    }
    const contentType = stored.contentType.split(';', 1)[0].trim().toLowerCase();
    const inlineSafe = new Set([
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
      'image/bmp',
      'application/pdf',
    ]).has(contentType);
    res.setHeader('Content-Type', inlineSafe ? contentType : 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Disposition',
      `${inlineSafe ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(doc.fileName || 'document')}`,
    );
    return res.send(stored.buffer);
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function setPrivateNoStoreHeaders(response: Response): void {
  response.setHeader('Cache-Control', 'private, no-store, max-age=0');
  response.setHeader('Pragma', 'no-cache');
  response.setHeader('Expires', '0');
  response.setHeader('Surrogate-Control', 'no-store');
  response.setHeader('Vary', 'Authorization');
}
