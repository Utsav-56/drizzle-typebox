import { $t, NameRule, rawSchema, rule, writeOnlyRule } from "./rules";
import { QueryMode } from "./types";
import { t } from "@utsav/typebox";

export const MODE_OMIT_PATTERNS: Record<QueryMode, RegExp[]> = {
  select: [],
  insert: [/^(created_at|createdAt)$/i],
  update: [/^(created_at|createdAt)$/i],
};

/**
 * Priority 2: Column Name Inference Rules.
 * Evaluated at module load using `$t`, so any missing method or bad option fails immediately!
 */
export const NAME_RULES: NameRule[] = [
  writeOnlyRule(
    /^(featured_image(_url)?|featuredImage|image)$/i,
    $t.ImageFile(),
    $t.String(),
  ),
  writeOnlyRule(
    /^(additional_images?|additionalImage|images)$/i,
    $t.MultipleImageFiles(),
    $t.Array(rawSchema($t.String(), t.String())),
  ),
  rule(/^coordinate$|(_coordinates|Coordinates)$/, $t.Coordinate()),
  rule(
    /(_date|Date|_expires|Expires)$|^(created|updated|expires)(_at|At)$/,
    $t.DateTime(),
  ),
  rule(
    /reason$/i,
    $t.String({ minLength: 20, error: "Reason must be 20 characters long" }),
  ),
];
