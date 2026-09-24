/**
 * The courier.
 *
 * Two of cedarengine's four sources are behind a login a server cannot hold:
 * the directory wants an SSO session, and the campus store wants an AWS WAF
 * challenge solved by a real browser. This is a real browser, and you are
 * already signed into both. So the extension does no thinking of its own — it
 * asks the engine what to fetch, fetches it, and posts back what came out.
 *
 * The engine decides which name prefixes are still hiding rows, which students
 * have no booklist yet, and when a sweep has seen everybody. Keeping all of
 * that on the server side means this file never has to be updated when the
 * sweep logic gets smarter.
 */

const DEFAULTS = {
  engine: "http://127.0.0.1:3000",
  token: "",
  term: "",
  everyHours: 12,
  batch: 40,
  delayMs: 150,
  autoSync: true,
};

const ALARM = "cedarengine-sync";
const DIRECTORY = "https://selfservice.cedarville.edu";
const STORE_PAGE = "https://store.cedarville.edu/textbook/index/search";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const settings = async () => ({ ...DEFAULTS, ...(await chrome.storage.local.get(null)) });

async function setStatus(patch) {
  const now = { ...(await chrome.storage.local.get("status")).status, ...patch, at: Date.now() };
  await chrome.storage.local.set({ status: now });
  return now;
}

