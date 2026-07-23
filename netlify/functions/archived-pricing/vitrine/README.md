# Vitrine — collection tracking app

Photo -> AI identifies the item -> saved to a collection. Values are AI
estimates and every field is editable.

## 1. Run / deploy (same as before)

Local test:
    npm install
    netlify dev            # needs .env file with: GROQ_API_KEY=your-key

Deploy an update:
    netlify deploy --build --prod

(First-time site setup: netlify login -> netlify init ->
 netlify env:set GROQ_API_KEY your-key -> netlify deploy --build --prod)

## 2. Enable accounts (Google + email login) — one-time, free

Until you do this, the app still works via "Continue without an account"
(data saved on-device). To turn on real accounts with cloud sync:

1. Go to https://console.firebase.google.com -> Add project (any name).
   Analytics: off is fine.
2. Build -> Authentication -> Get started -> Sign-in method:
   enable "Google" AND "Email/Password".
3. Build -> Firestore Database -> Create database -> Start in
   production mode -> pick a US location.
4. In Firestore -> Rules, replace everything with:

       rules_version = '2';
       service cloud.firestore {
         match /databases/{database}/documents {
           match /users/{uid} {
             allow read, write: if request.auth != null && request.auth.uid == uid;
           }
         }
       }

   Click Publish. (This means: each user can only touch their own data.)
5. Project overview -> gear icon -> Project settings -> "Your apps" ->
   click the web icon (</>) -> register the app -> copy the firebaseConfig
   object it shows you.
6. Open src/firebase.js and replace the PASTE_ values with yours.
   (These values are safe to be public — they're not secrets.)
7. Authentication -> Settings -> Authorized domains -> Add domain ->
   add your Netlify domain (e.g. vitrine-bentley.netlify.app).
8. Redeploy:  netlify deploy --build --prod

## 3. iPhone install

Open your site in Safari -> Share -> Add to Home Screen.

## 4. App Store later

Wrap this project with Capacitor (capacitorjs.com). Requires a Mac with
Xcode and an Apple Developer account ($99/yr, holder must be 18+).
