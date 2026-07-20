import { useEffect, useRef, useState } from "react";
import {
  firebaseReady,
  watchAuth,
  googleSignIn,
  emailSignUp,
  emailSignIn,
  logOut,
  loadUserData,
  saveUserData,
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

function collectionTotal(c) {
  return c.items.reduce((s, i) => s + (Number(i.estimated_value_usd) || 0), 0);
}

/* ------------------------------------------------------------------ */
/*  Root                                                               */
/* ------------------------------------------------------------------ */

export default function App() {
  const [user, setUser] = useState(null);
  const [guest, setGuest] = useState(false);
  const [authChecked, setAuthChecked] = useState(!firebaseReady);
  const [data, setData] = useState({ collections: [] });
  const [loaded, setLoaded] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [tab, setTab] = useState("collections");
  const [theme, setTheme] = useState(() => localStorage.getItem(THEME_KEY) || "system");
  const saveTimer = useRef(null);

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

  useEffect(() => {
    let cancelled = false;
    async function go() {
      if (user) {
        const d = await loadUserData(user.uid);
        if (!cancelled) {
          setData(d);
          setLoaded(true);
        }
      } else if (guest) {
        setData(loadGuest());
        setLoaded(true);
      } else {
        setLoaded(false);
        setData({ collections: [] });
        setOpenId(null);
        setTab("collections");
      }
    }
    go();
    return () => {
      cancelled = true;
    };
  }, [user, guest]);

  useEffect(() => {
    if (!loaded) return;
    if (user) {
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        saveUserData(user.uid, data).catch(() => {});
      }, 600);
    } else if (guest) {
      localStorage.setItem(GUEST_KEY, JSON.stringify(data));
    }
  }, [data, user, guest, loaded]);

  if (!authChecked) return <div className="page center">Loading…</div>;
  if (!user && !guest) return <Landing onGuest={() => setGuest(true)} />;

  const open = data.collections.find((c) => c.id === openId);

  return (
    <div className="page with-tabbar">
      {tab === "collections" ? (
        open ? (
          <div className="screen" key={"col-" + open.id}>
            <CollectionPage col={open} setData={setData} onBack={() => setOpenId(null)} />
          </div>
        ) : (
          <div className="screen" key="home">
            <CollectionsHome collections={data.collections} setData={setData} onOpen={setOpenId} />
          </div>
        )
      ) : (
        <div className="screen" key="you">
          <YouPage
            user={user}
            guest={guest}
            data={data}
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

  async function submit() {
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
        {firebaseReady ? (
          <>
            <button className="btn google" onClick={google}>
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
            <button className="btn dark" disabled={busy || !email || pw.length < 6} onClick={submit}>
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

function CollectionsHome({ collections, setData, onOpen }) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState("");

  function create() {
    const col = {
      id: crypto.randomUUID(),
      name: name.trim(),
      type: type.trim() || "General",
      items: [],
    };
    setData((d) => ({ ...d, collections: [...d.collections, col] }));
    setCreating(false);
    setName("");
    setType("");
    onOpen(col.id);
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
            <button className="btn dark" disabled={!name.trim()} onClick={create}>
              Create
            </button>
          </div>
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
              {c.items.slice(0, 1).map((i) =>
                i.image_url ? (
                  <img key={i.id} className="thumb" src={i.image_url} alt="" onError={(e) => (e.target.style.display = "none")} />
                ) : null
              )}
              {(!c.items[0] || !c.items[0].image_url) && (
                <div className="thumb ph">{c.name[0]?.toUpperCase()}</div>
              )}
            </div>
            <div className="grow">
              <div className="card-title">{c.name}</div>
              <div className="card-sub">
                {c.items.length} {c.items.length === 1 ? "item" : "items"}
              </div>
            </div>
            <div className="card-value">{money(collectionTotal(c))}</div>
          </button>
        ))}
      </main>
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Collection page                                                    */
/* ------------------------------------------------------------------ */

function CollectionPage({ col, setData, onBack }) {
  const camRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [zoomed, setZoomed] = useState(null);

  function closeZoom() {
    setZoomed((z) => (z ? { ...z, closing: true } : z));
    setTimeout(() => setZoomed(null), 160);
  }

  function patchCollection(fn) {
    setData((d) => ({
      ...d,
      collections: d.collections.map((c) => (c.id === col.id ? fn(c) : c)),
    }));
  }

  async function addPhoto(file) {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const imageBase64 = await resizeImage(file);
      const res = await fetch("/.netlify/functions/identify", {
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
      };
      // The card image is the user's own photo, stored as a small
      // thumbnail — all items share one Firestore doc, so keep it tiny.
      try {
        const thumb = await resizeImage(file, 256, 0.7);
        item.image_url = "data:image/jpeg;base64," + thumb;
      } catch {}
      try {
        const q = [item.brand, item.item_name].filter(Boolean).join(" ").trim();
        if (q) {
          const pr = await fetch(
            "/.netlify/functions/price?q=" + encodeURIComponent(q) +
              "&type=" + encodeURIComponent(col.type || "")
          );
          if (pr.ok) {
            const p = await pr.json();
            if (p.image && !item.image_url) item.image_url = p.image;
            if (p.value) {
              item.estimated_value_usd = p.value;
              item.value_source = "market";
              item.market_label = p.label;
            }
          }
        }
      } catch {}
      patchCollection((c) => ({ ...c, items: [item, ...c.items] }));
    } catch (e) {
      setError(e.message || "Something went wrong — try another photo.");
    } finally {
      setBusy(false);
    }
  }

  function saveEdit(itemId, fields) {
    patchCollection((c) => ({
      ...c,
      items: c.items.map((i) => (i.id === itemId ? { ...i, ...fields, edited: true } : i)),
    }));
    setEditingId(null);
  }

  function removeItem(itemId) {
    patchCollection((c) => ({ ...c, items: c.items.filter((i) => i.id !== itemId) }));
  }

  function removeCollection() {
    if (!confirm("Delete this collection and everything in it?")) return;
    setData((d) => ({ ...d, collections: d.collections.filter((c) => c.id !== col.id) }));
    onBack();
  }

  return (
    <>
      <button className="link back" onClick={onBack}>
        ← Collections
      </button>
      <header className="topbar">
        <div>
          <h1>{col.name}</h1>
          <div className="card-sub">{col.type} · {col.items.length}</div>
        </div>
        <div className="topbar-total">
          <div className="topbar-total-num">{money(collectionTotal(col))}</div>
        </div>
      </header>

      <button className="btn dark big" disabled={busy} onClick={() => camRef.current?.click()}>
        {busy ? <span className="spinner" /> : "+ Add Item"}
      </button>
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

      <main className="list">
        {col.items.map((it, idx) =>
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
              className={"card item rise" + (expandedId === it.id ? " open" : "")}
              style={{ animationDelay: `${Math.min(idx * 45, 300)}ms` }}
              onClick={() => setExpandedId(expandedId === it.id ? null : it.id)}
            >
              <div className="item-row">
                {it.image_url ? (
                  <img
                    className="thumb"
                    src={it.image_url}
                    alt=""
                    onError={(e) => (e.target.style.display = "none")}
                    onClick={(e) => {
                      e.stopPropagation();
                      setZoomed({ url: it.image_url });
                    }}
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
              <div className="item-more">
                <div className="item-more-inner">
                  {it.notable_details && <p className="item-notes">{it.notable_details}</p>}
                  <div className="item-meta">
                    {it.condition || "Condition unknown"} · {it.added}
                    {it.edited ? " · edited" : it.market_label ? ` · ${it.market_label}` : " · AI estimate"}
                  </div>
                  <div className="item-actions">
                    <button
                      className="link"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingId(it.id);
                      }}
                    >
                      Edit
                    </button>
                    <button
                      className="link danger"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeItem(it.id);
                      }}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              </div>
            </article>
          )
        )}
      </main>

      {col.items.length === 0 && !busy && (
        <div className="empty">
          <p>Add your first item.</p>
        </div>
      )}

      <button className="link danger footer-del" onClick={removeCollection}>
        Delete collection
      </button>

      {zoomed && (
        <div
          className={"lightbox" + (zoomed.closing ? " closing" : "")}
          onClick={closeZoom}
        >
          <img src={zoomed.url} alt="" />
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  You page + settings                                                */
/* ------------------------------------------------------------------ */

function YouPage({ user, guest, data, theme, setTheme, onSignOut }) {
  const [showSettings, setShowSettings] = useState(false);

  const totalValue = data.collections.reduce((s, c) => s + collectionTotal(c), 0);
  const totalItems = data.collections.reduce((s, c) => s + c.items.length, 0);
  const top = data.collections
    .flatMap((c) => c.items)
    .sort((a, b) => (b.estimated_value_usd || 0) - (a.estimated_value_usd || 0))[0];

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
          <div className="stat-num">{data.collections.length}</div>
          <div className="stat-label">Collections</div>
        </div>
        <div className="stat card rise" style={{ animationDelay: "120ms" }}>
          <div className="stat-num">{totalItems}</div>
          <div className="stat-label">Items</div>
        </div>
        <div className="stat card rise" style={{ animationDelay: "180ms" }}>
          <div className="stat-num small">{top ? top.item_name : "—"}</div>
          <div className="stat-label">Top item{top ? ` · ${money(top.estimated_value_usd)}` : ""}</div>
        </div>
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