/** Talking to the engine. Every route but /health wants the bearer token. */
async function engine(path, body) {
  const { engine: base, token } = await settings();
  const response = await fetch(base.replace(/\/$/, "") + path, {
    method: body ? "POST" : "GET",
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.status === 401) throw new Error("the engine rejected the token");
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return response.json();
}

// ---- the directory -------------------------------------------------------

class SignedOut extends Error {
  constructor() {
    super("signed out of Self-Service");
  }
}

/** One directory query, with your own session cookie riding along. */
async function directoryQuery(last, first) {
  const params = new URLSearchParams();
  if (last) params.set("LastNameSearch", last);
  if (first) params.set("FirstNameSearch", first);

  const response = await fetch(`${DIRECTORY}/CedarInfo/Directory/SearchResultsJson?${params}`, {
    credentials: "include",
    headers: { "x-requested-with": "XMLHttpRequest", accept: "*/*" },
  });
  // Signed out, Self-Service answers with a login page rather than a 401.
  if (!response.url.includes("selfservice.cedarville.edu")) throw new SignedOut();
  if (response.status === 401 || response.status === 403) throw new SignedOut();
  const data = await response.json().catch(() => null);
  if (!Array.isArray(data)) throw new SignedOut();
  return data;
}

export async function syncDirectory({ refresh = false } = {}) {
  const { batch, delayMs } = await settings();
  let plan = await engine("/v1/sync/start", { kind: "directory", refresh, limit: batch });
  const sweep = plan.sweep;
  let asked = 0;
  let added = 0;

  while (plan.queries?.length) {
    const results = [];
    for (const query of plan.queries) {
      results.push({
        last: query.last,
        first: query.first,
        people: await directoryQuery(query.last, query.first),
      });
      asked++;
      await setStatus({ phase: "directory", asked, added, queued: plan.pending });
      if (delayMs) await sleep(delayMs);
    }

    const posted = await engine("/v1/sync/directory", { sweep, results, limit: batch });
    added += posted.added;
    plan = posted;
    if (posted.done) break;
  }

  return setStatus({
    phase: "idle",
    directoryAt: Date.now(),
    asked,
    added,
    queued: 0,
  });
}

// ---- booklists -----------------------------------------------------------

/**
 * Runs inside the store page.
 *
 * It has to: the booklist endpoint is guarded by an AWS WAF token that only
 * the page itself holds, and `AwsWafIntegration` lives in the page's own
 * world. Injecting into that world is the whole trick — no content script can
 * reach it from an isolated one.
 */
function harvestInPage(ids, delayMs) {
  const grab = (block, label) => {
    const match = block.match(new RegExp(`${label}:\\s*([^<]*?)\\s*</span>`, "i"));
    return match ? match[1].trim() : null;
  };

  const parse = (html) => {
    const books = [];
    for (const block of html.split("book-container").slice(1)) {
      const title = block.match(/book-title">\s*([^<]*?)\s*<\/div>/i);
      books.push({
        title: title ? title[1].trim() : null,
        department: grab(block, "Department"),
        course: grab(block, "Course"),
        section: grab(block, "Section"),
        isbn: grab(block, "ISBN-13"),
        edition: grab(block, "Edition"),
        status: grab(block, "Status"),
      });
    }
    return books;
  };

  const refreshToken = async () => {
    try {
      const waf = window.AwsWafIntegration;
      if (waf?.getToken) {
        await waf.getToken();
        return true;
      }
      if (waf?.forceRefreshToken) {
        await waf.forceRefreshToken();
        return true;
      }
    } catch {}
    return false;
  };

  return (async () => {
    const rows = [];
    let consecutive = 0;
    for (const id of ids) {
      try {
        const response = await fetch(`/textbook/index/books?student_id=${id}&_=${Date.now()}`, {
          headers: { "x-requested-with": "XMLHttpRequest" },
        });
        const text = await response.text();
        // The WAF answers with a challenge page rather than an error status.
        if (!text.includes("book-container") && !text.includes("book-list-container")) {
          throw new Error("challenged");
        }
        rows.push({ id: String(id), books: parse(text) });
        consecutive = 0;
      } catch {
        consecutive++;
        if (consecutive >= 5) {
          const recovered = await refreshToken();
          if (!recovered) return { rows, challenged: true };
          consecutive = 0;
        }
      }
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return { rows, challenged: false };
  })();
}

/** The store tab, opened once and reused. */
async function storeTab() {
  const [existing] = await chrome.tabs.query({ url: "https://store.cedarville.edu/*" });
  if (existing) return existing;
  const tab = await chrome.tabs.create({ url: STORE_PAGE, active: false });
  await new Promise((resolve) => {
    const listener = (id, info) => {
      if (id === tab.id && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
  return tab;
}

export async function syncBooklists({ term } = {}) {
  const config = await settings();
  const manifest = await engine("/v1/sync/manifest");
  const wanted = term || config.term || manifest.term;

  let plan = await engine("/v1/sync/start", { kind: "booklists", term: wanted, limit: 500 });
  const sweep = plan.sweep;
  let collected = 0;
  let tab = await storeTab();

  while (plan.ids?.length) {
    const slice = plan.ids.slice(0, config.batch);
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: harvestInPage,
      args: [slice, config.delayMs],
    });

    const { rows = [], challenged = false } = result?.result ?? {};
    if (rows.length) {
      const posted = await engine("/v1/sync/booklists", { sweep, term: wanted, rows });
      collected += rows.length;
      plan = posted;
      await setStatus({ phase: "booklists", term: wanted, collected, queued: posted.remaining });
      if (posted.done) break;
    }

    if (challenged) {
      // The token is dead. Reloading the page re-solves the challenge, which is
      // exactly what the standalone harvester does every hundred requests.
      await chrome.tabs.reload(tab.id);
      await sleep(4000);
      tab = await storeTab();
    }
    if (!rows.length && !challenged) break; // nothing moving; stop rather than spin
  }

  return setStatus({ phase: "idle", booklistsAt: Date.now(), term: wanted, collected });
}

// ---- the loop ------------------------------------------------------------

export async function syncAll({ refresh = false } = {}) {
  try {
    await setStatus({ phase: "directory", error: null });
    await syncDirectory({ refresh });
    await syncBooklists();
    return setStatus({ phase: "idle", error: null });
  } catch (error) {
    if (error instanceof SignedOut) {
      await chrome.tabs.create({ url: `${DIRECTORY}/CedarInfo/Directory`, active: true });
      return setStatus({ phase: "idle", error: "sign in to Self-Service, then sync again" });
    }
    return setStatus({ phase: "idle", error: String(error.message ?? error) });
  }
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  const handlers = {
    sync: () => syncAll({ refresh: message.refresh }),
    directory: () => syncDirectory({ refresh: message.refresh }),
    booklists: () => syncBooklists({ term: message.term }),
    manifest: () => engine("/v1/sync/manifest"),
    status: async () => (await chrome.storage.local.get("status")).status ?? {},
  };
  const handler = handlers[message.type];
  if (!handler) return false;
  handler().then(
    (result) => respond({ ok: true, result }),
    (error) => respond({ ok: false, error: String(error.message ?? error) }),
  );
  return true; // the response is async
});

async function schedule() {
  const { everyHours, autoSync } = await settings();
  await chrome.alarms.clear(ALARM);
  if (autoSync) chrome.alarms.create(ALARM, { periodInMinutes: Math.max(everyHours, 1) * 60 });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) syncAll();
});
chrome.runtime.onInstalled.addListener(schedule);
chrome.runtime.onStartup.addListener(schedule);
chrome.storage.onChanged.addListener((changes) => {
  if (changes.everyHours || changes.autoSync) schedule();
});
