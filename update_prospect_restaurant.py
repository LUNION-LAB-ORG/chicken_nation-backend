import re

with open('prisma/schema.prisma', 'r') as f:
    content = f.read()

# Locate model Prospect
match = re.search(r'model Prospect \{.*?(?=^\})', content, re.DOTALL | re.MULTILINE)
if match:
    prospect_block = match.group(0)
    # Replace restaurant_id to make it optional
    prospect_block = prospect_block.replace(
        'restaurant_id String     @db.Uuid',
        'restaurant_id String?    @db.Uuid'
    )
    prospect_block = prospect_block.replace(
        'restaurant    Restaurant @relation(fields: [restaurant_id], references: [id])',
        'restaurant    Restaurant? @relation(fields: [restaurant_id], references: [id])'
    )
    content = content[:match.start()] + prospect_block + content[match.end():]
    
with open('prisma/schema.prisma', 'w') as f:
    f.write(content)

