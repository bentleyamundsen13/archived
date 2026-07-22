import { useEffect, useRef, useState } from "react";
import {
  firebaseReady,
  watchAuth,
  googleSignIn,
  emailSignUp,
  emailSignIn,
  logOut,
  getUserProfile,
  markTutorialSeen,
  migrateIfNeeded,
  watchCollections,
  watchItems,
  createCollection,
  updateCollectionMeta,
  deleteCollectionDoc,
  leaveCollection,
  joinByCode,
  addItemDoc,
  updateItemDoc,
  deleteItemDoc,
  setItemImage,
  deleteItemImage,
  addPhotoDoc,
  getItemPhotos,
  deletePhotoDoc,
  setAggregates,
  computeAggregates,
  addWishlistItem,
  watchWishlist,
  updateWishlistItem,
  deleteWishlistItem,
} from "./firebase.js";

/* ------------------------------------------------------------------ */
/*  Storage & helpers                                                  */
/* ------------------------------------------------------------------ */

const GUEST_KEY = "vitrine_guest_v2";
const THEME_KEY = "archived_theme";

function loadGuest() {
  try {
    const raw = localStorage.getItem(GUEST_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return { collections: [] };
}

const money = (n) =>
  Number(n || 0).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });

// Compact form for tight spots like the donut center: $1.3M, $45K, $322.
const compactMoney = (n) => {
  n = Number(n || 0);
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e4) return "$" + Math.round(n / 1e3) + "K";
  return "$" + Math.round(n).toLocaleString("en-US");
};

function resizeImage(file, maxSide = 1024, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", quality).split(",")[1]);
    };
    img.onerror = () => reject(new Error("Could not read that photo"));
    img.src = URL.createObjectURL(file);
  });
}

// Re-compress an existing data URL down to a small thumbnail (used when a
// full-size photo is promoted to be the item's main list image).
function shrinkDataUrl(dataUrl, maxSide = 256, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => reject(new Error("Could not process that photo"));
    img.src = dataUrl;
  });
}

// Guest collections still carry their items; cloud collections carry
// pre-computed aggregate stats. Normalize to one shape for stats UI.
function summarize(c) {
  return c.items ? { ...c, ...computeAggregates(c.items) } : c;
}

// Look up the current market price for an item. Returns { value, image, label }
// or null. Used both when adding an item and for the weekly price refresh.
async function priceLookup(brand, itemName, type) {
  const q = [brand, itemName].filter(Boolean).join(" ").trim();
  if (!q) return null;
  try {
    const r = await fetch(
      "/api/price?q=" + encodeURIComponent(q) + "&type=" + encodeURIComponent(type || "")
    );
    if (!r.ok) return null;
    const p = await r.json();
    if (typeof p.value === "number" && p.value > 0) {
      return { value: p.value, image: p.image || null, label: p.label || null };
    }
  } catch {}
  return null;
}

const PRICE_REFRESH_MS = 7 * 24 * 60 * 60 * 1000; // weekly

/* ------------------------------------------------------------------ */
/*  Root                                                               */
/* ------------------------------------------------------------------ */

