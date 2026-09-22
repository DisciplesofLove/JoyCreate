/**
 * Scraping Orchestrator — Central coordinator for all scraping operations.
 *
 * Manages the full job lifecycle:
 *  1. Probe URL → select engine
 *  2. Fetch with engine (static/browser/stealth/api)
 *  3. Extract content (DOM + AI)
 *  4. Persist results to SQLite via Drizzle
 *  5. Track metrics + handle errors + retries
 *
 * Also manages the job queue, scheduled jobs, and crawl sessions.
 */

import { eq } from "drizzle-orm";
import log from "electron-log";
import { db } from "@/db";
import {
  scrapingJobs,
  scrapingResults,
  scrapingSchedules,
  scrapingTemplates,
} from "@/db/schema";
import { probeUrl, selectEngine } from "./engine_selector";
import {
  StaticEngine,
  BrowserEngine,
  StealthEngine,
  APIEngine,
} from "./engines";
import { runExtraction, quickExtract } from "./extraction";
import { JoyCrawler } from "./crawler";
import { generatePaginationUrls, detectPagination } from "./pagination";
import { ProxyManager } from "./proxy";
import {
  adjustDelay,
  getAdaptiveDelay,
  isUrlAllowed,
  waitForToken,
} from "./anti_bot";
import {
  MetricsCollector,
  categorizeError,
  getRetryDelay,
  shouldRetry,
  DEFAULT_RETRY_STRATEGY,
} from "./monitoring";
import type {
  CrawlConfig,
  CrawlPageResult,
  EngineType,
  ProxyConfig,
  ScrapeOptions,
  ScrapeResult,
  ScrapingEngine,
  RetryStrategy,
  ScrapingMetrics,
} from "./types";
import type { ScrapingConfig } from "@/ipc/handlers/scraping/types";

const logger = log.scope("scraping:orchestrator");

/**
 * The most recent HTML per URL, so pagination can be detected from the page
 * that was just fetched without fetching it twice. Entries are deleted as soon
 * as the URL has been processed.
 */
const lastHtmlByUrl = new Map<string, string>();

// ── Engine pool ─────────────────────────────────────────────────────────────

const engines: Record<string, ScrapingEngine> = {};

function getEngine(type: EngineType): ScrapingEngine {
  if (type === "auto") type = "static"; // resolved by caller
  if (!engines[type]) {
    switch (type) {
      case "static":
        engines[type] = new StaticEngine();
        break;
      case "browser":
        engines[type] = new BrowserEngine();
        break;
      case "stealth":
        engines[type] = new StealthEngine();
        break;
      case "api":
        engines[type] = new APIEngine();
        break;
      case "fetch":
        engines[type] = new StaticEngine(); // alias
        break;
    }
  }
  return engines[type];
}

/**
 * Dispose all engine resources (browser instances, etc.).
 */
export async function disposeEngines(): Promise<void> {
  for (const engine of Object.values(engines)) {
    await engine.dispose().catch(() => {});
  }
}

// ── Job Orchestration ───────────────────────────────────────────────────────

/**
 * Create a new scraping job and return its ID.
 */
export async function createJob(
  name: string,
  config: ScrapingConfig,
  opts?: {
    engine?: EngineType;
    templateId?: string;
    scheduleId?: string;
    datasetId?: string;
  },
): Promise<string> {
  const id = crypto.randomUUID();

  await db.insert(scrapingJobs).values({
    id,
    name,
    status: "queued",
    config: config as unknown as Record<string, unknown>,
    engine: opts?.engine ?? "auto",
    pagesTotal: 0,
    pagesDone: 0,
    recordsExtracted: 0,
    errorCount: 0,
    templateId: opts?.templateId,
    scheduleId: opts?.scheduleId,
    datasetId: opts?.datasetId,
  });

  logger.info(`Created scraping job ${id}: ${name}`);
  return id;
}

/**
 * Run a scraping job to completion.
 */
