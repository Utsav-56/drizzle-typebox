import { user } from "./user";
import { t } from "@utsav/typebox";
import {
  createSelectConfig,
  createInsertConfig,
  createUpdateConfig,
  GeneratorConfig,
} from "../generator";

const comp1 = t.Object({
  isBanned: t.Boolean(),
  isAdmin: t.Boolean(),
  goto: t.Optional(t.String({ format: "uri" })),
});

const selectConfig = createSelectConfig(
  user,
  {
    createdAt: t.DateTime(),
    updatedAt: t.DateTime(),
  },
  {
    columnsToexclude: ["password"],
    composites: [comp1],
  },
);

const insertConfig = createInsertConfig(
  user,
  {
    age: t.Numeric({ min: 32 }),
  },
  {
    columnsToexclude: ["password"],
    composites: [
      t.Object({
        acceptTerms: t.Boolean(),
      }),
    ],
  },
);

const updateConfig = createUpdateConfig(
  user,
  {
    age: t.Numeric({ min: 32 }),
  },
  {
    columnsToexclude: ["id", "password"],
  },
);

export default GeneratorConfig({
  // Optional: overrides default output directory if -o is not passed on CLI
  emitPath: "./src/generated/schemas",
  select: selectConfig,
  insert: insertConfig,
  update: updateConfig,
});
