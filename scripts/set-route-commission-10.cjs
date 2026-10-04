const { randomUUID } = require('crypto');
const { PrismaClient, Prisma } = require('@prisma/client');

const prisma = new PrismaClient();
const TEN = new Prisma.Decimal(10);

async function main() {
  const now = new Date();
  const updated = await prisma.commissionRule.updateMany({
    where: { isDeleted: false },
    data: {
      name: 'عمولة المسارات 10%',
      platformCommissionPercent: TEN,
      isActive: true,
      updatedAt: now,
    },
  });

  const active = await prisma.commissionRule.count({
    where: { isDeleted: false, isActive: true },
  });
  if (active === 0) {
    await prisma.commissionRule.create({
      data: {
        id: randomUUID(),
        name: 'عمولة المسارات 10%',
        platformCommissionPercent: TEN,
        effectiveFrom: now,
        effectiveTo: null,
        isActive: true,
        isDeleted: false,
        createdAt: now,
        updatedAt: now,
      },
    });
  }

  const pricing = await prisma.pricingRule.updateMany({
    where: { isDeleted: false },
    data: {
      launchCommissionPercent: TEN,
      permanentCommissionPercent: TEN,
      updatedAt: now,
    },
  });

  const rules = await prisma.commissionRule.findMany({
    where: { isDeleted: false },
    select: {
      name: true,
      platformCommissionPercent: true,
      isActive: true,
      effectiveTo: true,
    },
  });

  console.log(
    JSON.stringify(
      {
        commissionRulesUpdated: updated.count,
        pricingRulesUpdated: pricing.count,
        commissionRules: rules.map((rule) => ({
          name: rule.name,
          percent: Number(rule.platformCommissionPercent),
          isActive: rule.isActive,
          effectiveTo: rule.effectiveTo,
        })),
      },
      null,
      2,
    ),
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
