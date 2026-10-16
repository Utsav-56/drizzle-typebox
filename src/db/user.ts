import {
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

const roles = ["user", "admin", "moderator"] as const;

const roleEnum = pgEnum("role_enum", roles);

export const user = pgTable("user", {
  avatar: text("image").notNull(),

  id: uuid("id").primaryKey().defaultRandom(),

  name: text("name").notNull(),
  email: text("email").notNull().unique(),

  password: text("password").notNull(),

  age: real("age").notNull(),
  role: roleEnum("roles").notNull(),

  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
});