export default function App() {
  const [user, setUser] = useState(null);
  const [guest, setGuest] = useState(false);
  const [authChecked, setAuthChecked] = useState(!firebaseReady);
  const [guestData, setGuestData] = useState({ collections: [] });
  const [guestLoaded, setGuestLoaded] = useState(false);
  const [cols, setCols] = useState(null);
  const [cloudWishlist, setCloudWishlist] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [tab, setTab] = useState("collections");
  const [toast, setToast] = useState("");
  const [showTutorial, setShowTutorial] = useState(false);
  const [theme, setTheme] = useState(() => localStorage.getItem(THEME_KEY) || "system");
  const toastTimer = useRef(null);

  // Apply theme
  useEffect(() => {
    localStorage.setItem(THEME_KEY, theme);
    const apply = () => {
      const dark =
        theme === "dark" ||
        (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
      document.documentElement.dataset.theme = dark ? "dark" : "light";
    };
    apply();
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme]);

  useEffect(() => {
    const unsub = watchAuth((u) => {
      setUser(u);
      setAuthChecked(true);
    });
    return unsub;
  }, []);

  // Guest data lives in localStorage, same as always.
  useEffect(() => {
    if (user) {
      setGuestLoaded(false);
      return;
    }
    if (guest) {
      setGuestData(loadGuest());
      setGuestLoaded(true);
    } else {
      setGuestLoaded(false);
      setGuestData({ collections: [] });
      setOpenId(null);
      setTab("collections");
    }
  }, [user, guest]);

  useEffect(() => {
    if (guest && !user && guestLoaded) {
      localStorage.setItem(GUEST_KEY, JSON.stringify(guestData));
    }
  }, [guestData, guest, user, guestLoaded]);

  // Signed in: live-sync collections (after a one-time migration of any
  // legacy single-doc data).
  useEffect(() => {
    if (!user) {
      setCols(null);
      return;
    }
    let unsub = null;
    let dead = false;
    (async () => {
      try {
        await migrateIfNeeded(user);
      } catch (e) {
        console.error("Migration of older collections failed:", e);
        showToast(
          "Couldn't restore older collections: " + (e?.message || String(e))
        );
      }
      if (!dead) unsub = watchCollections(user.uid, setCols);
    })();
    return () => {
      dead = true;
      if (unsub) unsub();
      setCols(null);
    };
  }, [user]);

  // Signed in: live-sync the standalone wishlist.
  useEffect(() => {
    if (!user) {
      setCloudWishlist([]);
      return;
    }
    return watchWishlist(user.uid, setCloudWishlist);
  }, [user]);

  // Invite links: archivedcollections.netlify.app/?join=CODE
  useEffect(() => {
    if (!user) return;
    const code = new URLSearchParams(window.location.search).get("join");
    if (!code) return;
    window.history.replaceState(null, "", window.location.pathname);
    joinByCode(code, user)
      .then(() => showToast("You're in — the shared collection is now in your list."))
      .catch(() => showToast("Couldn't join — that invite may be invalid."));
  }, [user]);

  // Show the add-to-home-screen tip once per ACCOUNT (flag lives on the
  // user's doc, so it follows them across devices). Only on a phone browser,
  // and never when already running as an installed app.
  useEffect(() => {
    if (!user) return;
    const mobile = /iphone|ipad|ipod|android/i.test(navigator.userAgent);
    const standalone =
      window.matchMedia?.("(display-mode: standalone)").matches ||
      window.navigator.standalone;
    if (!mobile || standalone) return;
    let cancelled = false;
    getUserProfile(user.uid).then((p) => {
      if (!cancelled && !p.seenA2HS) setShowTutorial(true);
    });
    return () => {
      cancelled = true;
    };
  }, [user]);

  function dismissTutorial() {
    setShowTutorial(false);
    if (user) markTutorialSeen(user.uid);
  }

  function showToast(msg) {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 4000);
  }

  async function joinWithCode(code) {
    try {
      await joinByCode(code, user);
      showToast("Joined! The shared collection is now in your list.");
      return true;
    } catch {
      showToast("Couldn't join with that code — double-check it.");
      return false;
    }
  }

  if (!authChecked) return <div className="page center">Loading…</div>;
  if (!user && !guest) return <Landing onGuest={() => setGuest(true)} />;

  const cloud = !!user;
  const loaded = cloud ? cols !== null : guestLoaded;
  if (!loaded) return <div className="page center">Loading…</div>;

  const collections = cloud ? cols : guestData.collections;
  const wishlist = cloud ? cloudWishlist : guestData.wishlist || [];
  const open = collections.find((c) => c.id === openId);

  return (
    <div className="page with-tabbar">
      {tab === "collections" ? (
        open ? (
          <div className="screen" key={"col-" + open.id}>
            <CollectionPage
              col={open}
              cloud={cloud}
              user={user}
              setGuestData={setGuestData}
              showToast={showToast}
              onBack={() => setOpenId(null)}
            />
          </div>
        ) : (
          <div className="screen" key="home">
            <CollectionsHome
              collections={collections.map(summarize)}
              cloud={cloud}
              user={user}
              setGuestData={setGuestData}
              onJoin={cloud ? joinWithCode : null}
              onOpen={setOpenId}
            />
          </div>
        )
      ) : tab === "wishlist" ? (
        <div className="screen" key="wishlist">
          <WishlistPage
            cloud={cloud}
            user={user}
            wishlist={wishlist}
            setGuestData={setGuestData}
            showToast={showToast}
          />
        </div>
      ) : (
        <div className="screen" key="you">
          <YouPage
            user={user}
            guest={guest}
            collections={collections.map(summarize)}
            theme={theme}
            setTheme={setTheme}
            onSignOut={async () => {
              await logOut();
              setGuest(false);
            }}
          />
        </div>
      )}

      <nav className="tabbar">
        <button
          className={"tab" + (tab === "collections" ? " active" : "")}
          onClick={() => setTab("collections")}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <rect x="3.5" y="3.5" width="7" height="7" rx="1.6" />
            <rect x="13.5" y="3.5" width="7" height="7" rx="1.6" />
            <rect x="3.5" y="13.5" width="7" height="7" rx="1.6" />
            <rect x="13.5" y="13.5" width="7" height="7" rx="1.6" />
          </svg>
          Collections
        </button>
        <button
          className={"tab" + (tab === "wishlist" ? " active" : "")}
          onClick={() => setTab("wishlist")}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M12 20.5S3.5 15 3.5 8.9A4.4 4.4 0 0 1 12 6.9a4.4 4.4 0 0 1 8.5 2c0 6.1-8.5 11.6-8.5 11.6z" />
          </svg>
          Wishlist
        </button>
        <button
          className={"tab" + (tab === "you" ? " active" : "")}
          onClick={() => setTab("you")}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <circle cx="12" cy="8" r="3.6" />
            <path d="M4.5 20c1.4-3.2 4.2-4.8 7.5-4.8s6.1 1.6 7.5 4.8" />
          </svg>
          You
        </button>
      </nav>

      {toast && <div className="toast">{toast}</div>}
      {showTutorial && <AddToHomeScreen onClose={dismissTutorial} />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  First-run: add to home screen                                      */
/* ------------------------------------------------------------------ */

function AddToHomeScreen({ onClose }) {
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  return (
    <div className="tut-backdrop" onClick={onClose}>
      <div className="card tut-card" onClick={(e) => e.stopPropagation()}>
        <div className="tut-icon">📲</div>
        <div className="tut-title">Add Archived to your Home Screen</div>
        <p className="tut-blurb">
          Install it in a couple taps — it opens full-screen and feels like a
          real app, without the browser bars.
        </p>
        <ol className="tut-steps">
          {ios ? (
            <>
              <li>
                Tap the <b>Share</b> button
                <span className="tut-share">
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
                    <path d="M12 3v12M8 7l4-4 4 4" />
                    <path d="M6 12v7a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-7" />
                  </svg>
                </span>
                at the bottom of Safari.
              </li>
              <li>
                Scroll down and tap <b>Add to Home Screen</b>.
              </li>
              <li>
                Tap <b>Add</b> in the top corner.
              </li>
            </>
          ) : (
            <>
              <li>
                Tap the <b>⋮</b> menu in the corner of your browser.
              </li>
              <li>
                Tap <b>Add to Home screen</b> (or <b>Install app</b>).
              </li>
              <li>
                Tap <b>Add</b> to confirm.
              </li>
            </>
          )}
        </ol>
        <button className="btn dark" onClick={onClose}>
          Got it
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Landing                                                            */
/* ------------------------------------------------------------------ */

function Landing({ onGuest }) {
  const [mode, setMode] = useState("signin");
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const invited = new URLSearchParams(window.location.search).has("join");

  async function submit() {
    if (!agreed) return;
    setErr("");
    setBusy(true);
    try {
      if (mode === "signup") await emailSignUp(email, pw);
      else await emailSignIn(email, pw);
    } catch (e) {
      setErr(cleanAuthError(e));
    } finally {
      setBusy(false);
    }
  }

  async function google() {
    if (!agreed) return;
    setErr("");
    try {
      await googleSignIn();
    } catch (e) {
      setErr(cleanAuthError(e));
    }
  }

  return (
    <div className="page landing screen">
      <div className="landing-brand">Archived</div>
      <h1 className="landing-title">
        Every piece you own,
        <br />
        in its place.
      </h1>
      <p className="landing-about">
        Snap a photo. AI identifies it, values it, and files it into your
        collection.
      </p>

      <div className="auth-card">
        {invited && (
          <div className="setup-note">
            You've been invited to a shared collection — sign in and it'll be
            added automatically.
          </div>
        )}
        {firebaseReady ? (
          <>
            <label className="agree">
              <input
                type="checkbox"
                checked={agreed}
                onChange={(e) => setAgreed(e.target.checked)}
              />
              <span>
                I agree to the{" "}
                <a href="/privacy.html" target="_blank" rel="noreferrer">Privacy Policy</a>{" "}
                and{" "}
                <a href="/terms.html" target="_blank" rel="noreferrer">Terms of Use</a>.
              </span>
            </label>
            <button className="btn google" disabled={!agreed} onClick={google}>
              <GoogleMark /> Continue with Google
            </button>
            <div className="divider">
              <span>or</span>
            </div>
            <input
              className="input"
              type="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <input
              className="input"
              type="password"
              placeholder={mode === "signup" ? "Create a password" : "Password"}
              value={pw}
              onChange={(e) => setPw(e.target.value)}
            />
            {err && <div className="auth-error">{err}</div>}
            <button className="btn dark" disabled={busy || !email || pw.length < 6 || !agreed} onClick={submit}>
              {mode === "signup" ? "Create account" : "Log in"}
            </button>
            <button className="btn text" onClick={() => setMode(mode === "signup" ? "signin" : "signup")}>
              {mode === "signup" ? "Already have an account? Log in" : "New here? Create an account"}
            </button>
          </>
        ) : (
          <div className="setup-note">
            Accounts aren't set up yet — paste your Firebase config into{" "}
            <code>src/firebase.js</code> (steps in the README).
          </div>
        )}
        <button className="btn text" onClick={onGuest}>
          Continue without an account →
        </button>
      </div>
    </div>
  );
}

function cleanAuthError(e) {
  const code = e?.code || "";
  if (code.includes("invalid-credential") || code.includes("wrong-password"))
    return "Wrong email or password.";
  if (code.includes("email-already-in-use"))
    return "That email already has an account — log in instead.";
  if (code.includes("weak-password")) return "Password needs at least 6 characters.";
  if (code.includes("popup-closed")) return "Sign-in window was closed.";
  return "Couldn't sign in — check your connection and try again.";
}

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.5l6.7-6.7C35.6 2.4 30.2 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.8 6.1C12.3 13.1 17.7 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4.1 7.1-10.1 7.1-17.5z" />
      <path fill="#FBBC05" d="M10.4 28.7A14.5 14.5 0 0 1 9.6 24c0-1.6.3-3.2.8-4.7l-7.8-6.1A24 24 0 0 0 0 24c0 3.9.9 7.5 2.6 10.8l7.8-6.1z" />
      <path fill="#34A853" d="M24 48c6.2 0 11.4-2 15.4-5.6l-7.5-5.8c-2.1 1.4-4.8 2.3-7.9 2.3-6.3 0-11.7-3.6-13.6-8.8l-7.8 6.1C6.5 42.6 14.6 48 24 48z" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/*  Collections home                                                   */
/* ------------------------------------------------------------------ */

function CollectionsHome({ collections, cloud, user, setGuestData, onJoin, onOpen }) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  async function join() {
    setBusy(true);
    try {
      if (await onJoin(code.trim())) {
        setCreating(false);
        setCode("");
      }
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    if (cloud) {
      setBusy(true);
      try {
        const cid = await createCollection(user, name.trim(), type.trim() || "General");
        onOpen(cid);
      } catch {
        alert("Couldn't create the collection — check your connection.");
      } finally {
        setBusy(false);
      }
    } else {
      const col = {
        id: crypto.randomUUID(),
        name: name.trim(),
        type: type.trim() || "General",
        items: [],
      };
      setGuestData((d) => ({ ...d, collections: [...d.collections, col] }));
      onOpen(col.id);
    }
    setCreating(false);
    setName("");
    setType("");
  }

  return (
    <>
      <header className="topbar">
        <h1>Your Collections</h1>
        <button className="btn dark small" onClick={() => setCreating(true)}>
          + Create
        </button>
      </header>

      {creating && (
        <div className="card form pop">
          <input
            className="input"
            autoFocus
            placeholder="Collection name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            className="input"
            placeholder="Type — Records, Cards, Sneakers…"
            value={type}
            onChange={(e) => setType(e.target.value)}
          />
          <div className="row">
            <button className="btn light" onClick={() => setCreating(false)}>
              Cancel
            </button>
            <button className="btn dark" disabled={!name.trim() || busy} onClick={create}>
              {busy ? <span className="spinner" /> : "Create"}
            </button>
          </div>
          {onJoin && (
            <>
              <div className="divider">
                <span>or</span>
              </div>
              <label className="label">Join a shared collection</label>
              <input
                className="input code-input"
                placeholder="Invite code"
                maxLength={8}
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
              />
              <button
                className="btn dark"
                disabled={code.trim().length !== 8 || busy}
                onClick={join}
              >
                {busy ? <span className="spinner" /> : "Join collection"}
              </button>
            </>
          )}
        </div>
      )}

      {collections.length === 0 && !creating && (
        <div className="empty">
          <p>No collections yet.</p>
        </div>
      )}

      <main className="list">
        {collections.map((c, idx) => (
          <button
            key={c.id}
            className="card row-card rise"
            style={{ animationDelay: `${Math.min(idx * 45, 300)}ms` }}
            onClick={() => onOpen(c.id)}
          >
            <div className="thumb-stack">
              {c.coverImage ? (
                <img className="thumb" src={c.coverImage} alt="" onError={(e) => (e.target.style.display = "none")} />
              ) : (
                <div className="thumb ph">{c.name[0]?.toUpperCase()}</div>
              )}
            </div>
            <div className="grow">
              <div className="card-title">{c.name}</div>
              <div className="card-sub">
                {c.itemCount} {c.itemCount === 1 ? "item" : "items"}
                {c.members && c.members.length > 1
                  ? ` · shared with ${c.members.length - 1}`
                  : ""}
              </div>
            </div>
            <div className="card-value">{money(c.totalValue)}</div>
          </button>
        ))}
      </main>

    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Collection page                                                    */
/* ------------------------------------------------------------------ */

function CollectionPage({ col, cloud, user, setGuestData, showToast, onBack }) {
  const camRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [detailId, setDetailId] = useState(null);
  const [detailClosing, setDetailClosing] = useState(false);
  const [detailPhotos, setDetailPhotos] = useState([]);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [detailHistory, setDetailHistory] = useState([]);
  const addPhotoRef = useRef(null);
  const [reveal, setReveal] = useState(null);
  const [sharing, setSharing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [editingCol, setEditingCol] = useState(false);
  const [colName, setColName] = useState("");
  const [colType, setColType] = useState("");
  const [cloudItems, setCloudItems] = useState(null);
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState("recent");
  const revealTimers = useRef([]);
  const detailIdRef = useRef(null);

  useEffect(() => {
    if (!cloud) return;
    return watchItems(col.id, setCloudItems);
  }, [cloud, col.id]);

  useEffect(() => () => revealTimers.current.forEach(clearTimeout), []);

  const items = cloud ? cloudItems || [] : col.items;
  const itemsReady = !cloud || cloudItems !== null;
  const detailItem = detailId ? items.find((i) => i.id === detailId) : null;
  const isOwner = !cloud || col.owner === user?.uid;
  const total = items.reduce((s, i) => s + (Number(i.estimated_value_usd) || 0), 0);

  // Search + sort. "recent" keeps the natural newest-first order; the search
  // bar only appears once a collection is big enough to need it.
  const q = search.trim().toLowerCase();
  let visibleItems = q
    ? items.filter((it) =>
        `${it.item_name || ""} ${it.brand || ""}`.toLowerCase().includes(q)
      )
    : items;
  if (sortBy === "value") {
    visibleItems = [...visibleItems].sort(
      (a, b) => (b.estimated_value_usd || 0) - (a.estimated_value_usd || 0)
    );
  } else if (sortBy === "name") {
    visibleItems = [...visibleItems].sort((a, b) =>
      (a.item_name || "").localeCompare(b.item_name || "")
    );
  }
  const showFilterBar = items.length > 4;

  function patchGuest(fn) {
    setGuestData((d) => ({
      ...d,
      collections: d.collections.map((c) => (c.id === col.id ? fn(c) : c)),
    }));
  }

  function showReveal(item) {
    revealTimers.current.forEach(clearTimeout);
    setReveal({ item, out: false });
    revealTimers.current = [
      setTimeout(() => setReveal((r) => (r ? { ...r, out: true } : r)), 1800),
      setTimeout(() => setReveal(null), 2160),
    ];
  }

  async function addPhoto(file) {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const imageBase64 = await resizeImage(file);
      const res = await fetch("/api/identify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category: col.type, imageBase64, mime: "image/jpeg" }),
      });
      const out = await res.json();
      if (!res.ok || out.error) throw new Error(out.error || `Server error ${res.status}`);
      const item = {
        ...out.item,
        id: crypto.randomUUID(),
        added: new Date().toISOString().slice(0, 10),
        created: Date.now(),
      };
      const fullImage = "data:image/jpeg;base64," + imageBase64;
      const photoId = crypto.randomUUID();
      item.mainPhotoId = photoId;
      // Cards show a small thumbnail of the MAIN photo; full-quality photos
      // live one-per-record and are only fetched when the card opens.
      try {
        item.image_url =
          "data:image/jpeg;base64," + (await resizeImage(file, 256, 0.72));
      } catch {}
      try {
        const q = [item.brand, item.item_name].filter(Boolean).join(" ").trim();
        if (q) {
          const pr = await fetch(
            "/api/price?q=" + encodeURIComponent(q) +
              "&type=" + encodeURIComponent(col.type || "")
          );
          if (pr.ok) {
            const p = await pr.json();
            if (p.value) {
              item.estimated_value_usd = p.value;
              item.value_source = "market";
              item.market_label = p.label;
              // First point on the item's price history graph.
              item.priceHistory = [{ t: Date.now(), v: p.value }];
              item.priceLastChecked = Date.now();
            }
          }
        }
      } catch {}

      if (cloud) {
        await addItemDoc(col.id, item);
        try {
          await addPhotoDoc(col.id, item.id, { id: photoId, data: fullImage });
        } catch {}
        try {
          await setAggregates(col.id, [item, ...items]);
        } catch {}
      } else {
        item.photos = [{ id: photoId, data: fullImage, created: Date.now() }];
        patchGuest((c) => ({ ...c, items: [item, ...c.items] }));
      }
      showReveal({ ...item, image_url: fullImage });
    } catch (e) {
      setError(e.message || "Something went wrong — try another photo.");
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit(itemId, fields) {
    setEditingId(null);
    if (cloud) {
      try {
        await updateItemDoc(col.id, itemId, { ...fields, edited: true });
        await setAggregates(
          col.id,
          items.map((i) => (i.id === itemId ? { ...i, ...fields } : i))
        );
      } catch {
        showToast("Couldn't save that change — check your connection.");
      }
    } else {
      patchGuest((c) => ({
        ...c,
        items: c.items.map((i) => (i.id === itemId ? { ...i, ...fields, edited: true } : i)),
      }));
    }
  }

  async function removeItem(itemId) {
    if (cloud) {
      try {
        await deleteItemDoc(col.id, itemId);
        await deleteItemImage(col.id, itemId);
        await setAggregates(col.id, items.filter((i) => i.id !== itemId));
      } catch {
        showToast("Couldn't remove that item — check your connection.");
      }
    } else {
      patchGuest((c) => ({ ...c, items: c.items.filter((i) => i.id !== itemId) }));
    }
  }

  async function removeCollection() {
    if (!confirm("Delete this collection and everything in it?")) return;
    if (cloud) {
      try {
        for (const it of items) {
          await deleteItemDoc(col.id, it.id);
          await deleteItemImage(col.id, it.id);
        }
        await deleteCollectionDoc(col.id);
      } catch {
        showToast("Couldn't delete the collection — check your connection.");
        return;
      }
    } else {
      setGuestData((d) => ({
        ...d,
        collections: d.collections.filter((c) => c.id !== col.id),
      }));
    }
    onBack();
  }

  async function leaveShared() {
    if (!confirm("Leave this shared collection? You can rejoin later with the invite code.")) return;
    try {
      await leaveCollection(col.id, user);
      onBack();
    } catch {
      showToast("Couldn't leave the collection — check your connection.");
    }
  }

  async function saveColEdit() {
    const fields = { name: colName.trim(), type: colType.trim() || "General" };
    setEditingCol(false);
    if (cloud) {
      try {
        await updateCollectionMeta(col.id, fields);
      } catch {
        showToast("Couldn't save the collection details — check your connection.");
      }
    } else {
      patchGuest((c) => ({ ...c, ...fields }));
    }
  }


  // Order photos so the main one comes first, then oldest→newest.
  function orderPhotos(photos, mainId) {
    return [...photos].sort((a, b) => {
      if (a.id === mainId) return -1;
      if (b.id === mainId) return 1;
      return (a.created || 0) - (b.created || 0);
    });
  }

  // Tapping an item opens the same rich card that appears after adding.
  async function openDetail(it) {
    detailIdRef.current = it.id;
    setDetailId(it.id);
    setDetailClosing(false);
    setDetailHistory(it.priceHistory || []);
    // Once a week, refresh the market value and add a point to the graph.
    if (Date.now() - (it.priceLastChecked || 0) > PRICE_REFRESH_MS) {
      refreshItemPrice(it);
    }
    // Start with the thumbnail so something shows instantly, then swap in
    // the full-quality photo set.
    setDetailPhotos(it.image_url ? [{ id: "thumb", data: it.image_url }] : []);
    let photos = [];
    if (cloud) {
      try {
        photos = await getItemPhotos(col.id, it.id);
      } catch {}
    } else {
      photos =
        it.photos && it.photos.length
          ? it.photos
          : it.image_url
          ? [{ id: "legacy", data: it.image_url, created: 0 }]
          : [];
    }
    if (detailIdRef.current === it.id && photos.length) {
      setDetailPhotos(orderPhotos(photos, it.mainPhotoId));
    }
  }

  function closeDetail() {
    detailIdRef.current = null;
    setDetailClosing(true);
    setTimeout(() => {
      setDetailId(null);
      setDetailClosing(false);
      setDetailPhotos([]);
    }, 220);
  }

  // For Edit/Remove: dismiss instantly so the editor/list is visible.
  function closeDetailNow() {
    detailIdRef.current = null;
    setDetailId(null);
    setDetailClosing(false);
    setDetailPhotos([]);
  }

  function persistPriceFields(itemId, fields) {
    if (cloud) {
      updateItemDoc(col.id, itemId, fields).catch(() => {});
      setAggregates(
        col.id,
        items.map((i) => (i.id === itemId ? { ...i, ...fields } : i))
      ).catch(() => {});
    } else {
      patchGuest((c) => ({
        ...c,
        items: c.items.map((i) => (i.id === itemId ? { ...i, ...fields } : i)),
      }));
    }
  }

  // Weekly market-value refresh: append a point to the item's price history
  // and update its current value. Stamps the check time either way so a
  // failed lookup doesn't re-hit eBay on every open.
  async function refreshItemPrice(it) {
    const now = Date.now();
    const res = await priceLookup(it.brand, it.item_name, col.type);
    if (!res) {
      persistPriceFields(it.id, { priceLastChecked: now });
      return;
    }
    const history = [...(it.priceHistory || []), { t: now, v: res.value }].slice(-260);
    persistPriceFields(it.id, {
      estimated_value_usd: res.value,
      value_source: "market",
      market_label: res.label || it.market_label || null,
      priceHistory: history,
      priceLastChecked: now,
    });
    if (detailIdRef.current === it.id) setDetailHistory(history);
  }

  // Add another photo to the open item.
  async function addPhotoToItem(file) {
    if (!file || !detailItem) return;
    if (detailPhotos.filter((p) => p.id !== "thumb").length >= 5) {
      showToast("Up to 5 photos per item.");
      return;
    }
    setPhotoBusy(true);
    try {
      const full = "data:image/jpeg;base64," + (await resizeImage(file, 1024, 0.72));
      const photoId = crypto.randomUUID();
      const created = Date.now();

      if (cloud) {
        // The original photo (if any) stays where it is and is always merged
        // back in on load, so nothing is lost — just add the new one.
        await addPhotoDoc(col.id, detailItem.id, { id: photoId, data: full, created });
      } else {
        // Guests have no separate store, so fold the original thumbnail into
        // the photos list the first time a second photo is added.
        const legacy = detailPhotos.find((p) => p.id === "legacy");
        const legacyId = legacy ? crypto.randomUUID() : null;
        const base =
          detailItem.photos && detailItem.photos.length
            ? detailItem.photos
            : legacy
            ? [{ id: legacyId, data: legacy.data, created: 1 }]
            : [];
        const next = [...base, { id: photoId, data: full, created }];
        const fields = legacy ? { photos: next, mainPhotoId: legacyId } : { photos: next };
        patchGuest((c) => ({
          ...c,
          items: c.items.map((i) => (i.id === detailItem.id ? { ...i, ...fields } : i)),
        }));
        setDetailPhotos((prev) => {
          let arr = prev.filter((p) => p.id !== "thumb");
          if (legacyId) arr = arr.map((p) => (p.id === "legacy" ? { ...p, id: legacyId } : p));
          return [...arr, { id: photoId, data: full, created }];
        });
        return;
      }

      setDetailPhotos((prev) => [
        ...prev.filter((p) => p.id !== "thumb"),
        { id: photoId, data: full, created },
      ]);
    } catch {
      showToast("Couldn't add that photo — try again.");
    } finally {
      setPhotoBusy(false);
    }
  }

  // Make a photo the item's main one (shown in lists + first in the card).
  async function makeMainPhoto(photo) {
    if (!detailItem || photo.id === "thumb") return;
    let thumb = photo.data;
    try {
      thumb = await shrinkDataUrl(photo.data, 256, 0.72);
    } catch {}
    const fields = { mainPhotoId: photo.id, image_url: thumb };
    if (cloud) {
      try {
        await updateItemDoc(col.id, detailItem.id, fields);
        await setAggregates(
          col.id,
          items.map((i) => (i.id === detailItem.id ? { ...i, ...fields } : i))
        );
      } catch {
        showToast("Couldn't set the main photo — check your connection.");
        return;
      }
    } else {
      patchGuest((c) => ({
        ...c,
        items: c.items.map((i) => (i.id === detailItem.id ? { ...i, ...fields } : i)),
      }));
    }
    setDetailPhotos((prev) => orderPhotos(prev, photo.id));
  }

  // Remove one photo; if it was the main one, the next becomes main.
  async function removePhoto(photo) {
    if (!detailItem) return;
    const remaining = detailPhotos.filter((p) => p.id !== photo.id);
    const wasMain = detailItem.mainPhotoId === photo.id;
    const newMain = wasMain ? remaining[0] : null;
    let fields = {};
    if (newMain) {
      let thumb = newMain.data;
      try {
        thumb = await shrinkDataUrl(newMain.data, 256, 0.72);
      } catch {}
      fields = { mainPhotoId: newMain.id, image_url: thumb };
    } else if (wasMain) {
      fields = { mainPhotoId: null, image_url: null };
    }
    if (cloud) {
      try {
        if (photo.id !== "legacy") await deletePhotoDoc(col.id, detailItem.id, photo.id);
        else await deleteItemImage(col.id, detailItem.id);
        if (Object.keys(fields).length) {
          await updateItemDoc(col.id, detailItem.id, fields);
          await setAggregates(
            col.id,
            items.map((i) => (i.id === detailItem.id ? { ...i, ...fields } : i))
          );
        }
      } catch {
        showToast("Couldn't remove that photo — check your connection.");
        return;
      }
    } else {
      patchGuest((c) => ({
        ...c,
        items: c.items.map((i) =>
          i.id === detailItem.id
            ? { ...i, photos: (i.photos || []).filter((p) => p.id !== photo.id), ...fields }
            : i
        ),
      }));
    }
    setDetailPhotos(orderPhotos(remaining, newMain ? newMain.id : detailItem.mainPhotoId));
  }

  function copyInvite() {
    const link = `${window.location.origin}/?join=${col.joinCode}`;
    const text = `Join my “${col.name}” collection on Archived: ${link}`;
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {});
  }

  return (
    <>
      <button className="link back" onClick={onBack}>
        ← Collections
      </button>
      <header className="topbar">
        <div>
          <div className="topbar-title-row">
            <h1>{col.name}</h1>
            <button
              className="icon-btn"
              aria-label="Edit collection"
              onClick={() => {
                setColName(col.name);
                setColType(col.type);
                setEditingCol(true);
              }}
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
              </svg>
            </button>
          </div>
          <div className="card-sub">
            {col.type} · {items.length}
            {cloud && col.members?.length > 1 ? ` · ${col.members.length} collectors` : ""}
          </div>
        </div>
        <div className="topbar-total">
          <div className="topbar-total-num">{money(total)}</div>
        </div>
      </header>

      {editingCol && (
        <div className="card form pop">
          <label className="label">Collection name</label>
          <input
            className="input"
            autoFocus
            value={colName}
            onChange={(e) => setColName(e.target.value)}
          />
          <label className="label">Type</label>
          <input
            className="input"
            placeholder="Records, Cards, Sneakers…"
            value={colType}
            onChange={(e) => setColType(e.target.value)}
          />
          <div className="row">
            <button className="btn light" onClick={() => setEditingCol(false)}>
              Cancel
            </button>
            <button className="btn dark" disabled={!colName.trim()} onClick={saveColEdit}>
              Save
            </button>
          </div>
        </div>
      )}

      <div className="add-row">
        <button className="btn dark big grow" disabled={busy} onClick={() => camRef.current?.click()}>
          {busy ? <span className="spinner" /> : "+ Add Item"}
        </button>
        {cloud && (
          <button className="btn light big share-box" onClick={() => setSharing(true)} aria-label="Share collection">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <circle cx="6" cy="12" r="2.6" />
              <circle cx="17.5" cy="5.5" r="2.6" />
              <circle cx="17.5" cy="18.5" r="2.6" />
              <path d="M8.4 10.8l6.8-4M8.4 13.2l6.8 4" />
            </svg>
          </button>
        )}
      </div>
      <input
        ref={camRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => {
          addPhoto(e.target.files?.[0]);
          e.target.value = "";
        }}
      />

      {error && <div className="error pop">{error}</div>}

      {itemsReady && showFilterBar && (
        <div className="filter-bar">
          <input
            className="input search-input"
            placeholder="Search items…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="sort-pills">
            {[
              ["recent", "Recent"],
              ["value", "Value"],
              ["name", "Name"],
            ].map(([k, label]) => (
              <button
                key={k}
                className={"sort-pill" + (sortBy === k ? " active" : "")}
                onClick={() => setSortBy(k)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {!itemsReady ? (
        <div className="center">Loading…</div>
      ) : (
        <main className="list">
          {visibleItems.map((it, idx) =>
            editingId === it.id ? (
              <ItemEditor
                key={it.id}
                item={it}
                onSave={(fields) => saveEdit(it.id, fields)}
                onCancel={() => setEditingId(null)}
              />
            ) : (
              <article
                key={it.id}
                className="card item rise"
                style={{ animationDelay: `${Math.min(idx * 45, 300)}ms` }}
                onClick={() => openDetail(it)}
              >
                <div className="item-row">
                  {it.image_url ? (
                    <img
                      className="thumb"
                      src={it.image_url}
                      alt=""
                      onError={(e) => (e.target.style.display = "none")}
                    />
                  ) : (
                    <div className="thumb ph">{(it.item_name || "?")[0]?.toUpperCase()}</div>
                  )}
                  <div className="grow">
                    <div className="card-title">{it.item_name || "Unidentified"}</div>
                    <div className="card-sub">
                      {it.brand || "Unknown"}
                      {it.release_year ? ` · ${it.release_year}` : ""}
                    </div>
                  </div>
                  <div className="card-value">{money(it.estimated_value_usd)}</div>
                </div>
              </article>
            )
          )}
        </main>
      )}

      {itemsReady && items.length === 0 && !busy && (
        <div className="empty">
          <p>Add your first item.</p>
        </div>
      )}

      {itemsReady && items.length > 0 && visibleItems.length === 0 && (
        <div className="empty">
          <p>No matches.</p>
        </div>
      )}

      {isOwner ? (
        <button className="link danger footer-del" onClick={removeCollection}>
          Delete collection
        </button>
      ) : (
        <button className="link danger footer-del" onClick={leaveShared}>
          Leave collection
        </button>
      )}

      {sharing && cloud && (
        <div className="sheet-backdrop" onClick={() => setSharing(false)}>
          <div className="card share-sheet pop" onClick={(e) => e.stopPropagation()}>
            <div className="card-title">Share “{col.name}”</div>
            <p className="share-blurb">
              Anyone with this code becomes a collector: they see every item,
              can add their own, and the collection counts toward their totals
              too.
            </p>
            <div className="join-code">{col.joinCode}</div>
            <button className="btn dark" onClick={copyInvite}>
              {copied ? "Link copied ✓" : "Copy invite link"}
            </button>
            <div className="settings-label">Collectors</div>
            <div className="collectors">
              {Object.entries(col.memberNames || {}).map(([uid, nm]) => (
                <div key={uid} className="collector-row">
                  <span className="collector-dot" />
                  {nm}
                  {uid === col.owner ? " · owner" : ""}
                  {uid === user.uid ? " · you" : ""}
                </div>
              ))}
            </div>
            <button className="btn light" onClick={() => setSharing(false)}>
              Done
            </button>
          </div>
        </div>
      )}

      {reveal && (
        <div className={"reveal-backdrop" + (reveal.out ? " out" : "")}>
          <div className="card reveal-card">
            {reveal.item.image_url && (
              <img className="reveal-img" src={reveal.item.image_url} alt="" />
            )}
            <div className="reveal-added">Added to {col.name}</div>
            <div className="reveal-name">{reveal.item.item_name || "Unidentified"}</div>
            <div className="card-sub">
              {reveal.item.brand || "Unknown"}
              {reveal.item.release_year ? ` · ${reveal.item.release_year}` : ""}
            </div>
            {reveal.item.notable_details && (
              <p className="item-notes">{reveal.item.notable_details}</p>
            )}
            <div className="reveal-row">
              <span className="reveal-value">{money(reveal.item.estimated_value_usd)}</span>
              <span className="card-sub">{reveal.item.condition || ""}</span>
            </div>
          </div>
        </div>
      )}

      {detailItem && (
        <div
          className={"reveal-backdrop tappable" + (detailClosing ? " out-detail" : "")}
          onClick={closeDetail}
        >
          <div className="card reveal-card" onClick={(e) => e.stopPropagation()}>
            <PhotoCarousel
              photos={detailPhotos}
              mainId={
                detailItem.mainPhotoId ||
                detailPhotos.find((p) => p.id !== "thumb")?.id
              }
              onSetMain={makeMainPhoto}
              onRemovePhoto={removePhoto}
              onAddPhoto={() => addPhotoRef.current?.click()}
              adding={photoBusy}
            />
            <input
              ref={addPhotoRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                addPhotoToItem(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            <div className="reveal-name">{detailItem.item_name || "Unidentified"}</div>
            <div className="card-sub">
              {detailItem.brand || "Unknown"}
              {detailItem.release_year ? ` · ${detailItem.release_year}` : ""}
            </div>
            {detailItem.notable_details && (
              <p className="item-notes">{detailItem.notable_details}</p>
            )}
            <div className="item-meta">
              {detailItem.condition || "Condition unknown"} · {detailItem.added}
              {detailItem.edited
                ? " · edited"
                : detailItem.market_label
                ? ` · ${detailItem.market_label}`
                : " · AI estimate"}
            </div>
            <div className="reveal-row">
              <span className="reveal-value">{money(detailItem.estimated_value_usd)}</span>
              {detailItem.market_label && (
                <span className="card-sub">{detailItem.market_label}</span>
              )}
            </div>
            {detailItem.listing_url && (
              <a
                className="btn light listing-link"
                href={detailItem.listing_url}
                target="_blank"
                rel="noreferrer"
              >
                View listing ↗
              </a>
            )}
            <PriceGraph history={detailHistory} />
            <div className="row detail-actions">
              <button
                className="btn light"
                onClick={() => {
                  const id = detailItem.id;
                  closeDetailNow();
                  setEditingId(id);
                }}
              >
                Edit
              </button>
              <button
                className="btn light danger-text"
                onClick={() => {
                  const id = detailItem.id;
                  closeDetailNow();
                  removeItem(id);
                }}
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}

    </>
  );
}

/* ------------------------------------------------------------------ */
/*  You page + settings                                                */
/* ------------------------------------------------------------------ */

function YouPage({ user, guest, collections, theme, setTheme, onSignOut }) {
  const [showSettings, setShowSettings] = useState(false);

  const totalValue = collections.reduce((s, c) => s + (c.totalValue || 0), 0);
  const totalItems = collections.reduce((s, c) => s + (c.itemCount || 0), 0);
  const top = collections.reduce(
    (best, c) =>
      (c.topItemValue || 0) > (best?.value || 0)
        ? { name: c.topItemName, value: c.topItemValue }
        : best,
    null
  );

  // Value contributed by each collection type, biggest first. Beyond 5 types
  // the rest fold into "Other" so the donut stays readable; colors are
  // assigned in fixed palette order (never cycled).
  const byType = {};
  for (const c of collections) {
    const t = (c.type || "General").trim() || "General";
    byType[t] = (byType[t] || 0) + (c.totalValue || 0);
  }
  const ranked = Object.entries(byType)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
  let typeSlices;
  if (ranked.length > 6) {
    const head = ranked.slice(0, 5);
    const otherVal = ranked.slice(5).reduce((s, [, v]) => s + v, 0);
    typeSlices = [
      ...head.map(([name, value], i) => ({ name, value, color: `var(--cat-${i + 1})` })),
      { name: "Other", value: otherVal, color: "var(--cat-other)" },
    ];
  } else {
    typeSlices = ranked.map(([name, value], i) => ({
      name,
      value,
      color: `var(--cat-${i + 1})`,
    }));
  }
  const showPie = typeSlices.length >= 2;

  if (showSettings) {
    return (
      <div className="screen" key="settings">
        <button className="link back" onClick={() => setShowSettings(false)}>
          ← You
        </button>
        <header className="topbar">
          <h1>Settings</h1>
        </header>

        <div className="settings-group">
          <div className="settings-label">Appearance</div>
          <div className="segmented">
            {["light", "system", "dark"].map((t) => (
              <button
                key={t}
                className={"seg" + (theme === t ? " active" : "")}
                onClick={() => setTheme(t)}
              >
                {t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
        </div>

        <div className="settings-group">
          <div className="settings-label">Account</div>
          <div className="card settings-card">
            <div className="card-sub">
              {user ? user.email : "Guest — data is saved on this device only"}
            </div>
            <button className="btn light" onClick={onSignOut}>
              {user ? "Sign out" : "Exit guest mode"}
            </button>
          </div>
        </div>

        <p className="fineprint">
          Item values are AI or marketplace estimates for personal reference,
          not certified appraisals.
        </p>
      </div>
    );
  }

  return (
    <>
      <header className="topbar">
        <h1>You</h1>
        <button className="icon-btn" onClick={() => setShowSettings(true)} aria-label="Settings">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <circle cx="12" cy="12" r="3.2" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z" />
          </svg>
        </button>
      </header>

      <div className="profile">
        {user?.photoURL ? (
          <img className="avatar" src={user.photoURL} alt="" referrerPolicy="no-referrer" />
        ) : (
          <div className="avatar ph">
            {(user?.displayName || user?.email || "G")[0].toUpperCase()}
          </div>
        )}
        <div>
          <div className="profile-name">{user ? user.displayName || "Collector" : "Guest"}</div>
          <div className="card-sub">{user ? user.email : "On this device"}</div>
        </div>
      </div>

      <div className="stats">
        <div className="stat card rise">
          <div className="stat-num">{money(totalValue)}</div>
          <div className="stat-label">Total value</div>
        </div>
        <div className="stat card rise" style={{ animationDelay: "60ms" }}>
          <div className="stat-num">{collections.length}</div>
          <div className="stat-label">Collections</div>
        </div>
        <div className="stat card rise" style={{ animationDelay: "120ms" }}>
          <div className="stat-num">{totalItems}</div>
          <div className="stat-label">Items</div>
        </div>
        <div className="stat card rise" style={{ animationDelay: "180ms" }}>
          <div className="stat-num small">{top ? top.name : "—"}</div>
          <div className="stat-label">Top item{top ? ` · ${money(top.value)}` : ""}</div>
        </div>
      </div>

      {showPie && (
        <div className="card pie-card rise" style={{ animationDelay: "220ms" }}>
          <div className="pie-card-label">Value by type</div>
          <ValuePieChart slices={typeSlices} total={totalValue} />
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Value-by-type donut                                                */
/* ------------------------------------------------------------------ */

function ValuePieChart({ slices, total }) {
  const gap = slices.length > 1 ? 1.4 : 0; // 2px surface gap between slices
  let cum = 0;
  const segs = slices.map((s) => {
    const pct = total > 0 ? (s.value / total) * 100 : 0;
    const seg = { ...s, pct, start: cum, dash: Math.max(pct - gap, 0.4) };
    cum += pct;
    return seg;
  });

  return (
    <div className="pie-wrap">
      <svg className="pie" viewBox="0 0 120 120" role="img" aria-label="Value by collection type">
        <g transform="rotate(-90 60 60)">
          {segs.map((s) => (
            <circle
              key={s.name}
              cx="60"
              cy="60"
              r="42"
              fill="none"
              stroke={s.color}
              strokeWidth="15"
              pathLength="100"
              strokeDasharray={`${s.dash} ${100 - s.dash}`}
              transform={`rotate(${s.start * 3.6} 60 60)`}
            />
          ))}
        </g>
        <text x="60" y="58" className="pie-total" textAnchor="middle">
          {compactMoney(total)}
        </text>
        <text x="60" y="72" className="pie-total-label" textAnchor="middle">
          Total
        </text>
      </svg>
      <div className="pie-legend">
        {segs.map((s) => (
          <div className="pie-legend-row" key={s.name}>
            <span className="pie-dot" style={{ background: s.color }} />
            <span className="pie-legend-name">{s.name}</span>
            <span className="pie-legend-val">
              {money(s.value)} · {Math.round(s.pct)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Price history graph (inside the item card)                         */
/* ------------------------------------------------------------------ */

function PriceGraph({ history }) {
  const [range, setRange] = useState("ALL");
  const RANGES = [
    ["1M", 30 * 864e5],
    ["6M", 182 * 864e5],
    ["1Y", 365 * 864e5],
    ["ALL", Infinity],
  ];

  if (!history || history.length < 2) {
    return (
      <div className="graph-empty">
        📈 Price history builds over time — a new point is added each week as
        the value updates.
      </div>
    );
  }

  const now = Date.now();
  const span = RANGES.find(([k]) => k === range)[1];
  const inRange = history
    .filter((p) => p && typeof p.v === "number")
    .filter((p) => span === Infinity || now - p.t <= span)
    .sort((a, b) => a.t - b.t);
  // Fall back to the full series if the chosen window has too few points yet.
  const draw = inRange.length >= 2 ? inRange : [...history].sort((a, b) => a.t - b.t);

  const W = 300, H = 116, padX = 5, padTop = 10, padBot = 16;
  const ts = draw.map((p) => p.t);
  const vs = draw.map((p) => p.v);
  const minT = Math.min(...ts), maxT = Math.max(...ts);
  let minV = Math.min(...vs), maxV = Math.max(...vs);
  if (minV === maxV) { minV -= 1; maxV += 1; }
  const X = (t) => padX + (maxT === minT ? 0.5 : (t - minT) / (maxT - minT)) * (W - padX * 2);
  const Y = (v) => padTop + (1 - (v - minV) / (maxV - minV)) * (H - padTop - padBot);

  const line = draw.map((p) => `${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join(" ");
  const area = `${padX},${H - padBot} ${line} ${W - padX},${H - padBot}`;
  const first = draw[0].v, last = draw[draw.length - 1].v;
  const changePct = first > 0 ? ((last - first) / first) * 100 : 0;
  const up = last >= first;
  const dir = up ? "up" : "down";
  const fmt = (t) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });

  return (
    <div className="graph">
      <div className="graph-head">
        <span className="graph-label">Value history</span>
        <span className={"graph-change " + dir}>
          {up ? "▲" : "▼"} {Math.abs(changePct).toFixed(1)}%
        </span>
      </div>
      <svg className={"graph-svg " + dir} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Price history">
        <polygon className="graph-area" points={area} />
        <polyline className="graph-line" points={line} vectorEffect="non-scaling-stroke" />
        <circle className="graph-dot" cx={X(maxT)} cy={Y(last)} r="3.5" />
      </svg>
      <div className="graph-axis">
        <span>{fmt(minT)}</span>
        <span>{fmt(maxT)}</span>
      </div>
      <div className="graph-ranges">
        {RANGES.map(([k]) => (
          <button
            key={k}
            className={"graph-range" + (range === k ? " active" : "")}
            onClick={() => setRange(k)}
          >
            {k}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Photo carousel (inside the item card)                              */
/* ------------------------------------------------------------------ */

function PhotoCarousel({ photos, mainId, onSetMain, onRemovePhoto, onAddPhoto, adding }) {
  const trackRef = useRef(null);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (index > photos.length - 1) setIndex(Math.max(0, photos.length - 1));
  }, [photos.length]); // eslint-disable-line react-hooks/exhaustive-deps

  function onScroll() {
    const el = trackRef.current;
    if (!el || !el.clientWidth) return;
    const i = Math.round(el.scrollLeft / el.clientWidth);
    if (i !== index) setIndex(i);
  }

  const real = (p) => p.id !== "thumb";

  return (
    <div className="carousel">
      <div className="carousel-track" ref={trackRef} onScroll={onScroll}>
        {photos.map((p) => (
          <div className="carousel-slide" key={p.id}>
            <img className="carousel-img" src={p.data} alt="" />
            {real(p) && (
              <button
                className={"photo-star" + (p.id === mainId ? " active" : "")}
                aria-label={p.id === mainId ? "Main photo" : "Set as main photo"}
                onClick={(e) => {
                  e.stopPropagation();
                  onSetMain(p);
                }}
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill={p.id === mainId ? "currentColor" : "none"}
                  stroke="currentColor"
                  strokeWidth="1.7"
                >
                  <path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8L3.5 9.7l5.9-.9z" />
                </svg>
              </button>
            )}
            {real(p) && photos.length > 1 && (
              <button
                className="photo-del"
                aria-label="Remove photo"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemovePhoto(p);
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            )}
          </div>
        ))}
        {photos.filter((p) => p.id !== "thumb").length < 5 && (
          <button className="carousel-slide carousel-add" onClick={onAddPhoto} disabled={adding}>
            <span className="carousel-add-inner">
              {adding ? (
                "Adding…"
              ) : (
                <>
                  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                  Add photo
                </>
              )}
            </span>
          </button>
        )}
      </div>
      {photos.length > 1 && (
        <div className="carousel-dots">
          {photos.map((p, i) => (
            <span key={p.id} className={"dot" + (i === index ? " active" : "")} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Wishlist                                                           */
/* ------------------------------------------------------------------ */

const BUYING = [
  ["", "Both"],
  ["fixed", "Buy It Now"],
  ["auction", "Auction"],
];

function WishlistPage({ cloud, user, wishlist, setGuestData, showToast }) {
  const [view, setView] = useState("search"); // "search" | "saved"
  const [q, setQ] = useState("");
  const [buying, setBuying] = useState(""); // "" both · "fixed" · "auction"
  const [results, setResults] = useState(null); // null idle · [] none · [...] found
  const [searching, setSearching] = useState(false);
  const [savedQuery, setSavedQuery] = useState("");
  const [openId, setOpenId] = useState(null);

  const savedIds = new Set(wishlist.map((w) => w.itemId || w.listing_url));
  const openItem = openId ? wishlist.find((w) => w.id === openId) : null;

  // buyingOverride lets the filter buttons search with the just-clicked value
  // without waiting for the async state update.
  async function runSearch(buyingOverride) {
    const term = q.trim();
    if (!term) return;
    const b = buyingOverride === undefined ? buying : buyingOverride;
    setSearching(true);
    setResults(null);
    try {
      const r = await fetch(
        "/api/price?search=1&q=" + encodeURIComponent(term) + (b ? "&buying=" + b : "")
      );
      const data = r.ok ? await r.json() : { results: [] };
      setResults(data.results || []);
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  }

  async function addResult(res) {
    const now = Date.now();
    const price = Math.round(res.price);
    const item = {
      id: crypto.randomUUID(),
      itemId: res.itemId || null,
      item_name: (res.title || "Item").slice(0, 140),
      estimated_value_usd: price,
      image_url: res.image,
      listing_url: res.url,
      condition: res.condition || "",
      buyingOptions: res.buyingOptions || [],
      isAuction: !!res.isAuction,
      created: now,
      value_source: "market",
      market_label: "eBay",
      priceHistory: [{ t: now, v: price }],
      priceLastChecked: now,
    };
    if (cloud) {
      try {
        await addWishlistItem(user.uid, item);
      } catch {
        showToast("Couldn't add — check your connection.");
        return;
      }
    } else {
      setGuestData((d) => ({ ...d, wishlist: [item, ...(d.wishlist || [])] }));
    }
    showToast("Added to wishlist.");
  }

  function persistWish(itemId, fields) {
    if (cloud) {
      updateWishlistItem(user.uid, itemId, fields).catch(() => {});
    } else {
      setGuestData((d) => ({
        ...d,
        wishlist: (d.wishlist || []).map((w) => (w.id === itemId ? { ...w, ...fields } : w)),
      }));
    }
  }

  async function removeItem(itemId) {
    if (cloud) {
      try {
        await deleteWishlistItem(user.uid, itemId);
      } catch {
        showToast("Couldn't remove — check your connection.");
        return;
      }
    } else {
      setGuestData((d) => ({
        ...d,
        wishlist: (d.wishlist || []).filter((w) => w.id !== itemId),
      }));
    }
    setOpenId(null);
  }

  const savedFiltered = savedQuery.trim()
    ? wishlist.filter((w) =>
        (w.item_name || "").toLowerCase().includes(savedQuery.trim().toLowerCase())
      )
    : wishlist;

  // Full themed listing page for a saved item.
  if (openItem) {
    return (
      <WishlistItemPage
        item={openItem}
        onBack={() => setOpenId(null)}
        onRemove={() => removeItem(openItem.id)}
        onPersist={persistWish}
      />
    );
  }

  return (
    <>
      <header className="topbar">
        <h1>Wishlist</h1>
        <button
          className="btn dark small"
          onClick={() => setView(view === "search" ? "saved" : "search")}
        >
          {view === "search"
            ? `Saved${wishlist.length ? ` · ${wishlist.length}` : ""}`
            : "＋ Search"}
        </button>
      </header>

      {view === "search" ? (
        <>
          <div className="wl-search">
            <input
              className="input"
              placeholder="Search eBay for an item…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && runSearch()}
            />
            <button className="btn dark" disabled={!q.trim() || searching} onClick={runSearch}>
              {searching ? <span className="spinner" /> : "Search"}
            </button>
          </div>
          <div className="segmented wl-filter">
            {BUYING.map(([k, lbl]) => (
              <button
                key={k || "both"}
                className={"seg" + (buying === k ? " active" : "")}
                onClick={() => {
                  setBuying(k);
                  if (q.trim()) runSearch(k);
                }}
              >
                {lbl}
              </button>
            ))}
          </div>
          {results === null && !searching && (
            <div className="empty">
              <p>Search for anything you want.</p>
            </div>
          )}
          {results && results.length === 0 && (
            <div className="empty">
              <p>No matches — try different words or filters.</p>
            </div>
          )}
          {results && results.length > 0 && (
            <main className="list">
              {results.map((r, i) => {
                const added = savedIds.has(r.itemId || r.url);
                return (
                  <div className="card wl-result" key={i}>
                    <img
                      className="thumb"
                      src={r.image}
                      alt=""
                      onError={(e) => (e.target.style.display = "none")}
                    />
                    <div className="grow">
                      <div className="card-title wl-title">{r.title}</div>
                      <div className="card-sub">
                        {money(r.price)}
                        {r.condition ? ` · ${r.condition}` : ""}
                      </div>
                      <span className={"wl-tag " + (r.isAuction ? "auction" : "bin")}>
                        {r.isAuction
                          ? `Auction${r.bidCount != null ? ` · ${r.bidCount} bid${r.bidCount === 1 ? "" : "s"}` : ""}`
                          : "Buy It Now"}
                      </span>
                    </div>
                    <button
                      className="btn light small wl-add"
                      disabled={added}
                      onClick={() => addResult(r)}
                    >
                      {added ? "Added ✓" : "＋ Add"}
                    </button>
                  </div>
                );
              })}
            </main>
          )}
          <p className="wl-note">
            Prices and listings are from eBay. Tap a saved item for its full listing.
          </p>
        </>
      ) : (
        <>
          {wishlist.length > 4 && (
            <div className="filter-bar">
              <input
                className="input search-input"
                placeholder="Search your wishlist…"
                value={savedQuery}
                onChange={(e) => setSavedQuery(e.target.value)}
              />
            </div>
          )}
          {wishlist.length === 0 && (
            <div className="empty">
              <p>Nothing saved yet.</p>
            </div>
          )}
          <main className="list">
            {savedFiltered.map((it, idx) => (
              <article
                key={it.id}
                className="card item rise"
                style={{ animationDelay: `${Math.min(idx * 45, 300)}ms` }}
                onClick={() => setOpenId(it.id)}
              >
                <div className="item-row">
                  {it.image_url ? (
                    <img
                      className="thumb"
                      src={it.image_url}
                      alt=""
                      onError={(e) => (e.target.style.display = "none")}
                    />
                  ) : (
                    <div className="thumb ph">{(it.item_name || "?")[0]?.toUpperCase()}</div>
                  )}
                  <div className="grow">
                    <div className="card-title wl-title">{it.item_name || "Item"}</div>
                    <div className="card-sub">
                      {it.isAuction ? "Auction" : "Buy It Now"}
                      {it.condition ? ` · ${it.condition}` : ""}
                    </div>
                  </div>
                  <div className="card-value">{money(it.estimated_value_usd)}</div>
                </div>
              </article>
            ))}
          </main>
        </>
      )}
    </>
  );
}

/* Full eBay-style listing page for a saved wishlist item, in our theme.
   Photos, description, condition and buy format are fetched live so we never
   cache eBay listing content; the stored snapshot is the fallback. */
function WishlistItemPage({ item, onBack, onRemove, onPersist }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(!!item.itemId);
  const [ended, setEnded] = useState(!item.itemId);
  const [imgIdx, setImgIdx] = useState(0);

  useEffect(() => {
    let dead = false;
    // Weekly price-history refresh (median by name), same as owned items.
    (async () => {
      if (Date.now() - (item.priceLastChecked || 0) > PRICE_REFRESH_MS) {
        const res = await priceLookup("", item.item_name, "");
        const now = Date.now();
        if (res) {
          const history = [...(item.priceHistory || []), { t: now, v: res.value }].slice(-260);
          onPersist(item.id, {
            estimated_value_usd: res.value,
            priceHistory: history,
            priceLastChecked: now,
          });
        } else {
          onPersist(item.id, { priceLastChecked: now });
        }
      }
    })();
    // Live listing detail.
    if (item.itemId) {
      (async () => {
        try {
          const r = await fetch("/api/price?item=" + encodeURIComponent(item.itemId));
          const data = r.ok ? await r.json() : { item: null };
          if (dead) return;
          if (data.item) setDetail(data.item);
          else setEnded(true);
        } catch {
          if (!dead) setEnded(true);
        } finally {
          if (!dead) setLoading(false);
        }
      })();
    }
    return () => {
      dead = true;
    };
  }, [item.id, item.itemId]);

  const images = detail?.images?.length
    ? detail.images
    : item.image_url
    ? [item.image_url]
    : [];
  const title = detail?.title || item.item_name || "Item";
  const price = detail?.price ?? item.estimated_value_usd;
  const condition = detail?.condition || item.condition || null;
  const isAuction = detail ? detail.isAuction : item.isAuction;
  const bidCount = detail?.bidCount;
  const url = detail?.url || item.listing_url;

  return (
    <>
      <header className="topbar">
        <button className="link back" onClick={onBack}>
          ‹ Wishlist
        </button>
      </header>

      <div className="wl-page">
        {images.length > 0 && (
          <div className="wl-gallery">
            <div
              className="wl-gallery-track"
              onScroll={(e) => {
                const w = e.target.clientWidth || 1;
                setImgIdx(Math.round(e.target.scrollLeft / w));
              }}
            >
              {images.map((src, i) => (
                <img key={i} className="wl-gallery-img" src={src} alt="" />
              ))}
            </div>
            {images.length > 1 && (
              <div className="wl-dots">
                {images.map((_, i) => (
                  <span key={i} className={"wl-dot" + (i === imgIdx ? " on" : "")} />
                ))}
              </div>
            )}
          </div>
        )}

        <h2 className="wl-page-title">{title}</h2>

        <div className="wl-price-row">
          <span className="wl-price">{money(price)}</span>
          <span className={"wl-tag " + (isAuction ? "auction" : "bin")}>
            {isAuction
              ? `Auction${bidCount != null ? ` · ${bidCount} bid${bidCount === 1 ? "" : "s"}` : ""}`
              : "Buy It Now"}
          </span>
        </div>

        {condition && (
          <div className="wl-cond">
            {condition}
            {detail?.conditionDescription ? ` — ${detail.conditionDescription}` : ""}
          </div>
        )}

        {url && (
          <a className="btn dark wl-cta" href={url} target="_blank" rel="noreferrer">
            View on eBay ↗
          </a>
        )}

        {loading && (
          <div className="wl-inline-load">
            <span className="spinner" /> Loading the latest listing details…
          </div>
        )}
        {ended && !loading && item.itemId && (
          <div className="wl-ended">This eBay listing has ended — showing your saved details.</div>
        )}

        {detail?.description && (
          <div className="wl-section">
            <div className="wl-section-h">Description</div>
            <p className="wl-desc">{detail.description}</p>
          </div>
        )}

        <div className="wl-section">
          <div className="wl-section-h">Price history</div>
          <PriceGraph history={item.priceHistory || []} />
        </div>

        {(detail?.seller || detail?.itemLocation) && (
          <div className="wl-seller">
            {detail.seller && <span>Seller · {detail.seller}</span>}
            {detail.itemLocation && <span>{detail.itemLocation}</span>}
          </div>
        )}

        <button className="btn light danger-text wl-remove" onClick={onRemove}>
          Remove from wishlist
        </button>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Item editor                                                        */
/* ------------------------------------------------------------------ */

function ItemEditor({ item, onSave, onCancel }) {
  const [f, setF] = useState({
    item_name: item.item_name || "",
    brand: item.brand || "",
    release_year: item.release_year || "",
    estimated_value_usd: item.estimated_value_usd ?? "",
    condition: item.condition || "",
    notable_details: item.notable_details || "",
    listing_url: item.listing_url || "",
  });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  return (
    <div className="card form pop">
      <label className="label">Item name</label>
      <input className="input" value={f.item_name} onChange={set("item_name")} />
      <label className="label">Made by</label>
      <input className="input" value={f.brand} onChange={set("brand")} />
      <div className="row">
        <div className="col">
          <label className="label">Year</label>
          <input className="input" inputMode="numeric" value={f.release_year} onChange={set("release_year")} />
        </div>
        <div className="col">
          <label className="label">Value (USD)</label>
          <input className="input" inputMode="decimal" value={f.estimated_value_usd} onChange={set("estimated_value_usd")} />
        </div>
      </div>
      <label className="label">Condition</label>
      <input className="input" value={f.condition} onChange={set("condition")} />
      <label className="label">Listing link (optional)</label>
      <input
        className="input"
        type="url"
        inputMode="url"
        placeholder="https://…"
        value={f.listing_url}
        onChange={set("listing_url")}
      />
      <label className="label">Notes</label>
      <textarea className="input" rows="3" value={f.notable_details} onChange={set("notable_details")} />
      <div className="row">
        <button className="btn light" onClick={onCancel}>
          Cancel
        </button>
        <button
          className="btn dark"
          onClick={() =>
            onSave({
              ...f,
              listing_url: f.listing_url.trim(),
              release_year: f.release_year ? Number(f.release_year) : null,
              estimated_value_usd: Number(f.estimated_value_usd) || 0,
            })
          }
        >
          Save
        </button>
      </div>
    </div>
  );
}
