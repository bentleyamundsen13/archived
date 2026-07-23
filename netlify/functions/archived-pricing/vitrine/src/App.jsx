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
/*  Storage: signed-in users -> Firestore, guests -> localStorage      */
/* ------------------------------------------------------------------ */

const GUEST_KEY = "vitrine_guest_v2";

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

/* Shrink photos before upload so requests stay small and fast. */
function resizeImage(file, maxSide = 1024) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.85).split(",")[1]);
    };
    img.onerror = () => reject(new Error("Could not read that photo"));
    img.src = URL.createObjectURL(file);
  });
}

/* ------------------------------------------------------------------ */
/*  Root                                                               */
/* ------------------------------------------------------------------ */

export default function App() {
  const [user, setUser] = useState(null); // Firebase user object
  const [guest, setGuest] = useState(false); // "continue without account"
  const [authChecked, setAuthChecked] = useState(!firebaseReady);
  const [data, setData] = useState({ collections: [] });
  const [loaded, setLoaded] = useState(false);
  const [openId, setOpenId] = useState(null);
  const saveTimer = useRef(null);

  // Watch login state
  useEffect(() => {
    const unsub = watchAuth((u) => {
      setUser(u);
      setAuthChecked(true);
    });
    return unsub;
  }, []);

  // Load data when a session starts
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
      }
    }
    go();
    return () => {
      cancelled = true;
    };
  }, [user, guest]);

  // Save on every change (debounced for Firestore)
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

  if (!user && !guest) {
    return <Landing onGuest={() => setGuest(true)} />;
  }

  const open = data.collections.find((c) => c.id === openId);

  return (
    <div className="page">
      {open ? (
        <CollectionPage
          col={open}
          setData={setData}
          onBack={() => setOpenId(null)}
        />
      ) : (
        <CollectionsHome
          collections={data.collections}
          setData={setData}
          onOpen={setOpenId}
          userLabel={user ? user.displayName || user.email : "Guest"}
          onSignOut={async () => {
            await logOut();
            setGuest(false);
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Landing: about + create account / login                            */
/* ------------------------------------------------------------------ */

function Landing({ onGuest }) {
  const [mode, setMode] = useState("signin"); // signin | signup
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
    <div className="page landing">
      <div className="landing-brand">Archived</div>
      <h1 className="landing-title">
        Every piece you own,
        <br />
        in its place.
      </h1>
      <p className="landing-about">
        Archived is a home for your collections — records, guitars, watches,
        whatever you keep. Snap a photo of any item and AI identifies it, fills
        in the details, and files it into the right collection. Edit anything,
        track everything.
      </p>

      <div className="auth-card">
        {firebaseReady ? (
          <>
            <button className="btn google" onClick={google}>
              <GoogleMark /> Continue with Google
            </button>
            <div className="divider">
              <span>or use email</span>
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
            <button
              className="btn dark"
              disabled={busy || !email || pw.length < 6}
              onClick={submit}
            >
              {mode === "signup" ? "Create account" : "Log in"}
            </button>
            <button
              className="btn text"
              onClick={() => setMode(mode === "signup" ? "signin" : "signup")}
            >
              {mode === "signup"
                ? "Already have an account? Log in"
                : "New here? Create an account"}
            </button>
          </>
        ) : (
          <div className="setup-note">
            Accounts aren't set up yet — paste your Firebase config into{" "}
            <code>src/firebase.js</code> to enable Google and email login
            (steps in the README).
          </div>
        )}
        <button className="btn text" onClick={onGuest}>
          Continue without an account →
        </button>
      </div>

      <p className="landing-foot">
        Item values are AI estimates for personal reference, not certified
        appraisals.
      </p>
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
/*  Your Collections                                                   */
/* ------------------------------------------------------------------ */

function CollectionsHome({ collections, setData, onOpen, userLabel, onSignOut }) {
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
          + Create a Collection
        </button>
      </header>
      <div className="signed-in">
        {userLabel} · <button className="link" onClick={onSignOut}>Sign out</button>
      </div>

      {creating && (
        <div className="card form">
          <label className="label">Collection name</label>
          <input
            className="input"
            autoFocus
            placeholder="e.g. Vinyl wall"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <label className="label">What kind of collection is it?</label>
          <input
            className="input"
            placeholder="e.g. Records, Guitars, Sneakers, Pokémon cards…"
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
          <p className="empty-sub">Create one to start cataloging your stuff.</p>
        </div>
      )}

      <main className="list">
        {collections.map((c) => {
          const total = c.items.reduce((s, i) => s + (Number(i.estimated_value_usd) || 0), 0);
          return (
            <button key={c.id} className="card row-card" onClick={() => onOpen(c.id)}>
              <div>
                <div className="card-title">{c.name}</div>
                <div className="card-sub">
                  {c.type} · {c.items.length} {c.items.length === 1 ? "item" : "items"}
                </div>
              </div>
              <div className="card-value">{money(total)}</div>
            </button>
          );
        })}
      </main>
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Collection page: title left, total right, items, add & edit        */
/* ------------------------------------------------------------------ */

function CollectionPage({ col, setData, onBack }) {
  const camRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editingId, setEditingId] = useState(null);

  const total = col.items.reduce((s, i) => s + (Number(i.estimated_value_usd) || 0), 0);

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
      // Try real eBay market pricing; silently keep the AI estimate if
      // pricing isn't configured or eBay has too few matching listings.
      try {
        const q = [item.brand, item.item_name].filter(Boolean).join(" ").trim();
        if (q) {
          const pr = await fetch(
            "/.netlify/functions/price?q=" + encodeURIComponent(q)
          );
          if (pr.ok) {
            const p = await pr.json();
            if (p.median && p.sample_size >= 3) {
              item.estimated_value_usd = p.median;
              item.value_source = "ebay";
              item.market_sample = p.sample_size;
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
        ← Your Collections
      </button>
      <header className="topbar">
        <h1>{col.name}</h1>
        <div className="topbar-total">
          <div className="topbar-total-label">Total value</div>
          <div className="topbar-total-num">{money(total)}</div>
        </div>
      </header>
      <div className="card-sub under-bar">
        {col.type} · {col.items.length} {col.items.length === 1 ? "item" : "items"}
      </div>

      <button className="btn dark big" disabled={busy} onClick={() => camRef.current?.click()}>
        {busy ? "Identifying…" : "+ Add Item"}
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

      {error && <div className="error">{error}</div>}

      <main className="list">
        {col.items.map((it) =>
          editingId === it.id ? (
            <ItemEditor
              key={it.id}
              item={it}
              onSave={(fields) => saveEdit(it.id, fields)}
              onCancel={() => setEditingId(null)}
            />
          ) : (
            <article key={it.id} className="card item">
              <div className="item-head">
                <div>
                  <div className="card-title">{it.item_name || "Unidentified"}</div>
                  <div className="card-sub">
                    {it.brand || "Unknown maker"}
                    {it.release_year ? ` · ${it.release_year}` : ""}
                  </div>
                </div>
                <div className="card-value">{money(it.estimated_value_usd)}</div>
              </div>
              {it.notable_details && <p className="item-notes">{it.notable_details}</p>}
              <div className="item-meta">
                {it.condition || "Condition unknown"} · added {it.added}
                {it.edited
                  ? " · edited"
                  : it.value_source === "ebay"
                  ? ` · eBay market price (${it.market_sample} listings)`
                  : ` · AI estimate (${it.value_confidence || "?"} confidence)`}
              </div>
              <div className="item-actions">
                <button className="link" onClick={() => setEditingId(it.id)}>
                  Edit
                </button>
                <button className="link danger" onClick={() => removeItem(it.id)}>
                  Remove
                </button>
              </div>
            </article>
          )
        )}
      </main>

      {col.items.length === 0 && !busy && (
        <div className="empty">
          <p>Nothing here yet.</p>
          <p className="empty-sub">Add a photo of your first item.</p>
        </div>
      )}

      <button className="link danger footer-del" onClick={removeCollection}>
        Delete this collection
      </button>
    </>
  );
}

/* Edit any field the AI got wrong */
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
    <div className="card form">
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
          Save changes
        </button>
      </div>
    </div>
  );
}
