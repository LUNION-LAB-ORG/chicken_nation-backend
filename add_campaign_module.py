import re

with open('src/app.module.ts', 'r') as f:
    content = f.read()

# Add import
content = re.sub(
    r"import \{ ProspectModule \} from '\./modules/prospect/prospect.module';",
    r"import { ProspectModule } from './modules/prospect/prospect.module';\nimport { CampaignModule } from './modules/campaign/campaign.module';",
    content
)

# Add to imports array
content = re.sub(
    r'ProspectModule,',
    r'ProspectModule,\n    CampaignModule,',
    content
)

with open('src/app.module.ts', 'w') as f:
    f.write(content)
