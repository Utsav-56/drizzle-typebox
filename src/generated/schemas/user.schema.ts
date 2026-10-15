// AUTO-GENERATED FILE BY DRIZZLE-TYPEBOX GENERATOR — DO NOT EDIT MANUALLY
import { type Static } from "@sinclair/typebox";
import { t } from "@utsav/typebox";

const _selectComposite1 = t.Object({
  isBanned: t.Boolean(),
  isAdmin: t.Boolean(),
  goto: t.Optional(t.String({ format: "uri" })),
});
export const selectUserSchema = t.Composite([
  t.Object({
    avatar: t.String(),
    id: t.Uuid(),
    name: t.String(),
    email: t.String(),
    age: t.Numeric(),
    createdAt: t.DateTime(),
    updatedAt: t.DateTime(),
  }),
  _selectComposite1,
]);
export const user_select_schema = selectUserSchema;
export type SelectUser = Static<typeof selectUserSchema>;

const _insertComposite1 = t.Object({
  acceptTerms: t.Boolean(),
});
export const insertUserSchema = t.Composite([
  t.Object({
    avatar: t.String(),
    name: t.String(),
    email: t.String(),
    age: t.Numeric({ min: 32 }),
    updatedAt: t.Optional(t.DateTime()),
  }),
  _insertComposite1,
]);
export const user_insert_schema = insertUserSchema;
export type InsertUser = Static<typeof insertUserSchema>;

export const updateUserSchema = t.Object({
  avatar: t.Optional(t.String()),
  name: t.Optional(t.String()),
  email: t.Optional(t.String()),
  age: t.Optional(t.Numeric({ min: 32 })),
  updatedAt: t.Optional(t.DateTime()),
});
export const user_update_schema = updateUserSchema;
export type UpdateUser = Static<typeof updateUserSchema>;
