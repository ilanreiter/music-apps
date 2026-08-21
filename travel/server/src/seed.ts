import bcrypt from "bcryptjs";
import { prisma } from "./db";

async function upsertUser(email: string, name: string, password: string) {
  const passwordHash = await bcrypt.hash(password, 10);
  await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, name, passwordHash },
  });
  console.log(`Seeded user: ${email}`);
}

async function main() {
  const email1 = process.env.SEED_USER1_EMAIL || "ilan.reiter@gmail.com";
  const name1 = process.env.SEED_USER1_NAME || "Ilan";
  const pass1 = process.env.SEED_USER1_PASSWORD || "changeme123";

  const email2 = process.env.SEED_USER2_EMAIL;
  const name2 = process.env.SEED_USER2_NAME || "Partner";
  const pass2 = process.env.SEED_USER2_PASSWORD;

  await upsertUser(email1, name1, pass1);
  if (email2 && pass2) {
    await upsertUser(email2, name2, pass2);
  }

  const destCount = await prisma.destination.count();
  if (destCount === 0) {
    await prisma.destination.createMany({
      data: [
        { name: "Kyoto, Japan", country: "Japan", status: "IDEA", priority: 0, tags: ["culture", "food"], bestSeason: "Spring (cherry blossoms) or Fall" },
        { name: "Lisbon, Portugal", country: "Portugal", status: "RESEARCHING", priority: 1, tags: ["coastal", "food"], bestSeason: "Spring/Fall" },
        { name: "Patagonia, Chile/Argentina", country: "Chile", status: "IDEA", priority: 2, tags: ["hiking", "nature"], bestSeason: "Nov-Mar" },
      ],
    });
    console.log("Seeded sample destinations");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
