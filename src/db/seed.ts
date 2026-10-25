import bcrypt from 'bcryptjs';
import { db, pool } from './client.js';
import { users, workspaces, memberships, categories, subcategories } from './schema.js';

export async function seed() {
  console.log('Seeding local development database...');

  // 1. Create demo user
  const passwordHash = await bcrypt.hash('Password123!', 10);
  const [demoUser] = await db
    .insert(users)
    .values({
      email: 'demo@pennywise.local',
      passwordHash,
    })
    .onConflictDoNothing({ target: users.email })
    .returning();

  if (!demoUser) {
    console.log('Demo user already exists, skipping seed.');
    return;
  }

  // 2. Create demo workspace
  const [workspace] = await db
    .insert(workspaces)
    .values({
      name: 'Personal Workspace',
      currency: 'MYR',
    })
    .returning();

  // 3. Create owner membership
  await db.insert(memberships).values({
    workspaceId: workspace.id,
    userId: demoUser.id,
    role: 'owner',
  });

  // 4. Create Income categories (leaf categories, no subcategories)
  await db.insert(categories).values([
    {
      workspaceId: workspace.id,
      name: 'Salary',
      type: 'income',
      sortOrder: 1,
    },
    {
      workspaceId: workspace.id,
      name: 'Freelance & Investments',
      type: 'income',
      sortOrder: 2,
    },
  ]);

  // 5. Create Expense categories
  // Parent 1: Housing
  const [housing] = await db
    .insert(categories)
    .values({
      workspaceId: workspace.id,
      name: 'Housing',
      type: 'expense',
      sortOrder: 1,
    })
    .returning();

  await db.insert(subcategories).values([
    {
      workspaceId: workspace.id,
      categoryId: housing.id,
      name: 'Rent / Mortgage',
      sortOrder: 1,
    },
    {
      workspaceId: workspace.id,
      categoryId: housing.id,
      name: 'Utilities',
      sortOrder: 2,
    },
    {
      workspaceId: workspace.id,
      categoryId: housing.id,
      name: 'Internet',
      sortOrder: 3,
    },
  ]);

  // Parent 2: Food & Groceries
  const [food] = await db
    .insert(categories)
    .values({
      workspaceId: workspace.id,
      name: 'Food',
      type: 'expense',
      sortOrder: 2,
    })
    .returning();

  await db.insert(subcategories).values([
    {
      workspaceId: workspace.id,
      categoryId: food.id,
      name: 'Groceries',
      sortOrder: 1,
    },
    {
      workspaceId: workspace.id,
      categoryId: food.id,
      name: 'Dining Out',
      sortOrder: 2,
    },
  ]);

  // Leaf Expense categories
  await db.insert(categories).values([
    {
      workspaceId: workspace.id,
      name: 'Transportation',
      type: 'expense',
      sortOrder: 3,
    },
    {
      workspaceId: workspace.id,
      name: 'Entertainment',
      type: 'expense',
      sortOrder: 4,
    },
  ]);

  console.log('Database seeded successfully:');
  console.log(`- Demo user: ${demoUser.email} (password: Password123!)`);
  console.log(`- Workspace: ${workspace.name} (${workspace.currency})`);
}

// Allow direct CLI invocation: `tsx src/db/seed.ts`
if (process.argv[1] && process.argv[1].endsWith('seed.ts')) {
  seed()
    .then(() => pool.end())
    .catch((err) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}
