import { pgTable, text, serial, timestamp, boolean, integer, jsonb } from "drizzle-orm/pg-core";
import { employeesTable } from "./employees";

/**
 * Editable content of the public company website — محتوى الموقع الإلكتروني.
 *
 * The website is a separate static site, so its copy cannot be changed from the
 * portal by editing the repo. Instead the portal owns the content and the site
 * reads it from `GET /api/public/website` at runtime, which makes an edit live
 * without a rebuild.
 *
 * Stored as one JSONB document so a new section can be added without a
 * migration. `DEFAULT_WEBSITE_CONTENT` below is the fallback the store merges
 * under whatever is persisted, so a partially-filled row never renders blanks.
 */
export interface WebsiteService {
  ar: string;
  en: string;
}

export interface WebsiteContent {
  hero: {
    headline: string;
    subheadline: string;
    ctaLabel: string;
    ctaUrl: string;
  };
  about: {
    heading: string;
    headingEn: string;
    paragraphs: string[];
  };
  services: {
    heading: string;
    headingEn: string;
    items: WebsiteService[];
  };
  contact: {
    phone1: string;
    phone2: string;
    email: string;
    addressAr: string;
    addressEn: string;
    mapEmbedUrl: string;
  };
  social: {
    facebook: string;
    linkedin: string;
    whatsapp: string;
    instagram: string;
  };
  seo: {
    title: string;
    description: string;
  };
  announcement: {
    enabled: boolean;
    text: string;
    linkLabel: string;
    linkUrl: string;
  };
}

/** The content the site shows before anyone edits it (mirrors the live site). */
export const DEFAULT_WEBSITE_CONTENT: WebsiteContent = {
  hero: {
    headline: "مورد عام موثوق لقطاع البترول وشركات المقاولات",
    subheadline: "Your Trusted General Supplier for Petroleum & Contracting Sectors",
    ctaLabel: "اطلب عرض سعر",
    ctaUrl: "mailto:info@cortoba-supplies.com?subject=طلب عرض سعر",
  },
  about: {
    heading: "من نحن",
    headingEn: "About Us",
    paragraphs: [
      "قرطبة للتوريدات هي شريكك الموثوق في شمال غرب مصر. نعمل عند تقاطع صناعة النفط والغاز والبناء الثقيل — نوفر ما تحتاجه المشاريع، أينما كانت.",
      "نحن ندرك أن الوقت والاعتمادية هما أساس النجاح في المشاريع الكبرى. لذلك، نلتزم بتقديم أعلى معايير الجودة في كل ما نورده، لضمان استمرارية العمل دون توقف.",
    ],
  },
  services: {
    heading: "خدماتنا",
    headingEn: "Services",
    items: [
      { ar: "المشتريات والتوريد العام", en: "General procurement & supply" },
      { ar: "المعدات الصناعية وقطع الغيار", en: "Industrial equipment & spare parts" },
      { ar: "معدات السلامة والوقاية", en: "Safety & protective gear" },
      { ar: "مواد البناء", en: "Construction materials" },
      { ar: "لوجستيات سريعة وتوصيل", en: "Fast logistics & delivery" },
    ],
  },
  contact: {
    phone1: "+20 111 333 1703",
    phone2: "+20 109 988 569",
    email: "info@cortoba-supplies.com",
    addressAr: "ش- الإسكندرية - برج نجمة مطروح - الدور الرابع - مرسى مطروح",
    addressEn: "Alexandria Street – Najma Matrouh Tower, 4th Floor – Mersa Matrouh, Egypt",
    mapEmbedUrl: "https://maps.google.com/maps?q=31.351312,27.240944&output=embed",
  },
  social: {
    facebook: "",
    linkedin: "",
    whatsapp: "",
    instagram: "",
  },
  seo: {
    title: "Cortoba Supplies | قرطبة للتوريدات",
    description: "مورد عام موثوق لقطاع البترول وشركات المقاولات - Cortoba Supplies",
  },
  announcement: {
    enabled: false,
    text: "",
    linkLabel: "",
    linkUrl: "",
  },
};

/**
 * Single-row website configuration (keyed `default`), seeded by `init-db.ts`.
 *
 * `enabled` is the site kill-switch (an outage page can be served instead of the
 * content), `maintenanceMode` shows a maintenance notice while still returning
 * the content, and `content` is the editable document above.
 */
export const websiteSettingsTable = pgTable("website_settings", {
  key: text("key").primaryKey(),
  enabled: boolean("enabled").notNull().default(true),
  maintenanceMode: boolean("maintenance_mode").notNull().default(false),
  maintenanceMessage: text("maintenance_message"),
  content: jsonb("content").$type<Partial<WebsiteContent>>().notNull().default({}),
  updatedBy: integer("updated_by").references(() => employeesTable.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Log of website redeploys triggered from the portal — سجل نشر الموقع.
 *
 * The site is a static build, so a code change only reaches visitors after a
 * rebuild. Each row records one request to Render's deploy API and its outcome,
 * so the page can show whether the last publish succeeded instead of assuming
 * it did.
 */
export const websiteDeploysTable = pgTable("website_deploys", {
  id: serial("id").primaryKey(),
  serviceId: text("service_id").notNull(),
  renderDeployId: text("render_deploy_id"),
  /** requested | building | live | failed | canceled */
  status: text("status").notNull().default("requested"),
  /** manual | api */
  trigger: text("trigger").notNull().default("manual"),
  commitSha: text("commit_sha"),
  message: text("message"),
  error: text("error"),
  requestedBy: integer("requested_by").references(() => employeesTable.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type WebsiteSettings = typeof websiteSettingsTable.$inferSelect;
export type WebsiteDeploy = typeof websiteDeploysTable.$inferSelect;