export async function runJob(jobId: string): Promise<void> {
  const [job] = await db
    .select()
    .from(scrapingJobs)
    .where(eq(scrapingJobs.id, jobId))
    .limit(1);

  if (!job) throw new Error(`Job ${jobId} not found`);
  if (job.status !== "queued" && job.status !== "paused") {
    throw new Error(`Job ${jobId} is ${job.status}, cannot run`);
  }

  const config = job.config as unknown as ScrapingConfig;
  const metrics = new MetricsCollector();

  // Mark running
  await db
    .update(scrapingJobs)
    .set({ status: "running", startedAt: new Date() })
    .where(eq(scrapingJobs.id, jobId));

  try {
    // Resolve URLs to scrape
    const urls = resolveUrls(config);
    await db
      .update(scrapingJobs)
      .set({ pagesTotal: urls.length })
      .where(eq(scrapingJobs.id, jobId));

    // Resolve engine
    let engineType: EngineType = job.engine as EngineType;
    if (engineType === "auto" && urls.length > 0) {
      const probe = await probeUrl(urls[0]);
      engineType = selectEngine(probe);
    }

    const engine = getEngine(engineType);
    const proxies = buildProxyManager(config);

    if (config.crawl?.enabled && urls.length > 0) {
      // Crawl mode replaces the fixed list: the seeds are the starting points
      // and the frontier decides the rest.
      await runCrawl(jobId, urls, engine, config, metrics);
    } else {
      // A queue rather than a fixed array, so pagination discovered on page one
      // can extend the run without a second pass over the site.
      const queue = [...urls];
      const seen = new Set(queue);
      let paginationChecked = false;

      for (let i = 0; i < queue.length; i++) {
        const url = queue[i];

        // Check if cancelled
        const [current] = await db
          .select({ status: scrapingJobs.status })
          .from(scrapingJobs)
          .where(eq(scrapingJobs.id, jobId))
          .limit(1);

        if (current?.status === "cancelled" || current?.status === "paused") {
          break;
        }

        await processUrl(jobId, url, engine, config, metrics, undefined, proxies);

        // Pagination is detected once, from the first page that produced HTML.
        // Re-detecting per page would multiply the same sequence.
        if (!paginationChecked && config.api?.pagination) {
          paginationChecked = true;
          const html = lastHtmlByUrl.get(url);
          if (html) {
            for (const next of expandPagination(config, url, html)) {
              if (!seen.has(next)) {
                seen.add(next);
                queue.push(next);
              }
            }
            await db
              .update(scrapingJobs)
              .set({ pagesTotal: queue.length })
              .where(eq(scrapingJobs.id, jobId));
          }
        }
        lastHtmlByUrl.delete(url);
      }
    }

    // Final status
    const [final] = await db
      .select({ status: scrapingJobs.status })
      .from(scrapingJobs)
      .where(eq(scrapingJobs.id, jobId))
      .limit(1);

    if (final?.status === "running") {
      await db
        .update(scrapingJobs)
        .set({ status: "done", completedAt: new Date() })
        .where(eq(scrapingJobs.id, jobId));
    }
  } catch (err) {
    logger.error(`Job ${jobId} failed:`, err);
    await db
      .update(scrapingJobs)
      .set({
        status: "failed",
        lastError: err instanceof Error ? err.message : String(err),
        completedAt: new Date(),
      })
      .where(eq(scrapingJobs.id, jobId));
  }
}

