import { PrismaClient } from "@prisma/client";

process.env.POSTGRES_PRISMA_URL ||= process.env.DATABASE_URL;
process.env.POSTGRES_PRISMA_URL = normalizeConnectionUrl(process.env.POSTGRES_PRISMA_URL);
process.env.POSTGRES_URL_NON_POOLING = normalizeConnectionUrl(process.env.POSTGRES_URL_NON_POOLING);

const globalForPrisma = global as unknown as { prisma: PrismaClient };

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    log: ["query"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

function normalizeConnectionUrl(value: string | undefined): string | undefined {
  if (!value) return value;
  return value
    .replace(/([?&])channel_binding=[^&]*&?/i, "$1")
    .replace(/[?&]$/, "");
}
