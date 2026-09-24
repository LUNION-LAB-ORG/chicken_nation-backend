import re

with open('prisma/schema.prisma', 'r') as f:
    content = f.read()

# Find restaurant_id in Prospect model and make it optional
#   restaurant_id String     @db.Uuid
#   restaurant    Restaurant @relation(fields: [restaurant_id], references: [id])

content = re.sub(
    r'restaurant_id String     @db.Uuid',
    r'restaurant_id String?    @db.Uuid',
    content
)
content = re.sub(
    r'restaurant    Restaurant @relation\(fields: \[restaurant_id\], references: \[id\]\)',
    r'restaurant    Restaurant? @relation(fields: [restaurant_id], references: [id])',
    content
)

with open('prisma/schema.prisma', 'w') as f:
    f.write(content)

print("Schema updated to make restaurant optional for Prospect.")
