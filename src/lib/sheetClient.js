// Client for functions/sheet-write.js (writes to the Google Sheet).
const KEY_STORAGE = "codec_write_key";

function storedKey() {
  try {
    return localStorage.getItem(KEY_STORAGE) || "";
  } catch {
    return "";
  }
}
function storeKey(k) {
  try {
    if (k) localStorage.setItem(KEY_STORAGE, k);
    else localStorage.removeItem(KEY_STORAGE);
  } catch {
    /* private mode: ask again next time */
  }
}

let sessionKey = "";

function getKey(forceAsk = false) {
  let k = forceAsk ? "" : sessionKey || storedKey();
  if (!k) {
    k = (window.prompt("Clé d'écriture du Google Sheet (CODEC_WRITE_KEY) :") || "").trim();
    if (k) storeKey(k);
  }
  sessionKey = k;
  return k;
}

export async function sheetWrite(body, endpoint = "/.netlify/functions/sheet-write") {
  for (let attempt = 0; attempt < 2; attempt++) {
    const key = getKey(attempt > 0);
    if (!key) throw new Error("écriture annulée (pas de clé)");
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "x-codec-key": key },
      body: JSON.stringify(body),
    });
    let data = {};
    try {
      data = await res.json();
    } catch {
      /* empty body */
    }
    if (res.status === 401) {
      storeKey("");
      sessionKey = "";
      continue; // ask again
    }
    if (!res.ok) throw new Error(data.error || `erreur ${res.status}`);
    return data;
  }
  throw new Error("clé d'écriture refusée");
}
