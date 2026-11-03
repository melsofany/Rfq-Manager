/**
 * Render deploy client for the company website — نشر الموقع الإلكتروني.
 *
 * The website is a separate static site on Render. Editing its content from the
 * portal is live immediately (the site reads it from the API), but a change to
 * the site's CODE only reaches visitors after a rebuild. This client triggers
 * that rebuild and reports its status.
 *
 * Configuration (both required; when either is missing the feature reports
 * itself as not configured instead of failing a deploy silently):
 *   RENDER_API_KEY            — Render API key (Bearer token)
 *   WEBSITE_RENDER_SERVICE_ID — the static-site service id, e.g. srv-…
 */
const RENDER_API = "https://api.render.com/v1";

export interface WebsiteDeployStatus {
  configured: boolean;
  serviceId: string | null;
  /** latest deploy on Render, when reachable */
  status: string | null;
  commitSha: string | null;
  commitMessage: string | null;
  createdAt: string | null;
  finishedAt: string | null;
  url: string | null;
  error?: string;
}

export function websiteDeployServiceId(): string | null {
  const id = (process.env.WEBSITE_RENDER_SERVICE_ID ?? "").trim();
  return id || null;
}

export function isWebsiteDeployConfigured(): boolean {
  return Boolean(process.env.RENDER_API_KEY && websiteDeployServiceId());
}

export function websiteDeployConfigProblems(): string[] {
  const problems: string[] = [];
  if (!process.env.RENDER_API_KEY) problems.push("RENDER_API_KEY غير مضبوط");
  if (!websiteDeployServiceId()) problems.push("WEBSITE_RENDER_SERVICE_ID غير مضبوط");
  return problems;
}

async function renderFetch(path: string, init?: RequestInit): Promise<Response> {
  const key = process.env.RENDER_API_KEY;
  if (!key) throw new Error("RENDER_API_KEY غير مضبوط");
  return fetch(`${RENDER_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

interface RenderDeploy {
  id?: string;
  status?: string;
  commit?: { id?: string; message?: string; createdAt?: string } | null;
  createdAt?: string;
  finishedAt?: string | null;
}

/** Latest deploy for the website service, or a `configured:false` stub. */
export async function getWebsiteDeployStatus(): Promise<WebsiteDeployStatus> {
  const serviceId = websiteDeployServiceId();
  if (!isWebsiteDeployConfigured() || !serviceId) {
    return {
      configured: false,
      serviceId,
      status: null,
      commitSha: null,
      commitMessage: null,
      createdAt: null,
      finishedAt: null,
      url: null,
    };
  }
  try {
    const res = await renderFetch(`/services/${serviceId}/deploys?limit=1`);
    if (!res.ok) {
      return {
        configured: true,
        serviceId,
        status: null,
        commitSha: null,
        commitMessage: null,
        createdAt: null,
        finishedAt: null,
        url: null,
        error: `Render API ${res.status}`,
      };
    }
    const body = (await res.json()) as Array<{ deploy?: RenderDeploy } | RenderDeploy>;
    const first = body?.[0];
    const deploy: RenderDeploy | undefined =
      first && typeof first === "object" && "deploy" in first
        ? (first.deploy as RenderDeploy)
        : (first as RenderDeploy | undefined);
    if (!deploy) {
      return {
        configured: true,
        serviceId,
        status: null,
        commitSha: null,
        commitMessage: null,
        createdAt: null,
        finishedAt: null,
        url: null,
      };
    }
    return {
      configured: true,
      serviceId,
      status: deploy.status ?? null,
      commitSha: deploy.commit?.id ?? null,
      commitMessage: deploy.commit?.message ?? null,
      createdAt: deploy.createdAt ?? deploy.commit?.createdAt ?? null,
      finishedAt: deploy.finishedAt ?? null,
      url: `https://dashboard.render.com/static/${serviceId}`,
    };
  } catch (err) {
    return {
      configured: true,
      serviceId,
      status: null,
      commitSha: null,
      commitMessage: null,
      createdAt: null,
      finishedAt: null,
      url: null,
      error: String((err as Error)?.message ?? err),
    };
  }
}

export interface TriggerResult {
  ok: boolean;
  deployId: string | null;
  error?: string;
}

/** Ask Render to rebuild + redeploy the website. */
export async function triggerWebsiteDeploy(clearCache = false): Promise<TriggerResult> {
  const serviceId = websiteDeployServiceId();
  if (!serviceId) return { ok: false, deployId: null, error: "WEBSITE_RENDER_SERVICE_ID غير مضبوط" };
  try {
    const res = await renderFetch(`/services/${serviceId}/deploys`, {
      method: "POST",
      body: JSON.stringify(clearCache ? { clearCache: "clear" } : {}),
    });
    const body = (await res.json().catch(() => ({}))) as {
      id?: string;
      deploy?: { id?: string };
      message?: string;
    };
    if (!res.ok) {
      return {
        ok: false,
        deployId: null,
        error: body?.message ?? `Render API ${res.status}`,
      };
    }
    return { ok: true, deployId: body.id ?? body.deploy?.id ?? null };
  } catch (err) {
    return { ok: false, deployId: null, error: String((err as Error)?.message ?? err) };
  }
}
