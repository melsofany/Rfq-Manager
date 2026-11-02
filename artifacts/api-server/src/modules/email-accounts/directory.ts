/**
 * Read-only client for the Google Workspace Admin SDK (Directory API).
 *
 * Requires, once, by a Workspace admin:
 *   1. Admin SDK API enabled in the Google Cloud project of the service account.
 *   2. Domain-wide delegation for the service account with the scope
 *      https://www.googleapis.com/auth/admin.directory.user.readonly
 * and the env var GOOGLE_DIRECTORY_ADMIN_EMAIL set to an admin user to
 * impersonate. This client never creates, changes or deletes accounts.
 */
import { google } from "googleapis";
import type { DirectoryUser } from "./accounts";

const SCOPE = "https://www.googleapis.com/auth/admin.directory.user.readonly";

export class DirectoryNotConfiguredError extends Error {}

interface ServiceAccountJson {
  client_email?: string;
  private_key?: string;
}

function loadServiceAccount(): ServiceAccountJson | null {
  const b64 = process.env.GOOGLE_MAIL_SERVICE_ACCOUNT_BASE_64 || process.env.GOOGLE_ACCOUNT_BASE_64;
  if (!b64) return null;
  try {
    return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as ServiceAccountJson;
  } catch {
    return null;
  }
}

export function workspaceDomain(): string {
  return (process.env.GOOGLE_WORKSPACE_DOMAIN || "cortoba-supplies.com").trim().toLowerCase();
}

export async function listDomainUsers(): Promise<DirectoryUser[]> {
  const creds = loadServiceAccount();
  const subject = (process.env.GOOGLE_DIRECTORY_ADMIN_EMAIL || "").trim();
  if (!creds?.client_email || !creds.private_key || !subject) {
    throw new DirectoryNotConfiguredError(
      "Directory API not configured: set GOOGLE_DIRECTORY_ADMIN_EMAIL and the service account credential",
    );
  }

  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: [SCOPE],
    subject,
  });
  const directory = google.admin({ version: "directory_v1", auth });

  const users: DirectoryUser[] = [];
  let pageToken: string | undefined;
  do {
    const res = await directory.users.list({
      domain: workspaceDomain(),
      maxResults: 500,
      projection: "basic",
      pageToken,
    });
    for (const u of res.data.users ?? []) {
      if (!u.primaryEmail) continue;
      users.push({
        primaryEmail: u.primaryEmail,
        name: u.name?.fullName ?? undefined,
        suspended: !!u.suspended,
        isAdmin: !!u.isAdmin,
        aliases: u.aliases ?? [],
      });
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return users;
}
