// Firebase — powers accounts (Google + email) and cloud-synced, SHAREABLE
// collections.
//
// Data model (one doc per thing, so collections can be shared and items can
// hold full-quality photos without hitting Firestore's 1MB/doc limit):
//   collections/{cid}              the collection: name, members, join code,
//                                  and aggregate stats (count, total value)
//   collections/{cid}/items/{id}   one item — display thumbnail lives here
//   collections/{cid}/images/{id}  the item's full-size photo, fetched
//                                  only when the user zooms in
//   joinCodes/{CODE}               invite code -> collection id lookup
//   users/{uid}                    legacy pre-sharing blob; migrated once
//
// Access control is enforced by Firestore security rules — see
// firestore.rules in the repo root. Members of a collection can read and
// write it; strangers can only add THEMSELVES to a collection's member
// list, and finding the collection requires the invite code.
//
// These config values are NOT secrets — they're safe to ship in frontend
// code. Access is controlled by the Firestore security rules, not by
// hiding these strings. (API keys for AI/pricing stay on Netlify.)

import { initializeApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
} from "firebase/auth";
import {
  initializeFirestore,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  deleteField,
  collection,
  query,
  where,
  orderBy,
  onSnapshot,
  writeBatch,
  arrayUnion,
  arrayRemove,
} from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyD9xPySJe-fLNfgIkAr23PlqtN_GEbUKPs",
  authDomain: "archived1.firebaseapp.com",
  projectId: "archived1",
  storageBucket: "archived1.firebasestorage.app",
  messagingSenderId: "231437180597",
  appId: "1:231437180597:web:58374b407dd66c5af3a8fc",
  measurementId: "G-1CJF9FG8MY",
};

// True once you've pasted a real config. Until then the app runs in
// guest mode only (localStorage) and explains how to enable accounts.
export const firebaseReady = !firebaseConfig.apiKey.startsWith("PASTE");

let auth = null;
let db = null;

if (firebaseReady) {
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  // Auto-detect long-polling: Firestore's default WebChannel streaming is
  // often broken by mobile Safari and some mobile networks/proxies, which
  // hangs every read at "Loading…". This falls back to long-polling there
  // while keeping fast streaming where it works (desktop).
  db = initializeFirestore(app, { experimentalAutoDetectLongPolling: true });
}

/* ---------------- auth ---------------- */

export function watchAuth(callback) {
  if (!firebaseReady) return () => {};
  return onAuthStateChanged(auth, callback);
}

export async function googleSignIn() {
  const provider = new GoogleAuthProvider();
  await signInWithPopup(auth, provider);
}

export async function emailSignUp(email, password) {
  await createUserWithEmailAndPassword(auth, email, password);
}

export async function emailSignIn(email, password) {
  await signInWithEmailAndPassword(auth, email, password);
}

export async function logOut() {
  if (auth) await signOut(auth);
}

function displayName(user) {
  return user.displayName || user.email || "Collector";
}

/* ---------------- per-account flags ---------------- */
// Stored on the user's own doc so a "seen once" preference follows the
// account across devices, not just one browser.

export async function getUserProfile(uid) {
  try {
    const snap = await getDoc(doc(db, "users", uid));
    return snap.exists() ? snap.data() : {};
  } catch {
    return {};
  }
}

export async function markTutorialSeen(uid) {
  try {
    await setDoc(doc(db, "users", uid), { seenA2HS: true }, { merge: true });
  } catch {}
}

