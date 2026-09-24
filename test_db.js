const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
    const tables = await prisma.$queryRaw`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN (
            'ConversionCampaign',
            'CampaignAgent',
            'ProspectLossReason',
            'ProspectCall'
          )
        ORDER BY table_name;
    `;
    console.log("Tables:", tables);

    const cols = await prisma.$queryRaw`
        SELECT column_name, data_type, udt_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'Prospect'
          AND column_name IN ('campaign_id', 'loss_reason_id')
        ORDER BY column_name;
    `;
    console.log("Columns:", cols);

    const types = await prisma.$queryRaw`
        SELECT typname
        FROM pg_type
        WHERE typname IN ('CampaignStatus', 'ProspectCallResult', 'CallResult')
        ORDER BY typname;
    `;
    console.log("Types:", types);
}
main().finally(() => prisma.$disconnect());
