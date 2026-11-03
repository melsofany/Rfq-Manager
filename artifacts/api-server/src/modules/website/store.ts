/**
 * Website settings store — مخزن محتوى الموقع.
 *
 * Reads and writes the single `website_settings` row (key `default`). The
 * persisted `content` is merged ON TOP of `DEFAULT_WEBSITE_CONTENT`, so a row
 * that only carries the fields an admin actually changed still renders every
 * other section from the defaults rather than as blank.
 */
import {
  db,
  websiteSettingsTable,
  DEFAULT_WEBSITE_CONTENT,
  type WebsiteContent,
} from "@workspace/db";
import { eq } from "drizzle-orm";

export interface WebsiteSettings {
  enabled: boolean;
  maintenanceMode: boolean;
  maintenanceMessage: string | null;
  content: WebsiteContent;
  updatedBy: number | null;
  updatedAt: Date | null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

/**
 * Deep-merge persisted content over the defaults. Arrays are replaced wholesale
 * (a shorter list of services is a valid edit, not something to merge).
 */
export function mergeContent(persisted: unknown): WebsiteContent {
  function merge(defaults: unknown, patch: unknown): unknown {
    if (!isPlainObject(defaults)) return patch === undefined ? defaults : patch;
    if (!isPlainObject(patch)) return defaults;
    const out: Record<string, unknown> = { ...defaults };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      const base = (defaults as Record<string, unknown>)[key];
      out[key] = isPlainObject(base) && isPlainObject(value) ? merge(base, value) : value;
    }
    return out;
  }
  return merge(DEFAULT_WEBSITE_CONTENT, persisted) as WebsiteContent;
}

/** Load the settings row, falling back to the defaults when it is absent. */
export async function loadWebsiteSettings(): Promise<WebsiteSettings> {
  const [row] = await db
    .select()
    .from(websiteSettingsTable)
    .where(eq(websiteSettingsTable.key, "default"))
    .limit(1);
  if (!row) {
    return {
      enabled: true,
      maintenanceMode: false,
      maintenanceMessage: null,
      content: mergeContent({}),
      updatedBy: null,
      updatedAt: null,
    };
  }
  return {
    enabled: row.enabled !== false,
    maintenanceMode: row.maintenanceMode === true,
    maintenanceMessage: row.maintenanceMessage ?? null,
    content: mergeContent(row.content),
    updatedBy: row.updatedBy ?? null,
    updatedAt: row.updatedAt ?? null,
  };
}

export interface WebsiteSettingsPatch {
  enabled?: boolean;
  maintenanceMode?: boolean;
  maintenanceMessage?: string | null;
  content?: Partial<WebsiteContent>;
  updatedBy?: number | null;
}

/**
 * Upsert the settings row. The content patch is deep-merged onto the CURRENT
 * persisted value first so a partial save (e.g. only the contact section) never
 * wipes the sections it did not mention.
 */
export async function updateWebsiteSettings(patch: WebsiteSettingsPatch): Promise<void> {
  const current = await loadWebsiteSettings();
  const mergedContent = patch.content
    ? mergeContent({ ...current.content, ...patch.content })
    : current.content;

  const values = {
    key: "default" as const,
    enabled: patch.enabled ?? current.enabled,
    maintenanceMode: patch.maintenanceMode ?? current.maintenanceMode,
    maintenanceMessage:
      patch.maintenanceMessage === undefined ? current.maintenanceMessage : patch.maintenanceMessage,
    content: mergedContent,
    updatedBy: patch.updatedBy ?? current.updatedBy,
    updatedAt: new Date(),
  };

  await db
    .insert(websiteSettingsTable)
    .values(values)
    .onConflictDoUpdate({
      target: websiteSettingsTable.key,
      set: {
        enabled: values.enabled,
        maintenanceMode: values.maintenanceMode,
        maintenanceMessage: values.maintenanceMessage,
        content: values.content,
        updatedBy: values.updatedBy,
        updatedAt: values.updatedAt,
      },
    });
}