async function processUrl(
  jobId: string,
  url: string,
  engine: ScrapingEngine,
  config: ScrapingConfig,
  metrics: MetricsCollector,
  retryStrategy: RetryStrategy = DEFAULT_RETRY_STRATEGY,
  proxies?: ProxyManager,
): Promise<void> {
  let lastError: Error | undefined;
  const domain = domainOf(url);
  const baseDelay = config.rateLimit?.delayBetweenRequests ?? 0;

  // Politeness, before the first request rather than between requests.
  //
  // The orchestrator used to fetch in a tight loop with no delay and no robots
  // check, while a finished politeness engine sat unimported next to it. A
  // scraper that ignores robots.txt and hammers a host is how an IP gets
  // blocked — and the proxy rotation below exists to survive blocks, not to
  // make earning them cheaper.
  if (!(await isUrlAllowed(url, config.rateLimit?.respectRobots !== false))) {
    logger.info(`robots.txt disallows ${url}; skipping`);
    metrics.recordError();
    return;
  }

  for (let attempt = 0; attempt <= retryStrategy.maxRetries; attempt++) {
    let proxy: ProxyConfig | undefined;
    const startedAt = Date.now();
    try {
      // Token bucket per domain, then the adaptive delay this domain has
      // earned — it grows on errors and shrinks on success.
      await waitForToken(domain, config.rateLimit?.requestsPerSecond ?? 2);
      const delayMs = getAdaptiveDelay(domain, baseDelay);
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));

      proxy = proxies?.getProxy(domain) ?? undefined;

      // Fetch
      const scrapeResult = await engine.scrape(url, {
        timeout: 30_000,
        scrollToBottom: config.mode === "playwright" || config.mode === "hybrid",
        proxy,
      });

      if (proxy) proxies?.reportSuccess(proxy, Date.now() - startedAt);
      // The real status matters: `adjustDelay` backs off hard on 429/503 and
      // eases off on 2xx, which a boolean could not express.
      adjustDelay(domain, scrapeResult.statusCode, baseDelay);

      metrics.recordPageLoad(scrapeResult.fetchDurationMs, scrapeResult.bytesReceived);

      // Held only until the caller has had a chance to look for pagination
      // links, then dropped. Keeping every page's HTML for the length of a job
      // would hold a whole site in memory.
      if (scrapeResult.html) lastHtmlByUrl.set(url, scrapeResult.html);

      // Extract
      const extraction = await runExtraction({
        scrapeResult,
        config,
      });

      metrics.recordExtraction(true, extraction.fieldData?.length ?? 1);

      // Store result
      const resultId = crypto.randomUUID();
      await db.insert(scrapingResults).values({
        id: resultId,
        jobId,
        url,
        statusCode: scrapeResult.statusCode,
        data: {
          title: extraction.page.title,
          content: extraction.page.content,
          excerpt: extraction.page.excerpt,
          author: extraction.page.author,
          publishedDate: extraction.page.publishedDate,
          images: extraction.page.images?.length ?? 0,
          links: extraction.page.links?.length ?? 0,
          fields: extraction.fieldData,
          feedItems: extraction.feedItems?.length,
          sitemapUrls: extraction.sitemapUrls?.length,
        } as Record<string, unknown>,
        extractionEngine: engine.name,
        screenshotPath: scrapeResult.screenshotPath,
        confidence: 1.0,
      });

      // Update job progress
      await db
        .update(scrapingJobs)
        .set({
          pagesDone: (await getJobProgress(jobId)).pagesDone + 1,
          recordsExtracted:
            (await getJobProgress(jobId)).recordsExtracted +
            (extraction.fieldData?.length ?? 1),
        })
        .where(eq(scrapingJobs.id, jobId));

      return; // Success
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const category = categorizeError(err);
      metrics.recordError();

      // A failure through a proxy counts against that proxy, and slows this
      // domain down. Both are what let a long crawl survive rate limiting
      // instead of failing every remaining page the same way.
      if (proxy) proxies?.reportFailure(proxy);
      // No response means no status; 503 is the closest honest signal — treat
      // it as "back off", which is what a dead or throttling host warrants.
      adjustDelay(domain, 503, baseDelay);

      if (!shouldRetry(category) || attempt >= retryStrategy.maxRetries) {
        break;
      }

      const delay = getRetryDelay(retryStrategy, attempt);
      logger.warn(
        `Retry ${attempt + 1}/${retryStrategy.maxRetries} for ${url} (${category}), waiting ${delay}ms`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  // All retries exhausted
  await db
    .update(scrapingJobs)
    .set({
      errorCount: (await getJobProgress(jobId)).errorCount + 1,
      lastError: lastError?.message ?? "Unknown error",
    })
    .where(eq(scrapingJobs.id, jobId));
}

// ── Quick Scrape (single URL, no job) ───────────────────────────────────────

export interface QuickScrapeResult {
  url: string;
  title: string;
  text: string;
  markdown: string;
  engine: EngineType;
  durationMs: number;
}

/**
 * Quick scrape a single URL without creating a job.
 */
export async function quickScrape(
  url: string,
  opts?: ScrapeOptions,
): Promise<QuickScrapeResult> {
  const start = Date.now();

  // Auto-select engine
  let engineType: EngineType = opts?.engine ?? "auto";
  if (engineType === "auto") {
    try {
      const probe = await probeUrl(url);
      engineType = selectEngine(probe);
    } catch {
      engineType = "static"; // fallback if probe itself fails
    }
  }

  // Try primary engine, fallback to static on timeout / browser errors
  const tryEngine = async (type: EngineType): Promise<QuickScrapeResult> => {
    const engine = getEngine(type);
    const result = await engine.scrape(url, opts ?? {});
    const extracted = quickExtract(result.html, result.finalUrl);
    return {
      url: result.finalUrl,
      title: extracted.title,
      text: extracted.text,
      markdown: extracted.markdown,
      engine: type,
      durationMs: Date.now() - start,
    };
  };

  try {
    return await tryEngine(engineType);
  } catch (err) {
    const msg = String(err);
    // If a browser/stealth engine timed out or crashed, try static as fallback
    if (
      engineType !== "static" &&
      (msg.includes("Timeout") || msg.includes("timeout") ||
       msg.includes("Target closed") || msg.includes("browser has been closed") ||
       msg.includes("net::ERR_"))
    ) {
      logger.warn(`Engine '${engineType}' failed for ${url}, falling back to static`, msg);
      return await tryEngine("static");
    }
    throw err;
  }
}

// ── Job Management Queries ──────────────────────────────────────────────────

export async function getJob(jobId: string) {
  const [job] = await db
    .select()
    .from(scrapingJobs)
    .where(eq(scrapingJobs.id, jobId))
    .limit(1);
  return job ?? null;
}

export async function listJobs(status?: string) {
  if (status) {
    return db
      .select()
      .from(scrapingJobs)
      .where(eq(scrapingJobs.status, status as any))
      .orderBy(scrapingJobs.createdAt);
  }
  return db.select().from(scrapingJobs).orderBy(scrapingJobs.createdAt);
}

export async function cancelJob(jobId: string): Promise<void> {
  await db
    .update(scrapingJobs)
    .set({ status: "cancelled", completedAt: new Date() })
    .where(eq(scrapingJobs.id, jobId));
}

export async function pauseJob(jobId: string): Promise<void> {
  await db
    .update(scrapingJobs)
    .set({ status: "paused" })
    .where(eq(scrapingJobs.id, jobId));
}

export async function resumeJob(jobId: string): Promise<void> {
  // Requeue and re-run
  await db
    .update(scrapingJobs)
    .set({ status: "queued" })
    .where(eq(scrapingJobs.id, jobId));
}

export async function deleteJob(jobId: string): Promise<void> {
  // Results cascade-delete via FK
  await db.delete(scrapingJobs).where(eq(scrapingJobs.id, jobId));
}

async function getJobProgress(jobId: string) {
  const [job] = await db
    .select({
      pagesDone: scrapingJobs.pagesDone,
      recordsExtracted: scrapingJobs.recordsExtracted,
      errorCount: scrapingJobs.errorCount,
    })
    .from(scrapingJobs)
    .where(eq(scrapingJobs.id, jobId))
    .limit(1);
  return job ?? { pagesDone: 0, recordsExtracted: 0, errorCount: 0 };
}

// ── Results Queries ─────────────────────────────────────────────────────────

export async function getJobResults(jobId: string) {
  return db
    .select()
    .from(scrapingResults)
    .where(eq(scrapingResults.jobId, jobId));
}

export async function getResult(resultId: string) {
  const [result] = await db
    .select()
    .from(scrapingResults)
    .where(eq(scrapingResults.id, resultId))
    .limit(1);
  return result ?? null;
}

// ── Schedule Management ─────────────────────────────────────────────────────

export async function createSchedule(
  name: string,
  jobConfig: Record<string, unknown>,
  cronExpression: string,
): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(scrapingSchedules).values({
    id,
    name,
    jobConfig,
    cronExpression,
    enabled: true,
  });
  return id;
}