/* ---------------- invite codes ---------------- */
// 8 chars, no ambiguous characters (0/O, 1/I/L), stored uppercase so
// codes are case-insensitive. Uniqueness: the code IS the doc id, and
// security rules only allow creating a code doc, never overwriting one.

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function genCode() {
  let s = "";
  for (let i = 0; i < 8; i++) {
    s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return s;
}

async function freshCode() {
  let code = genCode();
  for (let tries = 0; tries < 5; tries++) {
    const taken = (await getDoc(doc(db, "joinCodes", code))).exists();
    if (!taken) break;
    code = genCode();
  }
  return code;
}

/* ---------------- collections ---------------- */

// Aggregate stats stored on the collection doc so the home page and You
// page never need to download every item. Recomputed client-side after
// every mutation (the mutating client always has the full item list).
export function computeAggregates(items) {
  const totalValue = items.reduce(
    (s, i) => s + (Number(i.estimated_value_usd) || 0),
    0
  );
  const top = [...items].sort(
    (a, b) => (b.estimated_value_usd || 0) - (a.estimated_value_usd || 0)
  )[0];
  return {
    itemCount: items.length,
    totalValue,
    coverImage: items.find((i) => i.image_url)?.image_url || null,
    topItemName: top?.item_name || null,
    topItemValue: top?.estimated_value_usd || 0,
  };
}

export async function createCollection(user, name, type) {
  const code = await freshCode();
  const cid = crypto.randomUUID();
  const batch = writeBatch(db);
  batch.set(doc(db, "collections", cid), {
    name,
    type,
    owner: user.uid,
    members: [user.uid],
    memberNames: { [user.uid]: displayName(user) },
    joinCode: code,
    created: Date.now(),
    ...computeAggregates([]),
  });
  batch.set(doc(db, "joinCodes", code), { collectionId: cid });
  await batch.commit();
  return cid;
}

export function watchCollections(uid, cb) {
  const q = query(
    collection(db, "collections"),
    where("members", "array-contains", uid)
  );
  return onSnapshot(
    q,
    (snap) =>
      cb(
        snap.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          .sort((a, b) => (a.created || 0) - (b.created || 0))
      ),
    () => cb([])
  );
}

export async function updateCollectionMeta(cid, fields) {
  await updateDoc(doc(db, "collections", cid), fields);
}

export async function deleteCollectionDoc(cid) {
  await deleteDoc(doc(db, "collections", cid));
}

export async function leaveCollection(cid, user) {
  await updateDoc(doc(db, "collections", cid), {
    members: arrayRemove(user.uid),
    [`memberNames.${user.uid}`]: deleteField(),
  });
}

export async function joinByCode(rawCode, user) {
  const code = rawCode.trim().toUpperCase();
  const snap = await getDoc(doc(db, "joinCodes", code));
  if (!snap.exists()) throw new Error("invalid code");
  const cid = snap.data().collectionId;
  await updateDoc(doc(db, "collections", cid), {
    members: arrayUnion(user.uid),
    [`memberNames.${user.uid}`]: displayName(user),
  });
  return cid;
}

/* ---------------- items ---------------- */

export async function addItemDoc(cid, item) {
  await setDoc(doc(db, "collections", cid, "items", item.id), item);
}

export async function updateItemDoc(cid, itemId, fields) {
  await updateDoc(doc(db, "collections", cid, "items", itemId), fields);
}

export async function deleteItemDoc(cid, itemId) {
  await deleteDoc(doc(db, "collections", cid, "items", itemId));
}

export function watchItems(cid, cb) {
  const q = query(
    collection(db, "collections", cid, "items"),
    orderBy("created", "desc")
  );
  return onSnapshot(
    q,
    (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    () => cb([])
  );
}

export async function setAggregates(cid, items) {
  await updateDoc(doc(db, "collections", cid), computeAggregates(items));
}

/* ---------------- full-size item photos ---------------- */
// Photos live one-per-doc under an item so we never hit Firestore's 1MB/doc
// limit and don't need the paid Storage product. The item doc keeps a small
// thumbnail (image_url) of the MAIN photo for fast list rendering, plus
// mainPhotoId. Legacy items store a single full image under images/{itemId};
// getItemPhotos falls back to that so older items keep working.

export async function addPhotoDoc(cid, itemId, photo) {
  const id = photo.id || crypto.randomUUID();
  await setDoc(doc(db, "collections", cid, "items", itemId, "photos", id), {
    data: photo.data,
    created: photo.created ?? Date.now(),
  });
  return id;
}

export async function getItemPhotos(cid, itemId) {
  const snap = await getDocs(
    query(
      collection(db, "collections", cid, "items", itemId, "photos"),
      orderBy("created", "asc")
    )
  );
  const photos = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  // Existing items store their one photo the old way. Always include it (as
  // "legacy") alongside any added photos so it can never be hidden or lost.
  const legacy = await getItemImage(cid, itemId);
  if (legacy) photos.unshift({ id: "legacy", data: legacy, created: -1 });
  return photos;
}

export async function deletePhotoDoc(cid, itemId, photoId) {
  await deleteDoc(doc(db, "collections", cid, "items", itemId, "photos", photoId));
}

export async function setItemImage(cid, itemId, dataUrl) {
  await setDoc(doc(db, "collections", cid, "images", itemId), { data: dataUrl });
}

export async function getItemImage(cid, itemId) {
  const snap = await getDoc(doc(db, "collections", cid, "images", itemId));
  return snap.exists() ? snap.data().data : null;
}

export async function deleteItemImage(cid, itemId) {
  await deleteDoc(doc(db, "collections", cid, "images", itemId));
}

/* ---------------- one-time migration from the legacy blob ---------------- */
// Pre-sharing, everything lived in users/{uid} as one big blob. On first
// sign-in after this update, copy it into the new per-doc layout. The old
// blob is left in place (marked migrated) as a safety net.

// Firestore rejects any doc containing `undefined` values; a JSON round
// trip strips them (legacy items can carry them).
function scrub(obj) {
  return JSON.parse(JSON.stringify(obj));
}

export async function migrateIfNeeded(user) {
  const ref = doc(db, "users", user.uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    console.log("[migrate] no legacy data doc for", user.uid);
    return;
  }
  const d = snap.data();
  if (!d.collections?.length || d.migratedV2) {
    console.log(
      "[migrate] nothing to do — legacy collections:",
      d.collections?.length || 0,
      "already migrated:",
      !!d.migratedV2
    );
    return;
  }
  console.log("[migrate] migrating", d.collections.length, "collections");

  for (const c of d.collections) {
    const cid = c.id || crypto.randomUUID();
    // Re-runs after a partial failure skip collections already copied.
    // Rules DENY reads of docs that don't exist (there's no member list
    // to evaluate), so "permission denied" here means "not copied yet".
    let alreadyCopied = false;
    try {
      alreadyCopied = (await getDoc(doc(db, "collections", cid))).exists();
    } catch {
      alreadyCopied = false;
    }
    if (alreadyCopied) {
      console.log("[migrate] already copied:", c.name);
      continue;
    }
    console.log("[migrate] copying:", c.name, "with", c.items?.length || 0, "items");
    const code = await freshCode();
    const items = c.items || [];
    const now = Date.now();

    // The collection doc must exist BEFORE its items are written: the
    // security rules check membership by reading the parent doc, and that
    // read cannot see a doc created in the same batch.
    const head = writeBatch(db);
    head.set(doc(db, "collections", cid), {
      name: c.name || "Collection",
      type: c.type || "General",
      owner: user.uid,
      members: [user.uid],
      memberNames: { [user.uid]: displayName(user) },
      joinCode: code,
      created: now,
      ...computeAggregates(items),
    });
    head.set(doc(db, "joinCodes", code), { collectionId: cid });
    await head.commit();

    for (let i = 0; i < items.length; i += 400) {
      const batch = writeBatch(db);
      items.slice(i, i + 400).forEach((it, idx) => {
        // Preserve order: items[0] was newest, so give it the largest stamp.
        batch.set(
          doc(db, "collections", cid, "items", it.id || crypto.randomUUID()),
          scrub({ ...it, created: now - (i + idx) })
        );
      });
      await batch.commit();
    }
  }
  await setDoc(ref, { migratedV2: true }, { merge: true });
}
