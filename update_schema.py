import re

with open('prisma/schema.prisma', 'r') as f:
    content = f.read()

# 1. Add APP_ORGANIC to ProspectPlatform
content = re.sub(
    r'(enum ProspectPlatform \{\s*GLOVO\s*YANGO\s*)(\})',
    r'\1  APP_ORGANIC\n\2',
    content
)

# 2. Add fields to Prospect
prospect_fields = """
  // Assignation Campagne & Agent (Module 1 & 3)
  campaign_id     String?            @db.Uuid
  campaign        ConversionCampaign? @relation(fields: [campaign_id], references: [id])
  
  assigned_to_id  String?            @db.Uuid
  assigned_agent  User?              @relation("ProspectAssignedAgent", fields: [assigned_to_id], references: [id])
  
  // Raison codifiée de non-commande
  loss_reason_id  String?            @db.Uuid 
  loss_reason     ProspectLossReason? @relation(fields: [loss_reason_id], references: [id])
"""
content = re.sub(
    r'(first_order_amount Float\?\s*calls    ProspectCall\[\])',
    prospect_fields + r'\1',
    content
)

# 3. Add relations to User
user_relations = """  campaigns_led       ConversionCampaign[] @relation("CampaignLead")
  campaign_agents     CampaignAgent[]      @relation("CampaignAgents")
  prospects_assigned  Prospect[]           @relation("ProspectAssignedAgent")
"""
content = re.sub(
    r'(prospect_calls      ProspectCall\[\]      @relation\("ProspectCallAgent"\))',
    r'\1\n' + user_relations,
    content
)

# 4. Add new models at the end of the file
new_models = """
// ============================================================
// MODULE 3 — CAMPAGNES DE CONVERSION
// ============================================================

enum CampaignStatus {
  PLANIFIED
  ACTIVE
  COMPLETED
  SUSPENDED
}

model ConversionCampaign {
  id              String           @id @default(uuid()) @db.Uuid
  name            String           @db.VarChar(255)
  description     String?          @db.Text
  start_date      DateTime         @db.Timestamp(6)
  end_date        DateTime?        @db.Timestamp(6)
  status          CampaignStatus   @default(PLANIFIED)
  
  // Objectifs
  target_conversion_rate Float?
  target_contacts_count  Int?
  
  // Rôles
  lead_agent_id   String           @db.Uuid
  lead_agent      User             @relation("CampaignLead", fields: [lead_agent_id], references: [id])
  
  // Relations
  assigned_agents CampaignAgent[]
  prospects       Prospect[]

  entity_status   EntityStatus     @default(ACTIVE)
  created_at      DateTime         @default(now()) @db.Timestamp(6)
  updated_at      DateTime         @default(now()) @db.Timestamp(6)
}

model CampaignAgent {
  campaign_id     String             @db.Uuid
  agent_id        String             @db.Uuid
  campaign        ConversionCampaign @relation(fields: [campaign_id], references: [id], onDelete: Cascade)
  agent           User               @relation("CampaignAgents", fields: [agent_id], references: [id], onDelete: Cascade)

  @@id([campaign_id, agent_id])
}

model ProspectLossReason {
  id              String       @id @default(uuid()) @db.Uuid
  name            String       @db.VarChar(255)
  description     String?      @db.Text
  is_active       Boolean      @default(true)
  position        Int          @default(0)
  
  prospects       Prospect[]

  entity_status   EntityStatus @default(ACTIVE)
  created_at      DateTime     @default(now()) @db.Timestamp(6)
  updated_at      DateTime     @default(now()) @db.Timestamp(6)
}
"""

content += new_models

with open('prisma/schema.prisma', 'w') as f:
    f.write(content)

print("Schema updated successfully.")
