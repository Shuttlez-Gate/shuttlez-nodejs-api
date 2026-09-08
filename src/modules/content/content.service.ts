import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma/prisma.service';
import { NotFoundException } from '../../common/exceptions/app.exception';

@Injectable()
export class ContentService {
  constructor(private readonly prisma: PrismaService) {}

  async getFaq() {
    const items = await this.prisma.faqItem.findMany({
      where: { isActive: true, isDeleted: false },
      orderBy: { order: 'asc' },
    });
    return items.map((x) => ({
      id: x.id,
      question: x.question,
      answer: x.answer,
      order: x.order,
    }));
  }

  async getLegal(slug: string, language?: string | null) {
    const normalized = slug.trim().toLowerCase();
    const doc = await this.prisma.legalDocument.findFirst({
      where: { slug: normalized, isActive: true, isDeleted: false },
    });
    if (!doc) {
      throw new NotFoundException('المستند غير موجود');
    }
    const titleAr = doc.title ?? '';
    const contentAr = doc.content ?? '';
    const titleEn = doc.titleEn && doc.titleEn.trim() ? doc.titleEn : titleAr;
    const contentEn =
      doc.contentEn && doc.contentEn.trim() ? doc.contentEn : contentAr;
    const english = isEnglish(language);
    return {
      slug: doc.slug,
      title: english ? titleEn : titleAr,
      content: english ? contentEn : contentAr,
      titleAr,
      contentAr,
      titleEn,
      contentEn,
    };
  }
}

export function isEnglish(language?: string | null): boolean {
  if (!language || !language.trim()) {
    return false;
  }
  const code = language.split(/[,;]/)[0].trim().toLowerCase();
  return code.startsWith('en');
}