export async function listSchedules() {
  return db.select().from(scrapingSchedules);
}

export async function toggleSchedule(id: string, enabled: boolean): Promise<void> {
  await db
    .update(scrapingSchedules)
    .set({ enabled })
    .where(eq(scrapingSchedules.id, id));
}

export async function deleteSchedule(id: string): Promise<void> {
  await db.delete(scrapingSchedules).where(eq(scrapingSchedules.id, id));
}

// ── Template Management ─────────────────────────────────────────────────────

export async function createTemplate(
  name: string,
  description: string,
  category: string,
  config: Record<string, unknown>,
): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(scrapingTemplates).values({
    id,
    name,
    description,
    category,
    config,
  });
  return id;
}

export async function listTemplates() {
  return db.select().from(scrapingTemplates);
}

export async function getTemplate(id: string) {
  const [template] = await db
    .select()
    .from(scrapingTemplates)
    .where(eq(scrapingTemplates.id, id))
    .limit(1);
  return template ?? null;
}

export async function deleteTemplate(id: string): Promise<void> {
  await db.delete(scrapingTemplates).where(eq(scrapingTemplates.id, id));
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function resolveUrls(config: ScrapingConfig): string[] {
  if (config.urls && config.urls.length > 0) {
    return config.urls;
  }
  return [];
}

/** Host of a URL, or the raw string if it will not parse. */
function domainOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * Build a rotating proxy pool from the job config, or nothing when none is set.
 *
 * `ScrapingConfig.proxy` holds a single URL; `ProxyManager` wants a parsed pool.
 * A pool of one still buys the health tracking — three failures and the
 * orchestrator stops routing through a proxy that is no longer working, rather
 * than retrying every remaining URL through it.
 */
function buildProxyManager(config: ScrapingConfig): ProxyManager | undefined {
  if (!config.proxy?.url) return undefined;
  try {
    const u = new URL(config.proxy.url);
    const type = (u.protocol.replace(":", "") || "http") as ProxyConfig["type"];
    const proxy: ProxyConfig = {
      type,
      host: u.hostname,
      port: Number(u.port) || (type === "https" ? 443 : 80),
      username: config.proxy.username || u.username || undefined,
      password: config.proxy.password || u.password || undefined,
    };
    return new ProxyManager({ proxies: [proxy], rotation: "per-domain" });
  } catch (err) {
    // A malformed proxy URL must not silently mean "scrape without a proxy" —
    // the whole point of setting one is usually that direct requests are
    // blocked or identifying.
    logger.error(`invalid proxy URL ${config.proxy.url}:`, err);
    throw new Error(`Invalid proxy URL: ${config.proxy.url}`);
  }
}

/**
 * Expand a seed URL into its paginated siblings.
 *
 * `ScrapingConfig.api.pagination` was declared, surfaced in the UI, and read by
 * nothing — a job with pagination configured scraped page one and stopped.
 * Detection needs the first page's HTML, so this runs after the first fetch.
 */
function expandPagination(
  config: ScrapingConfig,
  firstUrl: string,
  html: string,
): string[] {
  const maxPages = config.api?.pagination?.maxPages ?? 0;
  if (maxPages <= 1) return [];

  try {
    const detection = detectPagination(html, firstUrl);
    if (detection.confidence < 0.5) {
      logger.info(
        `pagination not confidently detected for ${firstUrl} (${detection.strategy}, ${detection.confidence})`,
      );
      return [];
    }
    const urls = generatePaginationUrls(detection, maxPages);
    if (urls.length > 0) {
      logger.info(`pagination: ${urls.length} more page(s) from ${firstUrl}`);
    }
    return urls;
  } catch (err) {
    logger.warn(`pagination detection failed for ${firstUrl}:`, err);
    return [];
  }
}

/**
 * Run a job in crawl mode: follow links from the seeds instead of scraping a
 * fixed list.
 *
 * `ScrapingConfig.crawl` has always existed and the orchestrator has always
 * ignored it, so turning crawling on in the UI scraped exactly the seed URLs.
 * The crawler handles the frontier, scope and dedupe; extraction and storage
 * stay here, because that is where the job's config and the results table are.
 */
async function runCrawl(
  jobId: string,
  seeds: string[],
  engine: ScrapingEngine,
  config: ScrapingConfig,
  metrics: MetricsCollector,
): Promise<void> {
  const crawlConfig: CrawlConfig = {
    seeds,
    maxDepth: config.crawl?.maxDepth ?? 2,
    maxPages: config.crawl?.maxPages ?? 50,
    concurrency: Math.max(1, config.rateLimit?.maxConcurrent ?? 2),
    // "domain" keeps the crawl on the seed's host; "subdomain" is the widest
    // scope this type offers, and is what "follow external links" means here.
    scope: config.crawl?.followExternal ? "subdomain" : "domain",
    strategy: "bfs",
    followRedirects: true,
    respectRobots: config.rateLimit?.respectRobots !== false,
    delayMs: [
      config.rateLimit?.delayBetweenRequests ?? 250,
      (config.rateLimit?.delayBetweenRequests ?? 250) * 3,
    ],
    engine: engine.name as EngineType,
    filters: [
      ...(config.crawl?.urlIncludePattern
        ? [{ type: "include" as const, pattern: config.crawl.urlIncludePattern }]
        : []),
      ...(config.crawl?.urlExcludePattern
        ? [{ type: "exclude" as const, pattern: config.crawl.urlExcludePattern }]
        : []),
    ],
    onPageDone: (page: CrawlPageResult) => {
      // Fire-and-forget: the crawler's workers must not block on the database,
      // and a storage failure should cost one page rather than the crawl.
      void storeCrawledPage(jobId, page, config, metrics).catch((err) =>
        logger.warn(`failed to store crawled page ${page.url}:`, err),
      );
    },
  };

  const crawler = new JoyCrawler(crawlConfig, engine);
  const session = await crawler.crawl();
  logger.info(
    `crawl finished: ${session.pagesVisited} visited, ${session.pagesErrored} errored`,
  );

  await db
    .update(scrapingJobs)
    .set({ pagesTotal: session.pagesVisited })
    .where(eq(scrapingJobs.id, jobId));
}

/** Extract and store one page the crawler fetched. */
async function storeCrawledPage(
  jobId: string,
  page: CrawlPageResult,
  config: ScrapingConfig,
  metrics: MetricsCollector,
): Promise<void> {
  if (page.error || !page.result) {
    metrics.recordError();
    return;
  }

  metrics.recordPageLoad(
    page.result.fetchDurationMs,
    page.result.bytesReceived,
  );

  const extraction = await runExtraction({ scrapeResult: page.result, config });
  metrics.recordExtraction(true, extraction.fieldData?.length ?? 1);

  await db.insert(scrapingResults).values({
    id: crypto.randomUUID(),
    jobId,
    url: page.url,
    statusCode: page.statusCode,
    data: {
      title: extraction.page.title,
      content: extraction.page.content,
      excerpt: extraction.page.excerpt,
      author: extraction.page.author,
      publishedDate: extraction.page.publishedDate,
      images: extraction.page.images?.length ?? 0,
      links: extraction.page.links?.length ?? 0,
      fields: extraction.fieldData,
      crawlDepth: page.depth,
    } as Record<string, unknown>,
    extractionEngine: "crawler",
    confidence: 1.0,
  });

  const progress = await getJobProgress(jobId);
  await db
    .update(scrapingJobs)
    .set({
      pagesDone: progress.pagesDone + 1,
      recordsExtracted:
        progress.recordsExtracted + (extraction.fieldData?.length ?? 1),
    })
    .where(eq(scrapingJobs.id, jobId));
}

// ── Exported for tests ──────────────────────────────────────────────────────
//
// The URL-expansion and proxy-parsing helpers decide how much of a site gets
// hit and through what, so they are worth testing directly rather than only
// through a job that needs a network, a database and a browser.
export const __test__ = {
  domainOf,
  buildProxyManager,
  expandPagination,
  resolveUrls,
};
