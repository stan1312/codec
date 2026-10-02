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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Short, readable message for the interface (details go to the console).
export function friendlyError(e) {
  const m = String((e && e.message) || e || "");
  if (/429|RESOURCE_EXHAUSTED|quota/i.test(m)) return "Google limite les accès au sheet : réessayez dans une minute";
  if (/401|403|cl[ée]/i.test(m)) return "clé d'écriture refusée";
  if (/not found|404/i.test(m)) return "vidéo introuvable dans le sheet";
  return "échec de l'enregistrement" + (m ? " (" + m.slice(0, 60) + ")" : "");
}

export async function sheetWrite(body, endpoint = "/.netlify/functions/sheet-write") {
  let askedAgain = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    const key = getKey(askedAgain);
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
    if (res.status === 401 && !askedAgain) {
      storeKey("");
      sessionKey = "";
      askedAgain = true;
      continue; // ask the key again once
    }
    const msg = data.error || `erreur ${res.status}`;
    // Google read quota: wait and retry (5 s, 10 s, 20 s, 40 s)
    if (res.status === 429 || /RESOURCE_EXHAUSTED|RATE_LIMIT/.test(msg)) {
      console.log("sheet quota, retrying", msg);
      await sleep(5000 * Math.pow(2, attempt));
      continue;
    }
    if (!res.ok) {
      console.log("sheet write error", msg);
      throw new Error(msg);
    }
    return data;
  }
  throw new Error("429 quota");
}
