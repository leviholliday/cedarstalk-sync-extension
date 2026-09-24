/**
 * Setup, in one screen.
 *
 * Paste the URL and the token, press Save. Saving asks for permission to talk
 * to whatever host you named, because the engine is usually on localhost or a
 * tunnel and neither can be baked into the manifest.
 */

const FIELDS = ["engine", "token", "term", "everyHours"];
const el = (id) => document.getElementById(id);
const status = el("status");

const say = (text, isError = false) => {
  status.textContent = text;
  status.classList.toggle("err", isError);
};

const send = (message) =>
  new Promise((resolve, reject) =>
    chrome.runtime.sendMessage(message, (reply) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!reply?.ok) return reject(new Error(reply?.error ?? "no answer"));
      resolve(reply.result);
    }),
  );

const stored = await chrome.storage.local.get(null);
for (const field of FIELDS) el(field).value = stored[field] ?? "";
el("engine").value = stored.engine ?? "http://127.0.0.1:3000";
el("everyHours").value = stored.everyHours ?? 12;
el("autoSync").checked = stored.autoSync ?? true;

async function save() {
  const values = Object.fromEntries(FIELDS.map((field) => [field, el(field).value.trim()]));
  values.everyHours = Number(values.everyHours) || 12;
  values.autoSync = el("autoSync").checked;

  // The engine's host is whatever you typed, so permission has to be asked for
  // at that point rather than declared up front.
  const origin = `${new URL(values.engine).origin}/*`;
  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted) return say("without permission for that host, nothing can be posted", true);

  await chrome.storage.local.set(values);
  try {
    const manifest = await send({ type: "manifest" });
    say(
      `connected · term ${manifest.term}\n` +
        `${manifest.directory.pending} directory queries pending\n` +
        `${manifest.booklists.remaining} students without a booklist`,
    );
  } catch (error) {
    say(error.message, true);
  }
}

const run = (type) => async () => {
  say("working…");
  try {
    const result = await send({ type });
    say(
      [
        result.error ? `error: ${result.error}` : "done",
        result.asked ? `${result.asked} directory queries` : "",
        result.added ? `${result.added} new people` : "",
        result.collected ? `${result.collected} booklists` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      Boolean(result.error),
    );
  } catch (error) {
    say(error.message, true);
  }
};

el("save").onclick = save;
el("sync").onclick = run("sync");
el("directory").onclick = run("directory");
el("booklists").onclick = run("booklists");

try {
  const state = await send({ type: "status" });
  if (state?.at) {
    say(
      [
        `last: ${new Date(state.at).toLocaleString()}`,
        state.phase && state.phase !== "idle" ? `phase ${state.phase}` : "",
        state.error ?? "",
      ]
        .filter(Boolean)
        .join("\n"),
      Boolean(state.error),
    );
  }
} catch {
  say("configure the engine url and token to begin");
}
