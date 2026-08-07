// ===================================================================
// Phone UI - Texts & Social  (SillyTavern extension)
//
// Adds a phone-style panel with:
//   - Texts: per-character SMS-style threads
//   - Feed: social media posts with #tags and @mentions
//   - Discord: servers you get invited to, with channels and chat
//   - Contacts: auto-populated from characters who've texted/posted
//   - Compose: write a text or a post, tag people with @
//
// HOW THE LLM TALKS BACK:
// This extension watches incoming chat messages for these tags:
//   [TEXT:CharacterName] message text here
//   [POST:CharacterName] caption text here #tag @mention
//   [DISCORD_INVITE:ServerName:CharacterName] invite message here
//   [DISCORD:ServerName>ChannelName:CharacterName] message text here
// Add a line like this to your character's Author's Note / system
// prompt so the model knows to use them, e.g.:
//   "When texting the user, prefix the line with [TEXT:YourName].
//    When posting to social media, prefix it with [POST:YourName].
//    When inviting the user to a Discord server, use
//    [DISCORD_INVITE:ServerName:YourName]. When talking in a server
//    channel, use [DISCORD:ServerName>ChannelName:YourName]."
// Anything tagged this way is pulled into the phone UI. You can
// still leave normal narration untagged - only tagged lines route
// into the phone.
// ===================================================================

const MODULE_NAME = "phoneUI";

let context;

// structuredClone isn't available in every environment this extension
// ends up running in (notably some older/embedded Android WebViews
// that SillyTavern mobile companion apps use). Every default object
// this file clones is plain JSON-safe data (no functions, Dates,
// Maps, etc.), so a JSON round-trip is a perfectly safe fallback -
// and critically, it means a missing structuredClone can never throw
// and take down the rest of init (see safeClone call sites below).
function safeClone(value) {
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value);
    } catch (e) {
      /* fall through to JSON fallback */
    }
  }
  return JSON.parse(JSON.stringify(value));
}

// Shows a small dismissible banner at the top of the screen. Used so
// load failures are visible on mobile, where there's no easy way to
// open the browser console to see console.error output.
function showLoadError(message) {
  try {
    const d = document.createElement("div");
    d.textContent = "[PhoneUI] " + message;
    d.style.cssText =
      "position:fixed;top:0;left:0;right:0;z-index:2147483647;" +
      "background:#b91c1c;color:#fff;font-size:12px;padding:8px 12px;" +
      "text-align:center;font-family:sans-serif;cursor:pointer;";
    d.title = "Tap to dismiss";
    d.addEventListener("click", () => d.remove());
    document.body.appendChild(d);
  } catch (e) {
    /* if this fails too, there's nothing left to do */
  }
}

// Different SillyTavern versions expose context differently: newer
// builds have a global SillyTavern.getContext(), older ones expect
// you to import from relative paths instead. This tries the modern
// path first (retrying for up to ~15s in case core ST hasn't finished
// loading yet when this script runs), then falls back to the
// import-based approach, retried a few times too, so the extension
// works either way instead of failing on one mistimed attempt.
async function resolveContext() {
  for (let i = 0; i < 60; i++) {
    if (typeof SillyTavern !== "undefined" && SillyTavern.getContext) {
      try {
        const ctx = SillyTavern.getContext();
        if (ctx) return ctx;
      } catch (e) {
        /* not ready yet, retry */
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  let lastErr = null;
  for (let i = 0; i < 5; i++) {
    try {
      const extMod = await import("../../../extensions.js");
      const scriptMod = await import("../../../../script.js");
      if (extMod.extension_settings) {
        return {
          extensionSettings: extMod.extension_settings,
          saveSettingsDebounced: scriptMod.saveSettingsDebounced,
          eventSource: scriptMod.eventSource,
          event_types: scriptMod.event_types,
          name1: scriptMod.name1,
          chat: scriptMod.chat,
          // Older builds export chat metadata as a plain module-level
          // object/function rather than putting it on a context
          // object; these may be undefined on some versions, and
          // getChatDataStore()/saveSettings() already handle that.
          chatMetadata: scriptMod.chat_metadata,
          saveMetadataDebounced: scriptMod.saveMetadataDebounced,
          saveMetadata: scriptMod.saveMetadata,
        };
      }
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  console.error("[PhoneUI] Could not resolve SillyTavern context via fallback import either.", lastErr);
  showLoadError(
    "Failed to load: could not connect to SillyTavern (" +
      (lastErr ? lastErr.message : "context API unavailable") +
      "). Open the browser console for details."
  );
  return null;
}

// Per-chat phone content (texts, feed, Discord, contacts). Stored in
// the current chat's metadata so switching chats gives each character
// their own independent phone state instead of one global inbox.
const defaultChatData = {
  contacts: {},   // { name: { avatar: "AB", lastSeen: 0 } }
  threads: {},    // { name: [ {who:"user"|"npc", text, gif:{url,title}|null, ts} ] }
  groups: {},     // { groupName: { members: ["Aiden","Maya"], avatar: "GN" } }
  groupThreads: {}, // { groupName: [ {who:"user"|"npc", sender, text, gif:{url,title}|null, ts} ] }
  feed: [],       // [ {id, author, caption, gif:{url,title}|null, tags:[], mentions:[], likes:0, likedByUser:false, comments:[], ts} ]
  discordServers: {}, // { serverName: { icon:"SN", channels: { channelName: [ {author, text, gif:{url,title}|null, isUser, ts} ] } } }
  discordInvites: [], // [ {id, server, from, message, ts} ]
  storiesViewed: {}, // { authorName: timestamp of the latest story that author's viewed up through }
  lastGifSentAt: {}, // { senderName: timestamp of their most recent GIF tag, for rate-limiting }
  unread: 0,
};

// UI/install-level preferences that should stay the same no matter
// which chat is open, so they live in the regular per-extension
// settings store instead of per-chat metadata.
const defaultGlobalSettings = {
  enabled: true,
  togglePos: null, // { left, top } in px once the user has dragged the floating button; null = default corner spot
  panelPos: null, // { left, top } in px once the user has dragged the panel itself; null = auto-follow the button
  gifApiKey: "", // optional user-supplied Klipy API key; GIF/meme features work offline without one
  personaPhoto: "", // data URL for the user's own avatar (shown wherever context.name1 posts/messages), install-wide like the rest of this block
};

const CHAT_DATA_KEYS = new Set(Object.keys(defaultChatData));
const GLOBAL_SETTINGS_KEYS = new Set(Object.keys(defaultGlobalSettings));

let chatMetadataWarned = false;

// The live metadata object for whichever chat is currently open. ST
// swaps this out (or its contents) when the user switches chats. If a
// given SillyTavern build doesn't expose it, fall back to storing
// "chat data" alongside the global settings instead of crashing - the
// per-chat separation just won't apply on that build.
function getChatDataStore() {
  if (context.chatMetadata) return context.chatMetadata;
  if (!chatMetadataWarned) {
    chatMetadataWarned = true;
    console.warn(
      "[PhoneUI] context.chatMetadata isn't available on this SillyTavern build; phone data will stay global instead of per-chat."
    );
  }
  return context.extensionSettings;
}

function getGlobalSettings() {
  if (!context.extensionSettings[MODULE_NAME]) {
    context.extensionSettings[MODULE_NAME] = safeClone(defaultGlobalSettings);
  }
  const store = context.extensionSettings[MODULE_NAME];
  for (const key of GLOBAL_SETTINGS_KEYS) {
    if (store[key] === undefined) store[key] = safeClone(defaultGlobalSettings[key]);
  }
  return store;
}

function getChatData() {
  const store = getChatDataStore();
  if (!store[MODULE_NAME]) {
    store[MODULE_NAME] = safeClone(defaultChatData);
  }
  const chatData = store[MODULE_NAME];
  for (const key of CHAT_DATA_KEYS) {
    if (chatData[key] === undefined) chatData[key] = safeClone(defaultChatData[key]);
  }
  return chatData;
}

// Everywhere else in this file just does `getSettings().whatever`, so
// rather than rewrite every call site to know which of the two stores
// (per-chat metadata vs global extension settings) a given field
// lives in, this hands back a thin Proxy that routes each property to
// the right one transparently. Reads/writes of top-level fields (e.g.
// `s.enabled = false`, `s.unread = 0`) and mutations of nested
// objects/arrays (e.g. `s.threads[name].push(...)`) both work exactly
// as if this were one plain object.
function getSettings() {
  const chatData = getChatData();
  const globalSettings = getGlobalSettings();
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (CHAT_DATA_KEYS.has(prop)) return chatData[prop];
        if (GLOBAL_SETTINGS_KEYS.has(prop)) return globalSettings[prop];
        return undefined;
      },
      set(_target, prop, value) {
        if (CHAT_DATA_KEYS.has(prop)) {
          chatData[prop] = value;
          return true;
        }
        if (GLOBAL_SETTINGS_KEYS.has(prop)) {
          globalSettings[prop] = value;
          return true;
        }
        return true;
      },
    }
  );
}

function saveSettings() {
  // Global settings (enabled/togglePos/gifApiKey) always live in
  // extension settings.
  context.saveSettingsDebounced();

  // Chat data lives in chat metadata, which uses its own separate
  // save path. Different ST versions expose slightly different
  // function names for this, so try the known options in order and
  // fall back gracefully (worst case, chat data persists on the next
  // autosave instead of immediately) rather than throwing.
  if (typeof context.saveMetadataDebounced === "function") {
    context.saveMetadataDebounced();
  } else if (typeof context.saveMetadata === "function") {
    context.saveMetadata();
  } else if (typeof context.saveChatDebounced === "function") {
    context.saveChatDebounced();
  } else if (typeof context.saveChat === "function") {
    context.saveChat();
  }
  // If none of the above exist, getChatDataStore() already fell back
  // to context.extensionSettings, which the saveSettingsDebounced()
  // call above covers - so data still isn't lost.
}

// ---------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------

const TEXT_TAG = /\[TEXT:([^\]]+)\]\s*([^\n\[]+)/g;
const POST_TAG = /\[POST:([^\]]+)\]\s*([^\n\[]+)/g;
const DISCORD_INVITE_TAG = /\[DISCORD_INVITE:([^:\]]+):([^\]]+)\]\s*([^\n\[]+)/g;
const DISCORD_MSG_TAG = /\[DISCORD:([^>\]]+)>([^:\]]+):([^\]]+)\]\s*([^\n\[]+)/g;
const NUMBER_TAG = /\[NUMBER:([^\]]+)\]\s*([^\n\[]+)/g;
// [GROUP_START:GroupName:Member1,Member2,...] creates/updates a group
// thread's member list (mirrors DISCORD_INVITE - it's how an NPC
// brings the user into a multi-person thread in the first place).
const GROUP_START_TAG = /\[GROUP_START:([^:\]]+):([^\]]+)\]/g;
// [GROUPTEXT:GroupName:SenderName] message text
const GROUP_TEXT_TAG = /\[GROUPTEXT:([^:\]]+):([^\]]+)\]\s*([^\n\[]+)/g;

// GIF/reaction tags - an NPC can send a GIF the same way a user can
// tap one from the picker. The text after the tag is the Klipy
// search query (e.g. "laughing", "eye roll"), not a caption - it's a
// reaction, same as a quick-tap chip. [POSTGIF] is the exception: it
// can carry an optional caption after a "|".
// [GIF:Name] search query
const GIF_TAG = /\[GIF:([^\]]+)\]\s*([^\n\[]+)/g;
// [GROUPGIF:GroupName:SenderName] search query
const GROUP_GIF_TAG = /\[GROUPGIF:([^:\]]+):([^\]]+)\]\s*([^\n\[]+)/g;
// [DISCORDGIF:Server>Channel:SenderName] search query
const DISCORD_GIF_TAG = /\[DISCORDGIF:([^>\]]+)>([^:\]]+):([^\]]+)\]\s*([^\n\[]+)/g;
// [POSTGIF:Name] search query | optional caption
const POST_GIF_TAG = /\[POSTGIF:([^\]]+)\]\s*([^\n\[]+)/g;

// [TEXT_UNKNOWN:PhoneNumber] message text - a text from a number that
// isn't a contact yet. Shows up as a raw-number thread until a
// [NUMBER:Name] tag (or the user manually saving it) resolves it to a
// named contact, at which point the thread history migrates over.
const UNKNOWN_TEXT_TAG = /\[TEXT_UNKNOWN:([^\]]+)\]\s*([^\n\[]+)/g;

// [REPOST:ReposterName:OriginalAuthorName] optional added caption -
// reposts that author's most recent feed post under ReposterName,
// same idea as a retweet/share. Caption is optional (can be empty).
const REPOST_TAG = /\[REPOST:([^:\]]+):([^\]]+)\]([^\n\[]*)/g;

function extractTagsAndMentions(str) {
  const tags = [...str.matchAll(/#(\w+)/g)].map((m) => m[1]);
  const mentions = [...str.matchAll(/@(\w+)/g)].map((m) => m[1]);
  return { tags, mentions };
}

function initials(name) {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function ensureContact(name) {
  const s = getSettings();
  if (!s.contacts[name]) {
    s.contacts[name] = { avatar: initials(name), lastSeen: Date.now() };
  }
  return s.contacts[name];
}

// What to actually show in the UI for a contact: their user-set
// nickname if they have one, otherwise "Unknown" for an unresolved
// number, otherwise their real name. The nickname is purely a display
// label - everything that routes messages (thread keys, tag names
// sent back to the model, group membership) keeps using the real
// underlying key, so renaming a contact never breaks the model's own
// sense of who's who.
function displayName(key, contact) {
  const c = contact || getSettings().contacts[key];
  if (c?.nickname) return c.nickname;
  if (c?.unknown) return "Unknown";
  return key;
}

// Lets the user set/clear a nickname for any contact - one they've
// been named for by the model, or a number-only contact they haven't
// identified yet. Doesn't touch the contact's real key/number, so
// nothing about how the model addresses them changes.
function setNickname(key) {
  const s = getSettings();
  const contact = s.contacts[key];
  if (!contact) return;
  const current = contact.nickname || "";
  const next = prompt(`Nickname for ${key}:`, current);
  if (next === null) return; // cancelled
  const clean = next.trim();
  contact.nickname = clean || undefined;
  saveSettings();
  renderPanel();
}

// ---------------------------------------------------------------
// Profile pictures - a contact's own photo, and the user's own
// "persona" photo. Both are optional; anywhere an avatar shows up,
// it falls back to the plain initials circle when no photo is set.
// ---------------------------------------------------------------

// Which photo (if any) belongs to a given display name: the user's
// own persona photo if the name is the current persona, otherwise
// that contact's photo. Returns null (not undefined) when there's
// nothing set, so callers can use it directly in a ternary.
function avatarPhotoFor(name) {
  const s = getSettings();
  if (name === (context.name1 || "User")) return s.personaPhoto || null;
  return s.contacts[name]?.photo || null;
}

// Renders one avatar circle - an actual photo if `photoUrl` is set,
// otherwise the plain initials/label text exactly like before.
// `extraClass` mirrors the modifier classes the old inline markup
// used (phoneui-avatar-sm, phoneui-groupavatar, etc).
function avatarHtml(label, photoUrl, extraClass = "") {
  const cls = `phoneui-avatar${extraClass ? " " + extraClass : ""}`;
  return photoUrl
    ? `<div class="${cls}"><img class="phoneui-avatarimg" src="${escapeHtml(photoUrl)}" alt="" /></div>`
    : `<div class="${cls}">${escapeHtml(label)}</div>`;
}

// Reads a File into a small, storage-friendly data URL: downscales to
// a 160px-max square and re-encodes as JPEG, since profile pictures
// end up saved straight into chat metadata (or global settings, for
// the persona photo) and a full-resolution phone photo would bloat
// that considerably.
function readImageAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("Couldn't read that file."));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Couldn't read that image."));
      img.onload = () => {
        const maxSide = 160;
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// Opens a native "choose an image" file picker and resolves to a
// resized data URL, or null if the user cancelled/picked nothing.
// Shared by both the contact-photo and persona-photo pickers below.
function pickImageFile() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.addEventListener("change", async () => {
      const file = input.files && input.files[0];
      if (!file) {
        resolve(null);
        return;
      }
      try {
        resolve(await readImageAsDataUrl(file));
      } catch (e) {
        console.error("[PhoneUI] Couldn't read image:", e);
        alert("Couldn't read that image file.");
        resolve(null);
      }
    });
    input.click();
  });
}

// Lets the user set or replace a contact's profile picture.
async function setContactPhoto(key) {
  const s = getSettings();
  if (!s.contacts[key]) return;
  const dataUrl = await pickImageFile();
  if (!dataUrl) return;
  s.contacts[key].photo = dataUrl;
  saveSettings();
  renderPanel();
}

// Removes a contact's profile picture, reverting them to the plain
// initials avatar.
function removeContactPhoto(key) {
  const s = getSettings();
  if (!s.contacts[key]?.photo) return;
  delete s.contacts[key].photo;
  saveSettings();
  renderPanel();
}

// A contact who's texted from a number that hasn't been tied to a
// name yet - keyed by the raw number itself (both in `contacts` and
// `threads`) instead of a name, so it reads as a stranger's number
// until [NUMBER:Name] or the user's "save as contact" resolves it.
function ensureUnknownContact(number) {
  const s = getSettings();
  const key = number.trim();
  if (!s.contacts[key]) {
    s.contacts[key] = { avatar: "?", lastSeen: Date.now(), phone: key, unknown: true };
  }
  return s.contacts[key];
}

// Folds an unknown-number thread's history into a real, named
// contact - used both when [NUMBER:Name] reveals who an unresolved
// number belongs to, and when the user manually saves one from the
// thread header. Safe no-op if oldKey isn't actually an unknown
// contact.
function resolveUnknownNumber(oldKey, newName, opts = {}) {
  const s = getSettings();
  const clean = (newName || "").trim();
  if (!clean || !s.contacts[oldKey]) return;
  const number = s.contacts[oldKey].phone || oldKey;
  const contact = ensureContact(clean);
  if (!contact.phone) contact.phone = number;
  const oldThread = s.threads[oldKey] || [];
  s.threads[clean] = [...(s.threads[clean] || []), ...oldThread].sort((a, b) => a.ts - b.ts);
  delete s.threads[oldKey];
  delete s.contacts[oldKey];
  if (activeThread === oldKey) activeThread = clean;
  saveSettings();
  renderPanel();
  if (!opts.silent) {
    sendToChat(`[SYSTEM] ${context.name1 || "User"} saved ${number} as a contact named "${clean}".`);
  }
}

// ---------------------------------------------------------------
// Block/mute - a blocked contact's incoming TEXT/GIF/GROUPTEXT/
// GROUPGIF/POST/POSTGIF/DISCORD/DISCORDGIF/invite tags are silently
// ignored (logged to console) until unblocked, on top of the
// [SYSTEM] note telling the model to stop texting as that character.
// ---------------------------------------------------------------

function isBlocked(name) {
  const s = getSettings();
  return !!s.contacts[name]?.blocked;
}

function toggleBlock(name) {
  const s = getSettings();
  const contact = ensureContact(name);
  contact.blocked = !contact.blocked;
  saveSettings();
  renderPanel();
  sendToChat(
    contact.blocked
      ? `[SYSTEM] ${context.name1 || "User"} has blocked ${name}. ${name} should not send any more texts, group messages, posts, or Discord messages until unblocked.`
      : `[SYSTEM] ${context.name1 || "User"} has unblocked ${name}.`
  );
}

// Digits-only comparison so "(555) 019-2847" and "555-019-2847" are
// recognized as the same number regardless of how a model formats it.
function normalizePhone(str) {
  return (str || "").replace(/\D+/g, "");
}

// Bug fix: NUMBER/TEXT_UNKNOWN tags used to accept literally any text
// after the tag as "the number" - a model could hand over "unknown",
// "ask Maya", or a 3-digit typo and the extension would happily save
// it as a contact's phone number. This enforces that what comes
// through actually looks like a real, dialable number (NANP-style:
// 10 digits, or 11 with a leading country code 1) before it's ever
// written into a contact - anything else is rejected the same way a
// real phone's contacts app would reject it. Fictional 555-exchange
// numbers (the README's recommended format) pass this fine, since
// 555 is a normal, valid NXX exchange as far as the shape check goes.
function isValidPhoneNumber(str) {
  let digits = normalizePhone(str);
  if (digits.length === 11 && digits[0] === "1") digits = digits.slice(1);
  if (digits.length !== 10) return false;
  // NANP area code and exchange code can't start with 0 or 1.
  if (digits[0] === "0" || digits[0] === "1") return false;
  if (digits[3] === "0" || digits[3] === "1") return false;
  // Reject the obvious placeholder patterns a model sometimes falls
  // back on when it hasn't actually generated a number (all the same
  // repeated digit, or straightforward sequential runs).
  if (/^(\d)\1{9}$/.test(digits)) return false;
  return true;
}

// Formats a validated 10-digit number as "(NXX) NXX-XXXX" so numbers
// display consistently in the UI no matter how the model formatted
// the raw tag text.
function formatPhoneNumber(str) {
  let digits = normalizePhone(str);
  if (digits.length === 11 && digits[0] === "1") digits = digits.slice(1);
  if (digits.length !== 10) return str.trim();
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

// Looks up which contact (other than excludeName) already holds this
// number, so a phone number can only ever be "valid" for the one NPC
// that actually handed it out.
function findContactNameByPhone(number, excludeName) {
  const s = getSettings();
  const target = normalizePhone(number);
  if (!target) return null;
  for (const [name, c] of Object.entries(s.contacts)) {
    if (name === excludeName) continue;
    if (c.phone && normalizePhone(c.phone) === target) return name;
  }
  return null;
}

// Creates a group thread if it doesn't exist yet, and folds in any
// new member names (each becomes a contact too, same as a 1:1 text).
// Safe to call repeatedly - existing members/messages are untouched.
function ensureGroup(groupName, memberNames) {
  const s = getSettings();
  if (!s.groups[groupName]) {
    s.groups[groupName] = { members: [], avatar: initials(groupName) };
  }
  const group = s.groups[groupName];
  for (const raw of memberNames) {
    const clean = raw.trim();
    if (!clean) continue;
    ensureContact(clean);
    if (!group.members.includes(clean)) group.members.push(clean);
  }
  if (!s.groupThreads[groupName]) s.groupThreads[groupName] = [];
  return group;
}

function ensureServer(serverName) {
  const s = getSettings();
  if (!s.discordServers[serverName]) {
    s.discordServers[serverName] = {
      icon: initials(serverName),
      channels: { general: [] },
    };
  }
  return s.discordServers[serverName];
}

function handleIncomingMessage(rawText) {
  if (!rawText) return;
  const s = getSettings();
  let sawSomething = false;
  let sawTyping = false;

  for (const match of rawText.matchAll(TEXT_TAG)) {
    const [, name, text] = match;
    const cleanName = name.trim();
    const cleanText = text.trim();
    if (isBlocked(cleanName)) {
      console.warn(`[PhoneUI] Ignored [TEXT:${cleanName}] - contact is blocked.`);
      continue;
    }
    ensureContact(cleanName);
    // Show "typing..." right away; the message itself lands after a
    // short fake delay instead of appearing instantly.
    typingThreads.add(cleanName);
    sawTyping = true;
    const timerId = setTimeout(() => {
      pendingTypingTimers.delete(timerId);
      typingThreads.delete(cleanName);
      const st = getSettings();
      if (!st.threads[cleanName]) st.threads[cleanName] = [];
      st.threads[cleanName].push({ who: "npc", text: cleanText, ts: Date.now() });
      st.unread += 1;
      saveSettings();
      renderPanel();
      updateToggleBadge();
      notify({
        icon: "fa-solid fa-comment",
        title: displayName(cleanName),
        body: cleanText,
        onOpen: () => {
          activeTab = "texts";
          activeThread = cleanName;
        },
      });
    }, typingDelayFor(cleanText));
    pendingTypingTimers.add(timerId);
  }

  for (const match of rawText.matchAll(GIF_TAG)) {
    const [, name, query] = match;
    const cleanName = name.trim();
    const cleanQuery = query.trim();
    if (isBlocked(cleanName)) {
      console.warn(`[PhoneUI] Ignored [GIF:${cleanName}] - contact is blocked.`);
      continue;
    }
    if (!canSendNpcGif(cleanName)) {
      console.warn(`[PhoneUI] Ignored [GIF:${cleanName}] - sending too many GIFs too fast.`);
      continue;
    }
    markNpcGifSent(cleanName);
    ensureContact(cleanName);
    typingThreads.add(cleanName);
    sawTyping = true;
    const timerId = setTimeout(() => {
      pendingTypingTimers.delete(timerId);
      resolveGifForQuery(cleanQuery).then((gif) => {
        typingThreads.delete(cleanName);
        const st = getSettings();
        if (!st.threads[cleanName]) st.threads[cleanName] = [];
        st.threads[cleanName].push({
          who: "npc",
          text: gif ? "" : `[GIF for "${cleanQuery}" couldn't be sent - try again in a moment]`,
          gif: gif || null,
          ts: Date.now(),
        });
        st.unread += 1;
        saveSettings();
        renderPanel();
        updateToggleBadge();
        notify({
          icon: "fa-solid fa-comment",
          title: cleanName,
          body: gif ? "Sent a GIF" : cleanQuery,
          onOpen: () => {
            activeTab = "texts";
            activeThread = cleanName;
          },
        });
      });
    }, typingDelayFor(cleanQuery || "gif"));
    pendingTypingTimers.add(timerId);
  }

  for (const match of rawText.matchAll(GROUP_START_TAG)) {
    const [, groupName, memberList] = match;
    const cleanGroup = groupName.trim();
    const members = memberList
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean);
    const isNew = !s.groups[cleanGroup];
    ensureGroup(cleanGroup, members);
    sawSomething = true;
    if (isNew) {
      notify({
        icon: "fa-solid fa-user-group",
        title: `Added to ${cleanGroup}`,
        body: `With ${members.join(", ")}`,
        onOpen: () => {
          activeTab = "texts";
          activeThread = null;
          activeGroup = cleanGroup;
        },
      });
    }
  }

  for (const match of rawText.matchAll(GROUP_TEXT_TAG)) {
    const [, groupName, senderName, text] = match;
    const cleanGroup = groupName.trim();
    const cleanSender = senderName.trim();
    const cleanText = text.trim();
    // Same rule as Discord: an NPC can't message a group thread the
    // user hasn't been added to yet via GROUP_START. A blocked sender
    // is silently skipped too, same as a 1:1 TEXT would be.
    if (s.groups[cleanGroup] && isBlocked(cleanSender)) {
      console.warn(`[PhoneUI] Ignored [GROUPTEXT:${cleanGroup}:${cleanSender}] - contact is blocked.`);
    } else if (s.groups[cleanGroup]) {
      ensureContact(cleanSender);
      if (!typingGroups[cleanGroup]) typingGroups[cleanGroup] = new Set();
      typingGroups[cleanGroup].add(cleanSender);
      sawTyping = true;
      const timerId = setTimeout(() => {
        pendingTypingTimers.delete(timerId);
        typingGroups[cleanGroup]?.delete(cleanSender);
        const st = getSettings();
        if (!st.groups[cleanGroup]) return; // group was removed while we waited
        if (!st.groups[cleanGroup].members.includes(cleanSender)) {
          st.groups[cleanGroup].members.push(cleanSender);
        }
        if (!st.groupThreads[cleanGroup]) st.groupThreads[cleanGroup] = [];
        st.groupThreads[cleanGroup].push({ who: "npc", sender: cleanSender, text: cleanText, ts: Date.now() });
        st.unread += 1;
        saveSettings();
        renderPanel();
        updateToggleBadge();
        notify({
          icon: "fa-solid fa-user-group",
          title: cleanGroup,
          body: `${cleanSender}: ${cleanText}`,
          onOpen: () => {
            activeTab = "texts";
            activeThread = null;
            activeGroup = cleanGroup;
          },
        });
      }, typingDelayFor(cleanText));
      pendingTypingTimers.add(timerId);
    }
  }

  for (const match of rawText.matchAll(GROUP_GIF_TAG)) {
    const [, groupName, senderName, query] = match;
    const cleanGroup = groupName.trim();
    const cleanSender = senderName.trim();
    const cleanQuery = query.trim();
    if (!canSendNpcGif(cleanSender)) {
      console.warn(`[PhoneUI] Ignored [GROUPGIF:${cleanGroup}:${cleanSender}] - sending too many GIFs too fast.`);
      continue;
    }
    // Same rule as GROUPTEXT - can't land in a group the user hasn't
    // been added to yet, and a blocked sender is skipped.
    if (s.groups[cleanGroup] && isBlocked(cleanSender)) {
      console.warn(`[PhoneUI] Ignored [GROUPGIF:${cleanGroup}:${cleanSender}] - contact is blocked.`);
    } else if (s.groups[cleanGroup]) {
      markNpcGifSent(cleanSender);
      ensureContact(cleanSender);
      if (!typingGroups[cleanGroup]) typingGroups[cleanGroup] = new Set();
      typingGroups[cleanGroup].add(cleanSender);
      sawTyping = true;
      const timerId = setTimeout(() => {
        pendingTypingTimers.delete(timerId);
        resolveGifForQuery(cleanQuery).then((gif) => {
          typingGroups[cleanGroup]?.delete(cleanSender);
          const st = getSettings();
          if (!st.groups[cleanGroup]) return; // group was removed while we waited
          if (!st.groups[cleanGroup].members.includes(cleanSender)) {
            st.groups[cleanGroup].members.push(cleanSender);
          }
          if (!st.groupThreads[cleanGroup]) st.groupThreads[cleanGroup] = [];
          st.groupThreads[cleanGroup].push({
            who: "npc",
            sender: cleanSender,
            text: gif ? "" : `[GIF for "${cleanQuery}" couldn't be sent - try again in a moment]`,
            gif: gif || null,
            ts: Date.now(),
          });
          st.unread += 1;
          saveSettings();
          renderPanel();
          updateToggleBadge();
          notify({
            icon: "fa-solid fa-user-group",
            title: cleanGroup,
            body: gif ? `${cleanSender} sent a GIF` : `${cleanSender}: ${cleanQuery}`,
            onOpen: () => {
              activeTab = "texts";
              activeThread = null;
              activeGroup = cleanGroup;
            },
          });
        });
      }, typingDelayFor(cleanQuery || "gif"));
      pendingTypingTimers.add(timerId);
    }
  }

  for (const match of rawText.matchAll(POST_TAG)) {
    const [, name, caption] = match;
    const cleanName = name.trim();
    const cleanCaption = caption.trim();
    if (isBlocked(cleanName)) {
      console.warn(`[PhoneUI] Ignored [POST:${cleanName}] - contact is blocked.`);
      continue;
    }
    ensureContact(cleanName);
    const { tags, mentions } = extractTagsAndMentions(cleanCaption);
    s.feed.unshift({
      id: crypto.randomUUID(),
      author: cleanName,
      caption: cleanCaption,
      tags,
      mentions,
      likes: Math.floor(Math.random() * 12),
      likedByUser: false,
      comments: [],
      ts: Date.now(),
    });
    sawSomething = true;
    notify({
      icon: "fa-solid fa-images",
      title: `${cleanName} posted`,
      body: cleanCaption,
      onOpen: () => {
        activeTab = "feed";
      },
    });
  }

  for (const match of rawText.matchAll(POST_GIF_TAG)) {
    const [, name, rest] = match;
    const cleanName = name.trim();
    const [queryPart, captionPart] = rest.split("|");
    const cleanQuery = (queryPart || "").trim();
    const cleanCaption = (captionPart || "").trim();
    if (isBlocked(cleanName)) {
      console.warn(`[PhoneUI] Ignored [POSTGIF:${cleanName}] - contact is blocked.`);
      continue;
    }
    if (!canSendNpcGif(cleanName)) {
      console.warn(`[PhoneUI] Ignored [POSTGIF:${cleanName}] - sending too many GIFs too fast.`);
      continue;
    }
    markNpcGifSent(cleanName);
    ensureContact(cleanName);
    resolveGifForQuery(cleanQuery).then((gif) => {
      const st = getSettings();
      const finalCaption = gif
        ? cleanCaption
        : cleanCaption || `[GIF for "${cleanQuery}" couldn't be sent - try again in a moment]`;
      const { tags, mentions } = extractTagsAndMentions(finalCaption);
      st.feed.unshift({
        id: crypto.randomUUID(),
        author: cleanName,
        caption: finalCaption,
        gif: gif || null,
        tags,
        mentions,
        likes: Math.floor(Math.random() * 12),
        likedByUser: false,
        comments: [],
        ts: Date.now(),
      });
      st.unread += 1;
      saveSettings();
      renderPanel();
      updateToggleBadge();
      notify({
        icon: "fa-solid fa-images",
        title: `${cleanName} posted`,
        body: gif ? finalCaption || "Posted a GIF" : finalCaption,
        onOpen: () => {
          activeTab = "feed";
        },
      });
    });
  }

  for (const match of rawText.matchAll(DISCORD_INVITE_TAG)) {
    const [, serverName, fromName, message] = match;
    const cleanServer = serverName.trim();
    const cleanFrom = fromName.trim();
    if (isBlocked(cleanFrom)) {
      console.warn(`[PhoneUI] Ignored [DISCORD_INVITE:${cleanServer}:${cleanFrom}] - contact is blocked.`);
      continue;
    }
    ensureContact(cleanFrom);
    s.discordInvites.push({
      id: crypto.randomUUID(),
      server: cleanServer,
      from: cleanFrom,
      message: message.trim(),
      ts: Date.now(),
    });
    sawSomething = true;
    notify({
      icon: "fa-brands fa-discord",
      title: `Invite: ${cleanServer}`,
      body: `${cleanFrom} — ${message.trim()}`,
      onOpen: () => {
        activeTab = "discord";
        activeServer = null;
        activeChannel = null;
      },
    });
  }

  for (const match of rawText.matchAll(DISCORD_MSG_TAG)) {
    const [, serverName, channelName, authorName, text] = match;
    const cleanServer = serverName.trim();
    const cleanChannel = channelName.trim().toLowerCase();
    const cleanAuthor = authorName.trim();
    // Only lands in the server if the user has actually joined it -
    // an NPC can't post into a server the user hasn't accepted yet -
    // and a blocked author is skipped the same way.
    if (s.discordServers[cleanServer] && isBlocked(cleanAuthor)) {
      console.warn(`[PhoneUI] Ignored [DISCORD:${cleanServer}>${cleanChannel}:${cleanAuthor}] - contact is blocked.`);
    } else if (s.discordServers[cleanServer]) {
      const server = s.discordServers[cleanServer];
      if (!server.channels[cleanChannel]) server.channels[cleanChannel] = [];
      server.channels[cleanChannel].push({
        author: cleanAuthor,
        text: text.trim(),
        isUser: false,
        ts: Date.now(),
      });
      sawSomething = true;
      notify({
        icon: "fa-brands fa-discord",
        title: `${cleanAuthor} in #${cleanChannel}`,
        body: text.trim(),
        onOpen: () => {
          activeTab = "discord";
          activeServer = cleanServer;
          activeChannel = cleanChannel;
        },
      });
    }
  }

  for (const match of rawText.matchAll(DISCORD_GIF_TAG)) {
    const [, serverName, channelName, authorName, query] = match;
    const cleanServer = serverName.trim();
    const cleanChannel = channelName.trim().toLowerCase();
    const cleanAuthor = authorName.trim();
    const cleanQuery = query.trim();
    if (!canSendNpcGif(cleanAuthor)) {
      console.warn(`[PhoneUI] Ignored [DISCORDGIF:${cleanServer}>${cleanChannel}:${cleanAuthor}] - sending too many GIFs too fast.`);
      continue;
    }
    // Same rule as DISCORD - can't land in a server the user hasn't
    // joined, and a blocked author is skipped.
    if (s.discordServers[cleanServer] && isBlocked(cleanAuthor)) {
      console.warn(`[PhoneUI] Ignored [DISCORDGIF:${cleanServer}>${cleanChannel}:${cleanAuthor}] - contact is blocked.`);
    } else if (s.discordServers[cleanServer]) {
      markNpcGifSent(cleanAuthor);
      if (!s.discordServers[cleanServer].channels[cleanChannel]) {
        s.discordServers[cleanServer].channels[cleanChannel] = [];
      }
      resolveGifForQuery(cleanQuery).then((gif) => {
        const st = getSettings();
        const server = st.discordServers[cleanServer];
        if (!server) return; // server was removed while we waited
        if (!server.channels[cleanChannel]) server.channels[cleanChannel] = [];
        server.channels[cleanChannel].push({
          author: cleanAuthor,
          text: gif ? "" : `[GIF for "${cleanQuery}" couldn't be sent - try again in a moment]`,
          gif: gif || null,
          isUser: false,
          ts: Date.now(),
        });
        st.unread += 1;
        saveSettings();
        renderPanel();
        updateToggleBadge();
        notify({
          icon: "fa-brands fa-discord",
          title: `${cleanAuthor} in #${cleanChannel}`,
          body: gif ? "Sent a GIF" : cleanQuery,
          onOpen: () => {
            activeTab = "discord";
            activeServer = cleanServer;
            activeChannel = cleanChannel;
          },
        });
      });
    }
  }

  for (const match of rawText.matchAll(NUMBER_TAG)) {
    const [, name, number] = match;
    const cleanName = name.trim();
    const rawNumber = number.trim();
    // Bug fix: a [NUMBER:Name] tag used to be accepted no matter what
    // followed it, so a malformed or placeholder "number" from the
    // model would still get written into that character's contact
    // card. Require something that actually looks like a real,
    // dialable number before it's treated as valid - anything else is
    // dropped, same as the rest of a bad tag would be.
    if (!isValidPhoneNumber(rawNumber)) {
      console.warn(
        `[PhoneUI] Ignored [NUMBER:${cleanName}] "${rawNumber}" - not a valid-looking phone number.`
      );
      continue;
    }
    const cleanNumber = formatPhoneNumber(rawNumber);
    // A number belongs exclusively to whichever NPC first hands it
    // over - it's only ever "valid" for the contact that actually
    // provided it. If some other character's tag shows up with a
    // number already claimed by someone else, ignore it instead of
    // letting them steal/overwrite that contact's number.
    const claimedBy = findContactNameByPhone(cleanNumber, cleanName);
    if (claimedBy && s.contacts[claimedBy]?.unknown) {
      // An unresolved "unknown number" thread just got a name - fold
      // its history into the real contact instead of treating this as
      // a clash the way an already-named contact's number would be.
      resolveUnknownNumber(claimedBy, cleanName, { silent: true });
    } else if (claimedBy) {
      console.warn(
        `[PhoneUI] Ignored [NUMBER:${cleanName}] ${cleanNumber} - already assigned to ${claimedBy}.`
      );
      continue;
    }
    const contact = ensureContact(cleanName);
    const isNew = contact.phone !== cleanNumber;
    contact.phone = cleanNumber;
    sawSomething = true;
    if (isNew) {
      notify({
        icon: "fa-solid fa-address-card",
        title: `${displayName(cleanName)} shared their number`,
        body: cleanNumber,
        onOpen: () => {
          activeTab = "contacts";
        },
      });
    }
  }

  for (const match of rawText.matchAll(UNKNOWN_TEXT_TAG)) {
    const [, number, text] = match;
    const rawNumber = number.trim();
    const cleanText = text.trim();
    // Same "must actually look like a phone number" rule as NUMBER -
    // a stranger's thread should still be keyed by something that
    // could plausibly be dialed, not arbitrary tag text.
    if (!isValidPhoneNumber(rawNumber)) {
      console.warn(
        `[PhoneUI] Ignored [TEXT_UNKNOWN:${rawNumber}] - not a valid-looking phone number.`
      );
      continue;
    }
    const cleanNumber = formatPhoneNumber(rawNumber);
    ensureUnknownContact(cleanNumber);
    typingThreads.add(cleanNumber);
    sawTyping = true;
    const timerId = setTimeout(() => {
      pendingTypingTimers.delete(timerId);
      typingThreads.delete(cleanNumber);
      const st = getSettings();
      if (!st.threads[cleanNumber]) st.threads[cleanNumber] = [];
      st.threads[cleanNumber].push({ who: "npc", text: cleanText, ts: Date.now() });
      st.unread += 1;
      saveSettings();
      renderPanel();
      updateToggleBadge();
      notify({
        icon: "fa-solid fa-comment",
        title: "Unknown number",
        body: cleanText,
        onOpen: () => {
          activeTab = "texts";
          activeThread = cleanNumber;
          activeGroup = null;
        },
      });
    }, typingDelayFor(cleanText));
    pendingTypingTimers.add(timerId);
  }

  for (const match of rawText.matchAll(REPOST_TAG)) {
    const [, reposterName, originalAuthorName, captionRaw] = match;
    const cleanReposter = reposterName.trim();
    const cleanOriginalAuthor = originalAuthorName.trim();
    const cleanCaption = (captionRaw || "").trim();
    if (isBlocked(cleanReposter)) {
      console.warn(`[PhoneUI] Ignored [REPOST:${cleanReposter}:${cleanOriginalAuthor}] - contact is blocked.`);
      continue;
    }
    // Reposts the target author's most recent feed post (s.feed is
    // newest-first, so the first match is the latest one).
    const source = s.feed.find((p) => p.author.toLowerCase() === cleanOriginalAuthor.toLowerCase());
    if (!source) {
      console.warn(
        `[PhoneUI] Ignored [REPOST:${cleanReposter}:${cleanOriginalAuthor}] - no post from ${cleanOriginalAuthor} found to repost.`
      );
      continue;
    }
    ensureContact(cleanReposter);
    // Reposting a repost points back at the original, not the repost.
    const src = source.repostOf || source;
    const { tags, mentions } = extractTagsAndMentions(cleanCaption);
    s.feed.unshift({
      id: crypto.randomUUID(),
      author: cleanReposter,
      caption: cleanCaption,
      tags,
      mentions,
      likes: Math.floor(Math.random() * 6),
      likedByUser: false,
      comments: [],
      ts: Date.now(),
      repostOf: { id: src.id, author: src.author, caption: src.caption, gif: src.gif || null },
    });
    sawSomething = true;
    notify({
      icon: "fa-solid fa-retweet",
      title: `${cleanReposter} reposted`,
      body: `${src.author}: ${src.caption || "a post"}`,
      onOpen: () => {
        activeTab = "feed";
      },
    });
  }

  if (sawSomething) {
    s.unread += 1;
    saveSettings();
  }
  // Typing dots should appear immediately even though nothing's been
  // saved yet - they're transient UI state, not chat data.
  if (sawSomething || sawTyping) {
    renderPanel();
    updateToggleBadge();
  }
}

// ---------------------------------------------------------------
// Sending (user -> chat)
// ---------------------------------------------------------------

// Pushes text into ST's normal input box and fires the send button,
// so the LLM sees it as context and can reply in character.
function sendToChat(formattedText) {
  const textarea = document.querySelector("#send_textarea");
  const sendButton = document.querySelector("#send_but");
  if (!textarea || !sendButton) {
    console.error("[PhoneUI] Could not find chat input to send through.");
    return;
  }
  textarea.value = formattedText;
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  sendButton.click();
}

// ---------------------------------------------------------------
// Notifications (banner popups, like a phone lock screen)
// ---------------------------------------------------------------

function isPanelOpen() {
  const panel = document.querySelector("#phoneui-panel");
  return panel && !panel.classList.contains("phoneui-hidden");
}

function notify({ icon, title, body, onOpen }) {
  // Don't spam banners while the person is already looking at the phone.
  if (isPanelOpen()) return;

  const container = document.querySelector("#phoneui-notifications");
  if (!container) return;

  const banner = document.createElement("div");
  banner.className = "phoneui-toast";
  banner.innerHTML = `
    <i class="${icon} phoneui-toast-icon"></i>
    <div class="phoneui-toast-text">
      <div class="phoneui-toast-title">${escapeHtml(title)}</div>
      <div class="phoneui-toast-body">${escapeHtml(body.slice(0, 80))}</div>
    </div>
    <i class="fa-solid fa-xmark phoneui-toast-close"></i>`;

  banner.addEventListener("click", (e) => {
    if (e.target.classList.contains("phoneui-toast-close")) {
      banner.remove();
      return;
    }
    if (typeof onOpen === "function") onOpen();
    togglePanel();
    banner.remove();
  });

  container.prepend(banner);
  setTimeout(() => banner.remove(), 7000);

  // Keep the stack from growing unbounded if a lot lands at once.
  const all = container.querySelectorAll(".phoneui-toast");
  if (all.length > 4) all[all.length - 1].remove();
}

// ---------------------------------------------------------------
// GIFs / memes (Klipy-backed picker for reacting in chat)
// ---------------------------------------------------------------

// Unlike Giphy, Klipy doesn't publish one shared public demo key -
// every developer gets their own free test key (up to 100 req/hour)
// from the Klipy Partner Panel at klipy.com. So there's no working
// fallback key to ship here; leaving this blank makes getKlipyKey()
// fall through to whatever the user pastes into the settings drawer.
// A missing key (or no internet) is no longer a hard failure though -
// see LOCAL_GIF_LIBRARY below, which is what search/trending fall
// back to whenever Klipy itself isn't reachable.
const KLIPY_FALLBACK_KEY = "";

// Klipy's API wants a customer_id on every request (it's used for its
// per-user Recent-items/analytics features, which this extension
// doesn't use). A random value that stays stable for the lifetime of
// the tab is good enough here.
const KLIPY_CUSTOMER_ID = "phoneui-" + Math.random().toString(36).slice(2) + Date.now().toString(36);

// fetch() with a timeout, so a flaky/half-up connection fails fast
// and falls through to the offline library instead of leaving the
// picker (or an NPC's GIF tag) hanging for a long time.
async function fetchWithTimeout(url, ms = 6000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------
// Offline reaction library - no network, no API key, works entirely
// client-side. Each entry is a tiny looping SVG (built at runtime as
// a data: URI, nothing fetched or bundled as a binary) standing in
// for a "gif" - a big emoji on a soft colour card with a gentle
// bounce animation. This is what search/trending fall back to
// whenever Klipy is unreachable (no key set, offline, request
// failed, or timed out), so GIF/meme reactions always work even with
// zero internet access; a real Klipy key just adds actual gifs into
// the mix on top of this when there's a connection.
function makeLocalGifDataUri(emoji, hue) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">` +
    `<rect width="200" height="200" rx="28" fill="hsl(${hue},70%,88%)"/>` +
    `<text x="100" y="132" font-size="112" text-anchor="middle">` +
    `<animate attributeName="y" values="132;120;132" dur="0.9s" repeatCount="indefinite"/>` +
    `${emoji}</text></svg>`;
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

const LOCAL_GIF_LIBRARY = [
  { id: "laugh", title: "Laughing", emoji: "😂", hue: 45, tags: ["laughing", "laugh", "lol", "funny", "haha"] },
  { id: "cry", title: "Crying", emoji: "😭", hue: 205, tags: ["crying", "cry", "sad", "sob", "tears"] },
  { id: "love", title: "Heart eyes", emoji: "😍", hue: 340, tags: ["heart eyes", "love", "love it", "adore", "swoon"] },
  { id: "shock", title: "Shocked", emoji: "😱", hue: 15, tags: ["shocked", "shock", "surprised", "scream", "omg"] },
  { id: "angry", title: "Angry", emoji: "😡", hue: 5, tags: ["angry", "mad", "rage", "furious"] },
  { id: "eyeroll", title: "Eye roll", emoji: "🙄", hue: 260, tags: ["eye roll", "eyeroll", "whatever", "unimpressed"] },
  { id: "fire", title: "Fire", emoji: "🔥", hue: 25, tags: ["fire", "lit", "hot", "flames"] },
  { id: "dead", title: "Dead", emoji: "💀", hue: 0, tags: ["dead", "skull", "im dead", "deceased"] },
  { id: "sideeye", title: "Side eye", emoji: "👀", hue: 40, tags: ["side eye", "sideeye", "eyes", "suspicious", "watching"] },
  { id: "thumbsup", title: "Thumbs up", emoji: "👍", hue: 130, tags: ["thumbs up", "thumbsup", "yes", "agree", "ok"] },
  { id: "thumbsdown", title: "Thumbs down", emoji: "👎", hue: 0, tags: ["thumbs down", "thumbsdown", "no", "disagree", "nope"] },
  { id: "celebrate", title: "Celebration", emoji: "🎉", hue: 300, tags: ["celebration", "celebrate", "party", "yay", "woo"] },
  { id: "dealwithit", title: "Deal with it", emoji: "🤝", hue: 200, tags: ["deal with it", "deal", "handshake", "agreed"] },
  { id: "clap", title: "Applause", emoji: "👏", hue: 50, tags: ["clap", "applause", "clapping", "bravo", "nice"] },
  { id: "wink", title: "Wink", emoji: "😉", hue: 320, tags: ["wink", "winking", "flirty"] },
  { id: "sleepy", title: "Sleepy", emoji: "😴", hue: 220, tags: ["sleepy", "tired", "sleep", "yawn", "bored"] },
  { id: "thinking", title: "Thinking", emoji: "🤔", hue: 40, tags: ["thinking", "hmm", "confused", "unsure", "suspicious"] },
  { id: "wave", title: "Wave", emoji: "👋", hue: 55, tags: ["wave", "waving", "hi", "hello", "bye", "goodbye"] },
  { id: "dance", title: "Dance", emoji: "💃", hue: 330, tags: ["dance", "dancing", "party"] },
  { id: "mindblown", title: "Mind blown", emoji: "🤯", hue: 15, tags: ["mind blown", "mindblown", "whoa", "shocked", "wow"] },
  { id: "cool", title: "Cool", emoji: "😎", hue: 210, tags: ["cool", "sunglasses", "chill", "smooth"] },
  { id: "blush", title: "Blushing", emoji: "☺️", hue: 350, tags: ["blush", "blushing", "shy", "embarrassed"] },
  { id: "facepalm", title: "Facepalm", emoji: "🤦", hue: 25, tags: ["facepalm", "smh", "ugh", "cringe"] },
  { id: "nervous", title: "Nervous", emoji: "😬", hue: 60, tags: ["nervous", "awkward", "yikes", "grimace"] },
  { id: "hug", title: "Hug", emoji: "🤗", hue: 30, tags: ["hug", "hugging", "comfort", "there there"] },
  { id: "kiss", title: "Kiss", emoji: "😘", hue: 345, tags: ["kiss", "kissing", "love", "xoxo"] },
  { id: "heart", title: "Heart", emoji: "❤️", hue: 355, tags: ["heart", "love", "like"] },
  { id: "sob", title: "Loud sobbing", emoji: "😢", hue: 210, tags: ["sob", "crying", "sad", "tears", "upset"] },
  { id: "smirk", title: "Smirk", emoji: "😏", hue: 280, tags: ["smirk", "smug", "sly", "sarcastic"] },
  { id: "clown", title: "Clown", emoji: "🤡", hue: 0, tags: ["clown", "joke", "ridiculous"] },
];

function localGifResult(entry) {
  const uri = makeLocalGifDataUri(entry.emoji, entry.hue);
  return { id: "local-" + entry.id, url: uri, preview: uri, title: entry.title, source: "local" };
}

function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function searchLocalGifs(query) {
  const q = (query || "").toLowerCase().trim();
  if (!q) return shuffled(LOCAL_GIF_LIBRARY).map(localGifResult);
  const words = q.split(/\s+/).filter(Boolean);
  const scored = LOCAL_GIF_LIBRARY.map((entry) => {
    let score = 0;
    for (const w of words) {
      if (entry.tags.some((t) => t === w)) score += 3;
      else if (entry.tags.some((t) => t.includes(w) || w.includes(t))) score += 2;
      if (entry.title.toLowerCase().includes(w)) score += 1;
    }
    return { entry, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const matched = scored.filter((s) => s.score > 0).map((s) => s.entry);
  const pool = matched.length ? matched : shuffled(LOCAL_GIF_LIBRARY);
  return pool.map(localGifResult);
}

// Quick-tap shortcuts for common chat reactions, each mapped to a
// search term so picking a "reaction" is one tap instead of having
// to type a search query every time.
const GIF_QUICK_REACTIONS = [
  { emoji: "😂", label: "Laughing", query: "laughing" },
  { emoji: "😭", label: "Crying", query: "crying" },
  { emoji: "😍", label: "Love it", query: "heart eyes" },
  { emoji: "😱", label: "Shocked", query: "shocked" },
  { emoji: "😡", label: "Angry", query: "angry" },
  { emoji: "🙄", label: "Eye roll", query: "eye roll" },
  { emoji: "🔥", label: "Fire", query: "fire" },
  { emoji: "💀", label: "Dead", query: "dead" },
  { emoji: "👀", label: "Side eye", query: "side eye" },
  { emoji: "👍", label: "Thumbs up", query: "thumbs up" },
  { emoji: "🎉", label: "Celebrate", query: "celebration" },
  { emoji: "🤝", label: "Deal", query: "deal with it" },
];

function getKlipyKey() {
  const s = getSettings();
  return (s.gifApiKey || "").trim() || KLIPY_FALLBACK_KEY;
}

class KlipyKeyMissingError extends Error {}

// Klipy nests each size variant (e.g. "hd", "md", "sm", "xs") under
// `files`, and each variant can carry gif/mp4/webp sub-formats. Field
// names have shifted a bit across Klipy API versions, so this pulls
// the best available url/preview defensively instead of assuming one
// exact shape.
function pickKlipyFormat(files) {
  if (!files || typeof files !== "object") return null;
  const sizeOrder = ["hd", "md", "sm", "xs", "4xs", "original"];
  const typeOrder = ["gif", "webp", "mp4"];
  for (const size of sizeOrder) {
    const variant = files[size];
    if (!variant) continue;
    for (const type of typeOrder) {
      const f = variant[type];
      if (f && (f.url || f.src)) return f;
    }
    // Some responses put url/width/height directly on the size object.
    if (variant.url || variant.src) return variant;
  }
  return null;
}

function normalizeKlipyResult(g) {
  // Klipy's own docs call this field `files`, but real-world responses
  // have also been seen keyed as `file` (singular) - check both.
  const files = g.files || g.file || null;
  const full = pickKlipyFormat(files) || {};
  const previewSize = (files && (files.sm || files.xs || files["4xs"])) || null;
  const preview = pickKlipyFormat(previewSize ? { sm: previewSize } : null) || full;
  const url = full.url || full.src || g.url;
  return {
    id: g.id || g.slug,
    url,
    preview: preview.url || preview.src || url,
    title: g.title || g.slug || "gif",
  };
}

function klipyBaseUrl(kind) {
  const key = getKlipyKey();
  if (!key) throw new KlipyKeyMissingError("No Klipy API key configured.");
  return `https://api.klipy.com/api/v1/${encodeURIComponent(key)}/gifs/${kind}`;
}

// online-ness is checked defensively - navigator.onLine can be wrong
// (e.g. true on a captive portal with no real access), so it's only
// used to skip an attempt we already know will fail, never trusted as
// proof a request will succeed. The real safety net is the try/catch
// below falling through to the offline library on any failure.
function looksOnline() {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

async function klipySearch(query) {
  const key = getKlipyKey();
  if (key && looksOnline()) {
    try {
      const url = `${klipyBaseUrl("search")}?q=${encodeURIComponent(query)}&per_page=24&page=1&customer_id=${encodeURIComponent(KLIPY_CUSTOMER_ID)}`;
      const res = await fetchWithTimeout(url);
      if (!res.ok) throw new Error(`Klipy search failed (${res.status})`);
      const data = await res.json();
      const items = (data.data && data.data.data) || data.data || [];
      const mapped = items.map(normalizeKlipyResult);
      if (mapped.length) return mapped;
    } catch (e) {
      console.warn("[PhoneUI] Klipy search unavailable, using the offline reaction library instead.", e);
    }
  }
  return searchLocalGifs(query);
}

async function klipyTrending() {
  const key = getKlipyKey();
  if (key && looksOnline()) {
    try {
      const url = `${klipyBaseUrl("trending")}?per_page=24&page=1&customer_id=${encodeURIComponent(KLIPY_CUSTOMER_ID)}`;
      const res = await fetchWithTimeout(url);
      if (!res.ok) throw new Error(`Klipy trending failed (${res.status})`);
      const data = await res.json();
      const items = (data.data && data.data.data) || data.data || [];
      const mapped = items.map(normalizeKlipyResult);
      if (mapped.length) return mapped;
    } catch (e) {
      console.warn("[PhoneUI] Klipy trending unavailable, using the offline reaction library instead.", e);
    }
  }
  return searchLocalGifs("");
}

// Picks a GIF for an NPC-triggered tag ([GIF], [GROUPGIF], etc.) -
// same Klipy backend as the user-facing picker, just auto-picking the
// top result instead of showing a grid to tap. Returns null (instead
// of throwing) on any failure, so callers can fall back to a plain
// text bubble explaining what happened.
async function resolveGifForQuery(query) {
  const q = (query || "").trim();
  try {
    const results = q ? await klipySearch(q) : await klipyTrending();
    return results[0] || null;
  } catch (e) {
    console.error("[PhoneUI] NPC GIF fetch failed.", e);
    return null;
  }
}

// Keeps any one character from spamming GIFs - across texts, group
// chats, Discord, and posts alike, since they all funnel through the
// same per-name cooldown. Deliberately generous (a minute) since it's
// meant to stop reaction spam, not stop a character from ever sending
// a second GIF in a scene.
const GIF_COOLDOWN_MS = 60_000;

function canSendNpcGif(senderName) {
  const st = getSettings();
  const last = st.lastGifSentAt[senderName] || 0;
  return Date.now() - last >= GIF_COOLDOWN_MS;
}

// Marked synchronously, before the (async) GIF fetch even starts, so
// that if a model stuffs several GIF tags for the same character into
// one message, only the first is honored instead of all of them
// racing past the cooldown check together.
function markNpcGifSent(senderName) {
  const st = getSettings();
  st.lastGifSentAt[senderName] = Date.now();
}

// Picker state. onSelect(gifObj) is called (and the picker closed)
// when the user taps a result.
let gifPicker = {
  open: false,
  onSelect: null,
  query: "",
  loading: false,
  error: null,
  results: [],
  requestId: 0,
};

function openGifPicker(onSelect) {
  gifPicker = { open: true, onSelect, query: "", loading: true, error: null, results: [], requestId: gifPicker.requestId + 1 };
  renderPanel();
  runGifSearch("");
}

function closeGifPicker() {
  gifPicker.open = false;
  renderPanel();
}

async function runGifSearch(query) {
  const myRequest = ++gifPicker.requestId;
  gifPicker.loading = true;
  gifPicker.error = null;
  renderGifPickerOnly();
  try {
    // klipySearch/klipyTrending never throw - they fall back to the
    // offline reaction library on any failure - so this branch is
    // just a last-resort safety net.
    const results = query.trim() ? await klipySearch(query.trim()) : await klipyTrending();
    if (myRequest !== gifPicker.requestId) return; // a newer search superseded this one
    gifPicker.results = results;
    gifPicker.loading = false;
  } catch (e) {
    if (myRequest !== gifPicker.requestId) return;
    console.error("[PhoneUI] GIF search failed unexpectedly.", e);
    gifPicker.loading = false;
    gifPicker.error = "Couldn't load GIFs or reactions. Try again in a moment.";
  }
  renderGifPickerOnly();
}

let gifSearchDebounce = null;
function debouncedGifSearch(query) {
  gifPicker.query = query;
  clearTimeout(gifSearchDebounce);
  gifSearchDebounce = setTimeout(() => runGifSearch(query), 400);
}

// Re-renders just the picker overlay in place, without tearing down
// and rebuilding the whole tab body (which would lose input focus).
function renderGifPickerOnly() {
  const overlay = document.querySelector("#phoneui-gifpicker");
  if (!overlay) return;
  overlay.outerHTML = renderGifPicker();
  attachGifPickerListeners();
}

function renderGifPicker() {
  if (!gifPicker.open) return "";
  return `
    <div id="phoneui-gifpicker" class="phoneui-gifpicker">
      <div class="phoneui-gifpickerhead">
        <i class="fa-solid fa-chevron-left" id="phoneui-gifback"></i>
        <input type="text" id="phoneui-gifsearch" placeholder="Search GIFs..." value="${escapeHtml(gifPicker.query)}" />
      </div>
      <div class="phoneui-gifquick">
        ${GIF_QUICK_REACTIONS.map(
          (r) => `<div class="phoneui-gifquickchip" data-query="${escapeHtml(r.query)}" title="${escapeHtml(r.label)}">${r.emoji}</div>`
        ).join("")}
      </div>
      <div class="phoneui-gifgrid">
        ${
          gifPicker.loading
            ? `<div class="phoneui-empty">Loading GIFs...</div>`
            : gifPicker.error
            ? `<div class="phoneui-empty">${escapeHtml(gifPicker.error)}</div>`
            : gifPicker.results.length === 0
            ? `<div class="phoneui-empty">No GIFs found. Try a different search.</div>`
            : gifPicker.results
                .map(
                  (g) =>
                    `<img class="phoneui-gifoption" src="${escapeHtml(g.preview)}" data-gifid="${escapeHtml(g.id)}" alt="${escapeHtml(g.title)}" />`
                )
                .join("")
        }
      </div>
    </div>`;
}

function attachGifPickerListeners() {
  document.querySelector("#phoneui-gifback")?.addEventListener("click", closeGifPicker);
  const searchInput = document.querySelector("#phoneui-gifsearch");
  searchInput?.addEventListener("input", (e) => debouncedGifSearch(e.target.value));
  // Keep focus/cursor in the search box across re-renders while typing.
  if (searchInput && document.activeElement !== searchInput && gifPicker.query) {
    searchInput.focus();
    searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length);
  }
  document.querySelectorAll(".phoneui-gifquickchip").forEach((el) => {
    el.addEventListener("click", () => {
      const q = el.dataset.query;
      const input = document.querySelector("#phoneui-gifsearch");
      if (input) input.value = q;
      debouncedGifSearch(q);
    });
  });
  document.querySelectorAll(".phoneui-gifoption").forEach((el) => {
    el.addEventListener("click", () => {
      const gif = gifPicker.results.find((g) => String(g.id) === el.dataset.gifid);
      if (!gif) return;
      const cb = gifPicker.onSelect;
      closeGifPicker();
      if (typeof cb === "function") cb(gif);
    });
  });
}

function userSendText(contactName, text, gif, note) {
  const s = getSettings();
  if (!s.threads[contactName]) s.threads[contactName] = [];
  s.threads[contactName].push({ who: "user", text, gif: gif || null, ts: Date.now() });
  saveSettings();
  renderPanel();
  const gifNote = gif ? `[sent a GIF reaction: "${gif.title}"] ` : "";
  const contextNote = note ? `${note} ` : "";
  sendToChat(`[TEXT:${context.name1 || "User"} to ${contactName}] ${contextNote}${gifNote}${text}`.trim());
}

function userSendGroupText(groupName, text, gif) {
  const s = getSettings();
  if (!s.groupThreads[groupName]) s.groupThreads[groupName] = [];
  s.groupThreads[groupName].push({ who: "user", sender: context.name1 || "User", text, gif: gif || null, ts: Date.now() });
  saveSettings();
  renderPanel();
  const gifNote = gif ? `[sent a GIF reaction: "${gif.title}"] ` : "";
  sendToChat(`[GROUPTEXT:${groupName}:${context.name1 || "User"}] ${gifNote}${text}`.trim());
}

function userSendPost(caption, gif) {
  const s = getSettings();
  const { tags, mentions } = extractTagsAndMentions(caption);
  s.feed.unshift({
    id: crypto.randomUUID(),
    author: context.name1 || "User",
    caption,
    gif: gif || null,
    tags,
    mentions,
    likes: 0,
    likedByUser: false,
    comments: [],
    ts: Date.now(),
  });
  saveSettings();
  renderPanel();
  const gifNote = gif ? `[posted a GIF/meme: "${gif.title}"] ` : "";
  sendToChat(`[POST:${context.name1 || "User"}] ${gifNote}${caption}`.trim());
}

function userComment(postId, text) {
  const s = getSettings();
  const post = s.feed.find((p) => p.id === postId);
  if (!post) return;
  post.comments.push({ author: context.name1 || "User", text });
  saveSettings();
  renderPanel();
  sendToChat(`[COMMENT on ${post.author}'s post: "${post.caption.slice(0, 40)}"] ${text}`);
}

function acceptInvite(inviteId) {
  const s = getSettings();
  const invite = s.discordInvites.find((i) => i.id === inviteId);
  if (!invite) return;
  ensureServer(invite.server);
  s.discordInvites = s.discordInvites.filter((i) => i.id !== inviteId);
  saveSettings();
  renderPanel();
  sendToChat(`[SYSTEM] ${context.name1 || "User"} accepted the invite to join the "${invite.server}" Discord server.`);
}

function declineInvite(inviteId) {
  const s = getSettings();
  s.discordInvites = s.discordInvites.filter((i) => i.id !== inviteId);
  saveSettings();
  renderPanel();
}

function userSendDiscordMessage(serverName, channelName, text, gif) {
  const s = getSettings();
  const server = s.discordServers[serverName];
  if (!server) return;
  if (!server.channels[channelName]) server.channels[channelName] = [];
  server.channels[channelName].push({
    author: context.name1 || "User",
    text,
    gif: gif || null,
    isUser: true,
    ts: Date.now(),
  });
  saveSettings();
  renderPanel();
  const gifNote = gif ? `[sent a GIF reaction: "${gif.title}"] ` : "";
  sendToChat(`[DISCORD:${serverName}>${channelName} from ${context.name1 || "User"}] ${gifNote}${text}`.trim());
}

function toggleLike(postId) {
  const s = getSettings();
  const post = s.feed.find((p) => p.id === postId);
  if (!post) return;
  post.likedByUser = !post.likedByUser;
  post.likes += post.likedByUser ? 1 : -1;
  saveSettings();
  renderPanel();
}

// Reposts an existing feed post as the user, with an optional caption
// of their own - the user-facing equivalent of an NPC's [REPOST] tag.
function userRepost(postId) {
  const s = getSettings();
  const original = s.feed.find((p) => p.id === postId);
  if (!original) return;
  const captionInput = prompt("Add a caption to your repost (optional):", "");
  if (captionInput === null) return; // cancelled
  const cleanCaption = captionInput.trim();
  const { tags, mentions } = extractTagsAndMentions(cleanCaption);
  // Reposting a repost points back at the original, not the repost.
  const src = original.repostOf || original;
  s.feed.unshift({
    id: crypto.randomUUID(),
    author: context.name1 || "User",
    caption: cleanCaption,
    tags,
    mentions,
    likes: 0,
    likedByUser: false,
    comments: [],
    ts: Date.now(),
    repostOf: { id: src.id, author: src.author, caption: src.caption, gif: src.gif || null },
  });
  saveSettings();
  renderPanel();
  const captionNote = cleanCaption ? ` ${cleanCaption}` : "";
  sendToChat(`[REPOST:${context.name1 || "User"}:${src.author}]${captionNote}`.trim());
}

// ---------------------------------------------------------------
// Stories (derived from recent Feed posts - no separate data to
// maintain, one strip entry per author who's posted recently)
// ---------------------------------------------------------------

const STORY_WINDOW_MS = 24 * 60 * 60 * 1000; // posts from the last 24h show up as stories
const STORY_DURATION_MS = 5000; // how long each story auto-plays before advancing

// Groups the feed's recent posts by author, oldest-first per author
// (so a person's stories play back in the order they posted them).
// Returns a Map so insertion order (= first-seen order scanning the
// feed) is preserved for "which author comes next" navigation.
function getStoryGroups() {
  const s = getSettings();
  const cutoff = Date.now() - STORY_WINDOW_MS;
  const byAuthor = new Map();
  // s.feed is newest-first; walk it in reverse to build each author's
  // posts oldest-first.
  for (let i = s.feed.length - 1; i >= 0; i--) {
    const p = s.feed[i];
    if (p.ts < cutoff) continue;
    if (!byAuthor.has(p.author)) byAuthor.set(p.author, []);
    byAuthor.get(p.author).push(p);
  }
  return byAuthor;
}

let storyViewer = { open: false, author: null, index: 0, timerId: null };
// Draft text for the story-reply box, kept outside storyViewer so it
// survives the re-renders that don't touch it (typing indicators,
// etc.) without losing focus - same pattern as messageDrafts.
let storyReplyDraft = "";

function stopStoryTimer() {
  if (storyViewer.timerId) {
    clearTimeout(storyViewer.timerId);
    storyViewer.timerId = null;
  }
}

function closeStoryViewer() {
  stopStoryTimer();
  storyViewer = { open: false, author: null, index: 0, timerId: null };
  storyReplyDraft = "";
  renderPanel();
}

// Replying to a story becomes a normal DM to that character - closes
// the viewer and drops the user straight into the resulting thread,
// same as tapping "reply" on a real stories UI.
function replyToStory(text) {
  if (!storyViewer.open || !text.trim()) return;
  const author = storyViewer.author;
  stopStoryTimer();
  storyViewer = { open: false, author: null, index: 0, timerId: null };
  storyReplyDraft = "";
  userSendText(author, text.trim(), null, "(replying to their story)");
  activeTab = "texts";
  activeThread = author;
  activeGroup = null;
  renderPanel();
}

function markStoryViewed(author) {
  const s = getSettings();
  s.storiesViewed[author] = Date.now();
  saveSettings();
}

function openStoryViewer(author) {
  const groups = getStoryGroups();
  if (!groups.has(author)) return;
  stopStoryTimer();
  storyViewer = { open: true, author, index: 0, timerId: null };
  markStoryViewed(author);
  renderPanel();
}

// delta is +1 (next) or -1 (previous). Falls off the end of one
// author's stories into the next author's, like real stories UIs.
function advanceStory(delta) {
  const groups = getStoryGroups();
  const posts = groups.get(storyViewer.author) || [];
  const nextIndex = storyViewer.index + delta;

  if (nextIndex < 0) {
    storyViewer.index = 0; // already first story - just restart it
    renderPanel();
    return;
  }
  if (nextIndex >= posts.length) {
    const authors = [...groups.keys()];
    const nextAuthor = authors[authors.indexOf(storyViewer.author) + 1];
    if (nextAuthor) openStoryViewer(nextAuthor);
    else closeStoryViewer();
    return;
  }
  storyViewer.index = nextIndex;
  markStoryViewed(storyViewer.author);
  renderPanel();
}

// Called after every render; (re)starts the auto-advance timer only
// while the viewer is actually open, and never lets more than one
// timer run at once.
function scheduleStoryAdvance() {
  stopStoryTimer();
  if (!storyViewer.open) return;
  if (storyReplyDraft) return; // don't auto-advance out from under a reply in progress
  storyViewer.timerId = setTimeout(() => advanceStory(1), STORY_DURATION_MS);
}

function renderStoriesStrip() {
  const groups = getStoryGroups();
  if (groups.size === 0) return "";
  const s = getSettings();
  return `<div class="phoneui-stories">
    ${[...groups.entries()]
      .map(([author, posts]) => {
        const latest = posts[posts.length - 1];
        const seen = (s.storiesViewed[author] || 0) >= latest.ts;
        return `<div class="phoneui-story" data-storyauthor="${escapeHtml(author)}">
          <div class="phoneui-story-ring ${seen ? "phoneui-story-seen" : ""}">
            ${avatarHtml(initials(author), avatarPhotoFor(author))}
          </div>
          <span>${escapeHtml(author)}</span>
        </div>`;
      })
      .join("")}
  </div>`;
}

function renderStoryViewer() {
  if (!storyViewer.open) return "";
  const groups = getStoryGroups();
  const posts = groups.get(storyViewer.author) || [];
  const post = posts[storyViewer.index];
  if (!post) return "";
  return `<div class="phoneui-storyviewer" id="phoneui-storyviewer">
    <div class="phoneui-storyprogress">
      ${posts
        .map(
          (_, i) =>
            `<div class="phoneui-storyprogressbar"><div class="phoneui-storyprogressfill ${
              i < storyViewer.index
                ? "phoneui-storyprogressdone"
                : i === storyViewer.index
                ? "phoneui-storyprogressactive"
                : ""
            }"></div></div>`
        )
        .join("")}
    </div>
    <div class="phoneui-storyheader">
      ${avatarHtml(initials(storyViewer.author), avatarPhotoFor(storyViewer.author), "phoneui-avatar-sm")}
      <span>${escapeHtml(storyViewer.author)}</span>
      <i class="fa-solid fa-xmark" id="phoneui-storyclose"></i>
    </div>
    <div class="phoneui-storybody">
      ${post.gif ? `<img src="${escapeHtml(post.gif.url)}" alt="${escapeHtml(post.gif.title)}" />` : ""}
      ${post.caption ? `<div class="phoneui-storycaption">${renderCaption(post.caption)}</div>` : ""}
      <div class="phoneui-storytap phoneui-storytap-left" id="phoneui-storyprev"></div>
      <div class="phoneui-storytap phoneui-storytap-right" id="phoneui-storynext"></div>
    </div>
    <div class="phoneui-inputrow phoneui-storyreply">
      <input type="text" id="phoneui-storyreplyinput" placeholder="Reply to ${escapeHtml(
        storyViewer.author
      )}" value="${escapeHtml(storyReplyDraft)}" />
      <i class="fa-solid fa-arrow-up" id="phoneui-storyreplysend"></i>
    </div>
  </div>`;
}

// ---------------------------------------------------------------
// UI construction
// ---------------------------------------------------------------

let activeTab = "home";
let activeThread = null;
let activeGroup = null;
let activeServer = null;
let activeChannel = null;
// In-progress reply text for the active thread/group - kept here so
// that renderPanel() calls triggered in the background (typing
// indicators starting/stopping, an incoming message arriving) don't
// wipe out a draft the user is still typing. Same pattern as
// groupCreate.name below.
let messageDrafts = { threads: {}, groups: {} };
// In-progress "start a new group" form (name + which contacts are picked).
let groupCreate = { open: false, name: "", selected: new Set() };

// Fake "typing..." delay state - transient/in-memory only (not saved
// to chat metadata, doesn't need to survive a reload). Tracks who
// currently *appears* to be typing so the UI can show animated dots
// before their [TEXT:]/[GROUPTEXT:] message actually lands in the
// thread. Cleared the moment each message is delivered.
let typingThreads = new Set(); // contact names typing in a 1:1 thread
let typingGroups = {}; // { groupName: Set(sender names typing in that group) }
// Pending setTimeout ids for in-flight typing deliveries, so they can
// be cancelled if the chat changes before they fire (otherwise a
// delayed message from the old chat would land in whichever chat is
// active when the timer finally goes off).
let pendingTypingTimers = new Set();

function clearTypingState() {
  for (const id of pendingTypingTimers) clearTimeout(id);
  pendingTypingTimers.clear();
  typingThreads.clear();
  typingGroups = {};
}

function groupTypingNames(groupName) {
  return typingGroups[groupName] ? [...typingGroups[groupName]] : [];
}

// Roughly scales with message length so a one-word reply lands fast
// and a longer one takes a beat longer, with a little randomness so
// it doesn't feel mechanical. Capped so nobody waits too long.
function typingDelayFor(text) {
  const base = 600;
  const perChar = 18;
  const jitter = Math.random() * 600;
  return Math.min(base + text.length * perChar + jitter, 3000);
}

function panelSkeleton() {
  return `
  <div id="phoneui-panel" class="phoneui-hidden">
    <div class="phoneui-frame">
      <div class="phoneui-statusbar" id="phoneui-statusbar"><span>9:41</span><i class="fa-solid fa-signal"></i></div>
      <div class="phoneui-body" id="phoneui-body"></div>
      <div class="phoneui-homebar">
        <div class="phoneui-homebtn" id="phoneui-homebtn" title="Home"></div>
      </div>
    </div>
  </div>`;
}

// The home screen: a grid of app icons (Texts, Feed, Discord,
// Contacts, Compose), same idea as a phone's springboard. Each icon
// carries its own unread badge where that's meaningful, instead of
// one combined count - lets you tell at a glance which app actually
// needs attention.
function renderHome() {
  const s = getSettings();
  const pendingInvites = (s.discordInvites || []).length;
  const apps = [
    { tab: "texts", label: "Texts", icon: "fa-solid fa-comment", bg: "#2d5ea8", badge: s.unread || 0 },
    { tab: "feed", label: "Feed", icon: "fa-solid fa-images", bg: "#a83c3c" },
    { tab: "discord", label: "Discord", icon: "fa-brands fa-discord", bg: "#5865f2", badge: pendingInvites },
    { tab: "contacts", label: "Contacts", icon: "fa-solid fa-address-book", bg: "#3c8a5c" },
    { tab: "compose", label: "Compose", icon: "fa-solid fa-pen", bg: "#a8843c" },
  ];
  return `
  <div class="phoneui-homescreen">
    <div class="phoneui-homegrid">
      ${apps
        .map(
          (app) => `
        <div class="phoneui-appicon" data-tab="${app.tab}">
          <div class="phoneui-appicon-glyph" style="background:${app.bg}">
            <i class="${app.icon}"></i>
            ${app.badge ? `<span class="phoneui-appicon-badge">${app.badge > 99 ? "99+" : app.badge}</span>` : ""}
          </div>
          <span class="phoneui-appicon-label">${app.label}</span>
        </div>`
        )
        .join("")}
    </div>
  </div>`;
}

// Shared reset used both by the home button and anywhere else that
// needs to drop back to the springboard - clears whatever sub-view
// state (open thread, channel, story, gif picker...) belonged to
// whichever app was open, so returning to an app fresh later doesn't
// resume some stale in-progress state.
function goHome() {
  activeTab = "home";
  activeThread = null;
  activeGroup = null;
  activeServer = null;
  activeChannel = null;
  groupCreate = { open: false, name: "", selected: new Set() };
  gifPicker.open = false;
  stopStoryTimer();
  storyViewer = { open: false, author: null, index: 0, timerId: null };
  renderPanel();
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

function renderCaption(caption) {
  return escapeHtml(caption)
    .replace(/#(\w+)/g, '<span class="phoneui-tag">#$1</span>')
    .replace(/@(\w+)/g, '<span class="phoneui-mention">@$1</span>');
}

// ---------------------------------------------------------------
// Read receipts (derived from the thread itself - no extra data to
// store: a user message counts as "seen" once anyone has replied
// after it, since in a text-roleplay context a reply implies the
// character read it)
// ---------------------------------------------------------------

function findLastUserIndex(msgs) {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].who === "user") return i;
  }
  return -1;
}

// 1:1 thread: "Delivered" until the contact sends anything after the
// user's last message, then "Seen".
function render1to1Receipt(msgs, lastUserIndex) {
  const seen = msgs.slice(lastUserIndex + 1).some((m) => m.who === "npc");
  return seen
    ? `<div class="phoneui-receipt"><i class="fa-solid fa-check-double"></i> Seen</div>`
    : `<div class="phoneui-receipt"><i class="fa-solid fa-check"></i> Delivered</div>`;
}

// Group thread: "Delivered" until at least one member has replied
// after the user's last message, then "Seen by <names who replied>"
// (or "Seen by all" once every member has).
function renderGroupReceipt(msgs, lastUserIndex, members) {
  const repliedAfter = new Set(
    msgs
      .slice(lastUserIndex + 1)
      .filter((m) => m.who === "npc")
      .map((m) => m.sender)
  );
  if (repliedAfter.size === 0) {
    return `<div class="phoneui-receipt"><i class="fa-solid fa-check"></i> Delivered</div>`;
  }
  const allSeen = members.every((mem) => repliedAfter.has(mem));
  const label = allSeen ? "Seen by all" : `Seen by ${[...repliedAfter].map((n) => escapeHtml(n)).join(", ")}`;
  return `<div class="phoneui-receipt"><i class="fa-solid fa-check-double"></i> ${label}</div>`;
}

// One "..." bubble per person currently typing. Group bubbles get a
// sender label above the dots, same as a real group message would.
function renderTypingBubble(sender) {
  return `<div class="phoneui-bubble phoneui-bubble-npc phoneui-typing">${
    sender ? `<div class="phoneui-bubblesender">${escapeHtml(sender)}</div>` : ""
  }<div class="phoneui-typingdots"><span></span><span></span><span></span></div></div>`;
}

function renderTexts() {
  const s = getSettings();

  // Group thread view
  if (activeGroup && s.groups[activeGroup]) {
    const group = s.groups[activeGroup];
    const msgs = s.groupThreads[activeGroup] || [];
    const lastUserIndex = findLastUserIndex(msgs);
    const typingNames = groupTypingNames(activeGroup);
    const headerSub = typingNames.length
      ? `<span class="phoneui-threadheadersub phoneui-typingsub">${
          typingNames.length === 1
            ? `${escapeHtml(typingNames[0])} is typing…`
            : `${typingNames.map((n) => escapeHtml(n)).join(", ")} are typing…`
        }</span>`
      : `<span class="phoneui-threadheadersub">${group.members.map((m) => escapeHtml(m)).join(", ")}</span>`;
    return `
      <div class="phoneui-threadheader">
        <i class="fa-solid fa-chevron-left" id="phoneui-back"></i>
        <div class="phoneui-avatar phoneui-groupavatar">${group.avatar}</div>
        <div class="phoneui-threadheadertext">
          <span>${escapeHtml(activeGroup)}</span>
          ${headerSub}
        </div>
      </div>
      <div class="phoneui-messages">
        ${msgs
          .map((m, i) => {
            const bubble = `<div class="phoneui-bubble ${m.who === "user" ? "phoneui-bubble-user" : "phoneui-bubble-npc"}">${
              m.who === "npc" ? `<div class="phoneui-bubblesender">${escapeHtml(m.sender)}</div>` : ""
            }${m.gif ? `<img class="phoneui-msggif" src="${escapeHtml(m.gif.url)}" alt="${escapeHtml(m.gif.title)}" />` : ""}${
              m.text ? escapeHtml(m.text) : ""
            }</div>`;
            return i === lastUserIndex ? bubble + renderGroupReceipt(msgs, lastUserIndex, group.members) : bubble;
          })
          .join("")}
        ${typingNames.map((n) => renderTypingBubble(n)).join("")}
      </div>
      ${renderGifPicker()}
      <div class="phoneui-inputrow">
        <input type="text" id="phoneui-grouptextinput" placeholder="Message ${escapeHtml(activeGroup)}" value="${escapeHtml(
          messageDrafts.groups[activeGroup] || ""
        )}" />
        <i class="fa-solid fa-face-grin-squint" id="phoneui-grouptextgifbtn" title="Send a GIF"></i>
        <i class="fa-solid fa-arrow-up" id="phoneui-grouptextsend"></i>
      </div>`;
  }

  // 1:1 thread view
  if (activeThread && s.threads[activeThread]) {
    const msgs = s.threads[activeThread];
    const lastUserIndex = findLastUserIndex(msgs);
    const isTyping = typingThreads.has(activeThread);
    const contact = s.contacts[activeThread];
    const isUnknown = !!contact?.unknown;
    const isBlockedContact = !isUnknown && !!contact?.blocked;
    const contactPhone = contact?.phone;
    const headerLabel = displayName(activeThread, contact);
    return `
      <div class="phoneui-threadheader">
        <i class="fa-solid fa-chevron-left" id="phoneui-back"></i>
        ${avatarHtml(contact?.avatar || "?", contact ? avatarPhotoFor(activeThread) : null)}
        <div class="phoneui-threadheadertext">
          <span>${escapeHtml(headerLabel)}</span>
          ${
            isTyping
              ? `<span class="phoneui-threadheadersub phoneui-typingsub">typing…</span>`
              : isUnknown
              ? `<span class="phoneui-threadheadersub">${escapeHtml(activeThread)}</span>`
              : contact?.nickname
              ? `<span class="phoneui-threadheadersub">${escapeHtml(activeThread)}${
                  contactPhone ? ` · ${escapeHtml(contactPhone)}` : ""
                }</span>`
              : contactPhone
              ? `<span class="phoneui-threadheadersub">${escapeHtml(contactPhone)}</span>`
              : ""
          }
        </div>
        <div class="phoneui-threadheaderactions">
          <i class="fa-solid fa-camera" data-setphoto="${escapeHtml(activeThread)}" title="Set contact photo"></i>
          ${
            contact?.photo
              ? `<i class="fa-solid fa-image-slash" data-removephoto="${escapeHtml(
                  activeThread
                )}" title="Remove photo"></i>`
              : ""
          }
          <i class="fa-solid fa-pen" data-nickname="${escapeHtml(activeThread)}" title="Edit nickname"></i>
          ${
            !isUnknown
              ? `<i class="fa-solid fa-ban ${isBlockedContact ? "phoneui-blocked" : ""}" data-blocktoggle="${escapeHtml(
                  activeThread
                )}" title="${isBlockedContact ? "Unblock" : "Block/mute"}"></i>`
              : ""
          }
        </div>
      </div>
      ${
        isUnknown
          ? `<div class="phoneui-addcontact">
              <input type="text" id="phoneui-saveunknown" placeholder="Save as contact name" />
              <i class="fa-solid fa-check" id="phoneui-saveunknownbtn"></i>
            </div>`
          : ""
      }
      <div class="phoneui-messages">
        ${msgs
          .map((m, i) => {
            const bubble = `<div class="phoneui-bubble ${m.who === "user" ? "phoneui-bubble-user" : "phoneui-bubble-npc"}">${
              m.gif ? `<img class="phoneui-msggif" src="${escapeHtml(m.gif.url)}" alt="${escapeHtml(m.gif.title)}" />` : ""
            }${m.text ? escapeHtml(m.text) : ""}</div>`;
            return i === lastUserIndex ? bubble + render1to1Receipt(msgs, lastUserIndex) : bubble;
          })
          .join("")}
        ${isTyping ? renderTypingBubble() : ""}
      </div>
      ${
        isBlockedContact
          ? `<div class="phoneui-blockednotice">You've blocked ${escapeHtml(
              activeThread
            )}. <button data-blocktoggle="${escapeHtml(activeThread)}">Unblock</button></div>`
          : `${renderGifPicker()}
      <div class="phoneui-inputrow">
        <input type="text" id="phoneui-textinput" placeholder="Message" value="${escapeHtml(
          messageDrafts.threads[activeThread] || ""
        )}" />
        <i class="fa-solid fa-face-grin-squint" id="phoneui-textgifbtn" title="Send a GIF"></i>
        <i class="fa-solid fa-arrow-up" id="phoneui-textsend"></i>
      </div>`
      }`;
  }

  // New-group picker
  if (groupCreate.open) {
    const contactNames = Object.keys(s.contacts);
    return `
      <div class="phoneui-threadheader">
        <i class="fa-solid fa-chevron-left" id="phoneui-groupcreate-back"></i>
        <span>New group</span>
      </div>
      <div class="phoneui-addcontact">
        <input type="text" id="phoneui-groupname" placeholder="Group name" value="${escapeHtml(groupCreate.name)}" />
      </div>
      ${
        contactNames.length === 0
          ? `<div class="phoneui-empty">Add a contact first, then come back to start a group.</div>`
          : `<div class="phoneui-list">
              ${contactNames
                .map(
                  (n) => `<div class="phoneui-listitem phoneui-groupmemberitem" data-member="${escapeHtml(n)}">
                    ${avatarHtml(s.contacts[n].avatar, avatarPhotoFor(n))}
                    <div class="phoneui-listtext"><div class="phoneui-listname">${escapeHtml(
                      displayName(n, s.contacts[n])
                    )}</div></div>
                    <i class="fa-solid ${
                      groupCreate.selected.has(n) ? "fa-square-check" : "fa-square"
                    } phoneui-groupmembercheck"></i>
                  </div>`
                )
                .join("")}
            </div>
            <div class="phoneui-composerow" style="padding: 10px 14px;">
              <button id="phoneui-groupcreatebtn">Create group</button>
            </div>`
      }`;
  }

  // Combined list: groups, then 1:1 contacts
  const names = Object.keys(s.contacts);
  const groupNames = Object.keys(s.groups);
  if (names.length === 0 && groupNames.length === 0) {
    return `<div class="phoneui-empty">No conversations yet. Add a contact or wait for someone to text you.</div>`;
  }
  return `
    <div class="phoneui-textsheader">
      <span>Texts</span>
      <i class="fa-solid fa-user-group" id="phoneui-newgroupbtn" title="New group"></i>
    </div>
    <div class="phoneui-list">
    ${groupNames
      .map((n) => {
        const thread = s.groupThreads[n] || [];
        const last = thread[thread.length - 1];
        const lastText = last ? last.text || (last.gif ? "📷 GIF" : "") : "";
        const preview = last ? (last.who === "npc" ? `${last.sender}: ${lastText}` : lastText) : "No messages yet";
        const isTyping = groupTypingNames(n).length > 0;
        return `<div class="phoneui-listitem" data-group="${escapeHtml(n)}">
          <div class="phoneui-avatar phoneui-groupavatar">${s.groups[n].avatar}</div>
          <div class="phoneui-listtext">
            <div class="phoneui-listname">${escapeHtml(n)}</div>
            <div class="phoneui-listpreview${isTyping ? " phoneui-typingpreview" : ""}">${
              isTyping ? "typing…" : escapeHtml(preview.slice(0, 40))
            }</div>
          </div>
        </div>`;
      })
      .join("")}
    ${names
      .map((n) => {
        const thread = s.threads[n] || [];
        const last = thread[thread.length - 1];
        const isTyping = typingThreads.has(n);
        const c = s.contacts[n];
        const label = c.nickname
          ? c.nickname
          : c.unknown
          ? `Unknown · ${n}`
          : n;
        return `<div class="phoneui-listitem" data-contact="${escapeHtml(n)}">
          ${avatarHtml(c.avatar, avatarPhotoFor(n))}
          <div class="phoneui-listtext">
            <div class="phoneui-listname">${escapeHtml(label)}</div>
            <div class="phoneui-listpreview${isTyping ? " phoneui-typingpreview" : ""}">${
              isTyping
                ? "typing…"
                : last
                ? escapeHtml((last.text || (last.gif ? "📷 GIF" : "")).slice(0, 40))
                : "No messages yet"
            }</div>
          </div>
        </div>`;
      })
      .join("")}
  </div>`;
}

function renderFeed() {
  const s = getSettings();
  const stories = renderStoriesStrip();
  const body =
    s.feed.length === 0
      ? `<div class="phoneui-empty">No posts yet. Be the first to post something.</div>`
      : `<div class="phoneui-feed">
    ${s.feed
      .map(
        (p) => `
      <div class="phoneui-post" data-postid="${p.id}">
        ${
          p.repostOf
            ? `<div class="phoneui-repostlabel"><i class="fa-solid fa-retweet"></i> ${escapeHtml(p.author)} reposted</div>`
            : ""
        }
        <div class="phoneui-postheader">
          ${avatarHtml(
            initials(p.repostOf ? p.repostOf.author : p.author),
            avatarPhotoFor(p.repostOf ? p.repostOf.author : p.author)
          )}
          <span class="phoneui-postauthor">${escapeHtml(p.repostOf ? p.repostOf.author : p.author)}</span>
        </div>
        ${
          p.repostOf
            ? `${
                p.repostOf.gif
                  ? `<img class="phoneui-postgif" src="${escapeHtml(p.repostOf.gif.url)}" alt="${escapeHtml(
                      p.repostOf.gif.title
                    )}" />`
                  : ""
              }${p.repostOf.caption ? `<div class="phoneui-postcaption">${renderCaption(p.repostOf.caption)}</div>` : ""}${
                p.caption ? `<div class="phoneui-repostcaption">${escapeHtml(p.author)}: ${renderCaption(p.caption)}</div>` : ""
              }`
            : `${p.gif ? `<img class="phoneui-postgif" src="${escapeHtml(p.gif.url)}" alt="${escapeHtml(p.gif.title)}" />` : ""}${
                p.caption ? `<div class="phoneui-postcaption">${renderCaption(p.caption)}</div>` : ""
              }`
        }
        <div class="phoneui-postactions">
          <i class="fa-solid fa-heart phoneui-like ${p.likedByUser ? "phoneui-liked" : ""}" data-postid="${p.id}"></i>
          <span>${p.likes}</span>
          <i class="fa-regular fa-comment"></i>
          <span>${p.comments.length}</span>
          <i class="fa-solid fa-retweet phoneui-repost" data-postid="${p.id}" title="Repost"></i>
        </div>
        ${p.comments
          .map((c) => `<div class="phoneui-comment"><b>${escapeHtml(c.author)}</b> ${escapeHtml(c.text)}</div>`)
          .join("")}
        <div class="phoneui-commentrow">
          <input type="text" class="phoneui-commentinput" data-postid="${p.id}" placeholder="Add a comment..." />
        </div>
      </div>`
      )
      .join("")}
  </div>`;
  return stories + body + renderStoryViewer();
}

function renderDiscord() {
  const s = getSettings();

  // Level 3: inside a channel
  if (activeServer && activeChannel && s.discordServers[activeServer]) {
    const server = s.discordServers[activeServer];
    const msgs = server.channels[activeChannel] || [];
    return `
      <div class="phoneui-threadheader">
        <i class="fa-solid fa-chevron-left" id="phoneui-discord-back-channel"></i>
        <span>#${escapeHtml(activeChannel)}</span>
      </div>
      <div class="phoneui-messages">
        ${msgs
          .map(
            (m) => `<div class="phoneui-dmsg ${m.isUser ? "phoneui-dmsg-user" : ""}">
              ${avatarHtml(initials(m.author), avatarPhotoFor(m.author), "phoneui-avatar-sm")}
              <div>
                <div class="phoneui-dauthor">${escapeHtml(m.author)}</div>
                ${m.gif ? `<img class="phoneui-msggif" src="${escapeHtml(m.gif.url)}" alt="${escapeHtml(m.gif.title)}" />` : ""}
                ${m.text ? `<div class="phoneui-dtext">${escapeHtml(m.text)}</div>` : ""}
              </div>
            </div>`
          )
          .join("")}
      </div>
      ${renderGifPicker()}
      <div class="phoneui-inputrow">
        <input type="text" id="phoneui-discordinput" placeholder="Message #${escapeHtml(activeChannel)}" />
        <i class="fa-solid fa-face-grin-squint" id="phoneui-discordgifbtn" title="Send a GIF"></i>
        <i class="fa-solid fa-arrow-up" id="phoneui-discordsend"></i>
      </div>`;
  }

  // Level 2: channel list inside a server
  if (activeServer && s.discordServers[activeServer]) {
    const server = s.discordServers[activeServer];
    const channelNames = Object.keys(server.channels);
    return `
      <div class="phoneui-threadheader">
        <i class="fa-solid fa-chevron-left" id="phoneui-discord-back-server"></i>
        <div class="phoneui-avatar">${server.icon}</div>
        <span>${escapeHtml(activeServer)}</span>
      </div>
      <div class="phoneui-channellist">
        ${channelNames
          .map(
            (c) => `<div class="phoneui-channelitem" data-channel="${escapeHtml(c)}">
              <i class="fa-solid fa-hashtag"></i><span>${escapeHtml(c)}</span>
            </div>`
          )
          .join("")}
      </div>
      <div class="phoneui-addcontact">
        <input type="text" id="phoneui-newchannel" placeholder="New channel name" />
        <i class="fa-solid fa-plus" id="phoneui-addchannelbtn"></i>
      </div>`;
  }

  // Level 1: server rail + pending invites
  const serverNames = Object.keys(s.discordServers);
  return `
    ${
      s.discordInvites.length > 0
        ? `<div class="phoneui-invites">
            ${s.discordInvites
              .map(
                (inv) => `<div class="phoneui-invitecard">
                  <div class="phoneui-invitetitle"><i class="fa-brands fa-discord"></i> ${escapeHtml(inv.from)} invited you to <b>${escapeHtml(inv.server)}</b></div>
                  <div class="phoneui-invitemsg">${escapeHtml(inv.message)}</div>
                  <div class="phoneui-inviteactions">
                    <button class="phoneui-inviteaccept" data-inviteid="${inv.id}">Accept</button>
                    <button class="phoneui-invitedecline" data-inviteid="${inv.id}">Decline</button>
                  </div>
                </div>`
              )
              .join("")}
          </div>`
        : ""
    }
    ${
      serverNames.length === 0
        ? `<div class="phoneui-empty">No servers yet. Wait for an invite, or add one below.</div>`
        : `<div class="phoneui-serverlist">
            ${serverNames
              .map(
                (n) => `<div class="phoneui-serveritem" data-server="${escapeHtml(n)}">
                  <div class="phoneui-avatar">${s.discordServers[n].icon}</div>
                  <span>${escapeHtml(n)}</span>
                </div>`
              )
              .join("")}
          </div>`
    }
    <div class="phoneui-addcontact">
      <input type="text" id="phoneui-newserver" placeholder="Join server by name" />
      <i class="fa-solid fa-plus" id="phoneui-addserverbtn"></i>
    </div>`;
}

function renderContacts() {
  const s = getSettings();
  const names = Object.keys(s.contacts);
  return `
    <div class="phoneui-addcontact">
      <input type="text" id="phoneui-newcontact" placeholder="Add contact by number" inputmode="tel" />
      <i class="fa-solid fa-plus" id="phoneui-addcontactbtn"></i>
    </div>
    <div class="phoneui-settings-hint phoneui-addcontacthint">
      Contacts can only be added by phone number - a name on its own
      isn't enough to text someone. Once you know who a number
      belongs to, give it a nickname below.
    </div>
    <div class="phoneui-list">
      ${names
        .map((n) => {
          const c = s.contacts[n];
          const phone = c.phone;
          const label = displayName(n, c);
          const showPhone = phone && !c.unknown; // unknown contacts already show their number as the name
          return `<div class="phoneui-listitem" data-contact="${escapeHtml(n)}">
            ${avatarHtml(c.avatar, avatarPhotoFor(n))}
            <div class="phoneui-listtext">
              <div class="phoneui-listname">${escapeHtml(label)}</div>
              ${showPhone ? `<div class="phoneui-listphone">${escapeHtml(phone)}</div>` : ""}
              ${c.unknown ? `<div class="phoneui-listphone">${escapeHtml(n)}</div>` : ""}
            </div>
            ${
              showPhone
                ? `<i class="fa-solid fa-copy phoneui-copynumber" data-number="${escapeHtml(phone)}" title="Copy number"></i>`
                : ""
            }
            <i class="fa-solid fa-camera phoneui-editnickname" data-setphoto="${escapeHtml(n)}" title="Set contact photo"></i>
            <i class="fa-solid fa-pen phoneui-editnickname" data-nickname="${escapeHtml(n)}" title="Edit nickname"></i>
            <i class="fa-solid fa-ban phoneui-blocktoggle ${c.blocked ? "phoneui-blocked" : ""}" data-blocktoggle="${escapeHtml(
            n
          )}" title="${c.blocked ? "Unblock" : "Block"}"></i>
          </div>`;
        })
        .join("")}
    </div>`;
}

let composeGif = null;

function renderCompose() {
  const s = getSettings();
  const contactNames = Object.keys(s.contacts);
  return `
    <div class="phoneui-compose">
      <textarea id="phoneui-composetext" placeholder="What's happening? Use @ to tag someone, # to add a tag"></textarea>
      <div id="phoneui-mentionlist" class="phoneui-mentionlist phoneui-hidden">
        ${contactNames.map((n) => `<div class="phoneui-mentionopt" data-name="${escapeHtml(n)}">@${escapeHtml(n)}</div>`).join("")}
      </div>
      ${
        composeGif
          ? `<div class="phoneui-composegifpreview">
               <img src="${escapeHtml(composeGif.url)}" alt="${escapeHtml(composeGif.title)}" />
               <i class="fa-solid fa-xmark" id="phoneui-composegifremove" title="Remove GIF"></i>
             </div>`
          : ""
      }
      ${renderGifPicker()}
      <div class="phoneui-composerow">
        <button id="phoneui-composegifbtn" type="button"><i class="fa-solid fa-face-grin-squint"></i> Add GIF/meme</button>
        <button id="phoneui-postbtn">Post</button>
      </div>
    </div>`;
}

function renderPanel() {
  const body = document.querySelector("#phoneui-body");
  if (!body) return;
  if (activeTab === "home") body.innerHTML = renderHome();
  else if (activeTab === "texts") body.innerHTML = renderTexts();
  else if (activeTab === "feed") body.innerHTML = renderFeed();
  else if (activeTab === "discord") body.innerHTML = renderDiscord();
  else if (activeTab === "contacts") body.innerHTML = renderContacts();
  else if (activeTab === "compose") body.innerHTML = renderCompose();
  attachBodyListeners();
}

function attachBodyListeners() {
  document.querySelectorAll(".phoneui-appicon[data-tab]").forEach((el) => {
    el.addEventListener("click", () => {
      activeTab = el.dataset.tab;
      activeThread = null;
      activeGroup = null;
      activeServer = null;
      activeChannel = null;
      groupCreate = { open: false, name: "", selected: new Set() };
      gifPicker.open = false;
      stopStoryTimer();
      storyViewer = { open: false, author: null, index: 0, timerId: null };
      renderPanel();
    });
  });

  document.querySelectorAll(".phoneui-listitem[data-contact]").forEach((el) => {
    el.addEventListener("click", () => {
      activeThread = el.dataset.contact;
      activeGroup = null;
      activeTab = "texts";
      renderPanel();
    });
  });

  document.querySelectorAll(".phoneui-listitem[data-group]").forEach((el) => {
    el.addEventListener("click", () => {
      activeGroup = el.dataset.group;
      activeThread = null;
      renderPanel();
    });
  });

  document.querySelector("#phoneui-newgroupbtn")?.addEventListener("click", () => {
    groupCreate = { open: true, name: "", selected: new Set() };
    renderPanel();
  });

  document.querySelector("#phoneui-groupcreate-back")?.addEventListener("click", () => {
    groupCreate = { open: false, name: "", selected: new Set() };
    renderPanel();
  });

  document.querySelector("#phoneui-groupname")?.addEventListener("input", (e) => {
    groupCreate.name = e.target.value; // stored, not re-rendered, so typing keeps focus
  });

  document.querySelectorAll(".phoneui-groupmemberitem").forEach((el) => {
    el.addEventListener("click", () => {
      const name = el.dataset.member;
      if (groupCreate.selected.has(name)) groupCreate.selected.delete(name);
      else groupCreate.selected.add(name);
      renderPanel();
    });
  });

  document.querySelector("#phoneui-groupcreatebtn")?.addEventListener("click", () => {
    const nameInput = document.querySelector("#phoneui-groupname");
    const name = (nameInput ? nameInput.value : groupCreate.name).trim();
    if (!name || groupCreate.selected.size < 2) {
      alert("Give the group a name and pick at least 2 people.");
      return;
    }
    ensureGroup(name, [...groupCreate.selected]);
    saveSettings();
    groupCreate = { open: false, name: "", selected: new Set() };
    activeGroup = name;
    renderPanel();
  });

  document.querySelector("#phoneui-back")?.addEventListener("click", () => {
    activeThread = null;
    activeGroup = null;
    gifPicker.open = false;
    renderPanel();
  });

  document.querySelector("#phoneui-grouptextsend")?.addEventListener("click", () => {
    const input = document.querySelector("#phoneui-grouptextinput");
    if (input && input.value.trim() && activeGroup) {
      userSendGroupText(activeGroup, input.value.trim());
      input.value = "";
      delete messageDrafts.groups[activeGroup];
    }
  });
  document.querySelector("#phoneui-grouptextinput")?.addEventListener("input", (e) => {
    if (activeGroup) messageDrafts.groups[activeGroup] = e.target.value; // stored, not re-rendered, so typing keeps focus
  });
  document.querySelector("#phoneui-grouptextinput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.querySelector("#phoneui-grouptextsend")?.click();
  });
  document.querySelector("#phoneui-grouptextgifbtn")?.addEventListener("click", () => {
    const group = activeGroup;
    if (!group) return;
    openGifPicker((gif) => userSendGroupText(group, "", gif));
  });

  // --- Stories ---
  document.querySelectorAll(".phoneui-story").forEach((el) => {
    el.addEventListener("click", () => openStoryViewer(el.dataset.storyauthor));
  });
  document.querySelector("#phoneui-storyclose")?.addEventListener("click", closeStoryViewer);
  document.querySelector("#phoneui-storyprev")?.addEventListener("click", () => advanceStory(-1));
  document.querySelector("#phoneui-storynext")?.addEventListener("click", () => advanceStory(1));
  document.querySelector("#phoneui-storyreplyinput")?.addEventListener("input", (e) => {
    storyReplyDraft = e.target.value; // stored, not re-rendered, so typing keeps focus
    stopStoryTimer(); // pause auto-advance while composing a reply
  });
  document.querySelector("#phoneui-storyreplyinput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.querySelector("#phoneui-storyreplysend")?.click();
  });
  document.querySelector("#phoneui-storyreplysend")?.addEventListener("click", () => {
    const input = document.querySelector("#phoneui-storyreplyinput");
    if (input) replyToStory(input.value);
  });
  scheduleStoryAdvance();

  document.querySelector("#phoneui-textsend")?.addEventListener("click", () => {
    const input = document.querySelector("#phoneui-textinput");
    if (input && input.value.trim() && activeThread) {
      userSendText(activeThread, input.value.trim());
      input.value = "";
      delete messageDrafts.threads[activeThread];
    }
  });
  document.querySelector("#phoneui-textinput")?.addEventListener("input", (e) => {
    if (activeThread) messageDrafts.threads[activeThread] = e.target.value; // stored, not re-rendered, so typing keeps focus
  });
  document.querySelector("#phoneui-textinput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.querySelector("#phoneui-textsend")?.click();
  });
  document.querySelector("#phoneui-textgifbtn")?.addEventListener("click", () => {
    const thread = activeThread;
    if (!thread) return;
    openGifPicker((gif) => userSendText(thread, "", gif));
  });

  document.querySelectorAll(".phoneui-like").forEach((el) => {
    el.addEventListener("click", () => toggleLike(el.dataset.postid));
  });

  document.querySelectorAll(".phoneui-repost").forEach((el) => {
    el.addEventListener("click", () => userRepost(el.dataset.postid));
  });

  // Any block/unblock control anywhere in the panel (thread header,
  // blocked-notice banner, contacts list) shares this one handler.
  document.querySelectorAll("[data-blocktoggle]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation(); // don't also trigger a listitem's "open thread" click
      toggleBlock(el.dataset.blocktoggle);
    });
  });

  // Same idea for the nickname-edit pencil, wherever it shows up
  // (contacts list, thread header).
  document.querySelectorAll("[data-nickname]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      setNickname(el.dataset.nickname);
    });
  });

  // Contact photo controls - same "shows up in multiple places"
  // pattern as block/nickname above.
  document.querySelectorAll("[data-setphoto]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      setContactPhoto(el.dataset.setphoto);
    });
  });
  document.querySelectorAll("[data-removephoto]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      removeContactPhoto(el.dataset.removephoto);
    });
  });

  document.querySelector("#phoneui-saveunknownbtn")?.addEventListener("click", () => {
    const input = document.querySelector("#phoneui-saveunknown");
    const name = input ? input.value.trim() : "";
    if (name && activeThread) resolveUnknownNumber(activeThread, name);
  });
  document.querySelector("#phoneui-saveunknown")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.querySelector("#phoneui-saveunknownbtn")?.click();
  });

  document.querySelectorAll(".phoneui-commentinput").forEach((el) => {
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && el.value.trim()) {
        userComment(el.dataset.postid, el.value.trim());
      }
    });
  });

  // --- Discord: level 1 (server rail / invites) ---
  document.querySelectorAll(".phoneui-inviteaccept").forEach((el) => {
    el.addEventListener("click", () => acceptInvite(el.dataset.inviteid));
  });
  document.querySelectorAll(".phoneui-invitedecline").forEach((el) => {
    el.addEventListener("click", () => declineInvite(el.dataset.inviteid));
  });
  document.querySelectorAll(".phoneui-serveritem").forEach((el) => {
    el.addEventListener("click", () => {
      activeServer = el.dataset.server;
      renderPanel();
    });
  });
  document.querySelector("#phoneui-addserverbtn")?.addEventListener("click", () => {
    const input = document.querySelector("#phoneui-newserver");
    if (input && input.value.trim()) {
      ensureServer(input.value.trim());
      saveSettings();
      renderPanel();
    }
  });

  // --- Discord: level 2 (channel list) ---
  document.querySelector("#phoneui-discord-back-server")?.addEventListener("click", () => {
    activeServer = null;
    gifPicker.open = false;
    renderPanel();
  });
  document.querySelectorAll(".phoneui-channelitem").forEach((el) => {
    el.addEventListener("click", () => {
      activeChannel = el.dataset.channel;
      renderPanel();
    });
  });
  document.querySelector("#phoneui-addchannelbtn")?.addEventListener("click", () => {
    const input = document.querySelector("#phoneui-newchannel");
    const s = getSettings();
    if (input && input.value.trim() && activeServer) {
      const chan = input.value.trim().toLowerCase().replace(/\s+/g, "-");
      if (!s.discordServers[activeServer].channels[chan]) {
        s.discordServers[activeServer].channels[chan] = [];
      }
      saveSettings();
      renderPanel();
    }
  });

  // --- Discord: level 3 (channel chat) ---
  document.querySelector("#phoneui-discord-back-channel")?.addEventListener("click", () => {
    activeChannel = null;
    gifPicker.open = false;
    renderPanel();
  });
  document.querySelector("#phoneui-discordsend")?.addEventListener("click", () => {
    const input = document.querySelector("#phoneui-discordinput");
    if (input && input.value.trim() && activeServer && activeChannel) {
      userSendDiscordMessage(activeServer, activeChannel, input.value.trim());
      input.value = "";
    }
  });
  document.querySelector("#phoneui-discordinput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.querySelector("#phoneui-discordsend")?.click();
  });
  document.querySelector("#phoneui-discordgifbtn")?.addEventListener("click", () => {
    const server = activeServer;
    const channel = activeChannel;
    if (!server || !channel) return;
    openGifPicker((gif) => userSendDiscordMessage(server, channel, "", gif));
  });

  document.querySelector("#phoneui-addcontactbtn")?.addEventListener("click", () => {
    const input = document.querySelector("#phoneui-newcontact");
    const raw = input ? input.value.trim() : "";
    if (!raw) return;
    // Bug fix / feature: this used to let the user type any name and
    // instantly create a fully-named contact with no number at all -
    // there was nothing to actually text. A real phone only lets you
    // add someone by number, then optionally attach a name/nickname
    // once you know who it is - so require that here too. If the
    // model later reveals whose number this is via [NUMBER:Name], the
    // unknown thread automatically folds into that named contact.
    if (!isValidPhoneNumber(raw)) {
      alert("Enter a valid phone number, e.g. (555) 019-2847.");
      return;
    }
    const number = formatPhoneNumber(raw);
    const existing = findContactNameByPhone(number, null);
    if (existing) {
      // Already a contact (named or unknown) - just jump to them
      // instead of creating a duplicate entry for the same number.
      activeTab = "texts";
      activeThread = existing;
    } else {
      ensureUnknownContact(number);
    }
    if (input) input.value = "";
    saveSettings();
    renderPanel();
  });

  document.querySelectorAll(".phoneui-copynumber").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation(); // don't also trigger the listitem's "open thread" click
      const num = el.dataset.number;
      if (!num || !navigator.clipboard?.writeText) return;
      navigator.clipboard
        .writeText(num)
        .then(() => {
          el.classList.remove("fa-copy");
          el.classList.add("fa-check", "phoneui-copied");
          setTimeout(() => {
            el.classList.remove("fa-check", "phoneui-copied");
            el.classList.add("fa-copy");
          }, 1200);
        })
        .catch(() => {});
    });
  });

  const composeText = document.querySelector("#phoneui-composetext");
  const mentionList = document.querySelector("#phoneui-mentionlist");
  composeText?.addEventListener("input", () => {
    const val = composeText.value;
    const atIndex = val.lastIndexOf("@");
    if (atIndex !== -1 && atIndex === val.length - 1) {
      mentionList?.classList.remove("phoneui-hidden");
    } else {
      mentionList?.classList.add("phoneui-hidden");
    }
  });
  document.querySelectorAll(".phoneui-mentionopt").forEach((el) => {
    el.addEventListener("click", () => {
      composeText.value += `${el.dataset.name} `;
      mentionList?.classList.add("phoneui-hidden");
      composeText.focus();
    });
  });
  document.querySelector("#phoneui-postbtn")?.addEventListener("click", () => {
    const caption = composeText.value.trim();
    if (caption || composeGif) {
      userSendPost(caption, composeGif);
      composeText.value = "";
      composeGif = null;
      activeTab = "feed";
      renderPanel();
    }
  });
  document.querySelector("#phoneui-composegifbtn")?.addEventListener("click", () => {
    openGifPicker((gif) => {
      composeGif = gif;
      renderPanel();
    });
  });
  document.querySelector("#phoneui-composegifremove")?.addEventListener("click", () => {
    composeGif = null;
    renderPanel();
  });

  attachGifPickerListeners();
}

function updateToggleBadge() {
  const s = getSettings();
  const badge = document.querySelector("#phoneui-badge");
  if (!badge) return;
  // Set display inline directly rather than toggling a class: the
  // badge's base styles (see ensureToggleStylesInjected) are marked
  // !important on purpose, so a stylesheet class couldn't override
  // them anyway - inline is the only thing that reliably can.
  if (s.unread > 0) {
    badge.textContent = s.unread;
    badge.style.setProperty("display", "flex", "important");
    badge.style.setProperty("align-items", "center", "important");
    badge.style.setProperty("justify-content", "center", "important");
  } else {
    badge.style.setProperty("display", "none", "important");
  }
}

// Applies a saved manual panel drag position (if any), the same way
// applyTogglePosition does for the button. Measures the panel the
// same "briefly unhide while invisible" way positionPanelNearButton
// does, since it too may currently be display:none.
function applyPanelPosition(pos) {
  const panel = document.querySelector("#phoneui-panel");
  if (!panel) return;
  const wasHidden = panel.classList.contains("phoneui-hidden");
  if (wasHidden) {
    panel.style.setProperty("visibility", "hidden", "important");
    panel.classList.remove("phoneui-hidden");
  }
  const w = panel.offsetWidth || 320;
  const h = panel.offsetHeight || 560;
  if (wasHidden) {
    panel.classList.add("phoneui-hidden");
    panel.style.removeProperty("visibility");
  }
  const { left, top } = clampTogglePosition(pos.left, pos.top, w, h);
  panel.style.setProperty("left", `${left}px`, "important");
  panel.style.setProperty("top", `${top}px`, "important");
  panel.style.setProperty("right", "auto", "important");
  panel.style.setProperty("bottom", "auto", "important");
  panel.style.setProperty("transform", "none", "important");
}

// Decides how to place the panel right before it opens: a manually
// dragged spot (sticky, set by dragging the panel itself) wins if one
// exists; otherwise it auto-follows the toggle button.
function positionPanelForOpen() {
  const s = getSettings();
  if (s.panelPos) applyPanelPosition(s.panelPos);
  else positionPanelNearButton();
}

// Pointer-based dragging for the panel itself, grabbed by its status
// bar (mirrors attachToggleDragHandlers above). Once dragged, the panel's
// position becomes a sticky preference (saved as panelPos) that no
// longer auto-follows the button - drag the button and the panel
// stays put; drag the panel again to move it, or use "Reset
// button/panel position" in settings to go back to auto-follow.
function makePanelDraggable(panel, handle) {
  const DRAG_THRESHOLD = 6;
  let pointerId = null;
  let startX = 0;
  let startY = 0;
  let originLeft = 0;
  let originTop = 0;
  let dragging = false;

  handle.style.cursor = "grab";
  handle.style.touchAction = "none";
  handle.title = "Drag to move the phone";

  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    pointerId = e.pointerId;
    const rect = panel.getBoundingClientRect();
    startX = e.clientX;
    startY = e.clientY;
    originLeft = rect.left;
    originTop = rect.top;
    dragging = false;
    handle.setPointerCapture(pointerId);
  });

  handle.addEventListener("pointermove", (e) => {
    if (e.pointerId !== pointerId || pointerId === null) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    dragging = true;
    handle.style.cursor = "grabbing";
    const w = panel.offsetWidth;
    const h = panel.offsetHeight;
    const { left, top } = clampTogglePosition(originLeft + dx, originTop + dy, w, h);
    panel.style.setProperty("left", `${left}px`, "important");
    panel.style.setProperty("top", `${top}px`, "important");
    panel.style.setProperty("right", "auto", "important");
    panel.style.setProperty("bottom", "auto", "important");
    panel.style.setProperty("transform", "none", "important");
  });

  const endDrag = (e) => {
    if (e.pointerId !== pointerId || pointerId === null) return;
    handle.style.cursor = "grab";
    if (dragging) {
      const rect = panel.getBoundingClientRect();
      const s = getSettings();
      s.panelPos = { left: rect.left, top: rect.top };
      saveSettings();
    }
    pointerId = null;
    dragging = false;
  };
  handle.addEventListener("pointerup", endDrag);
  handle.addEventListener("pointercancel", endDrag);
}

function togglePanel() {
  const panel = document.querySelector("#phoneui-panel");
  const isHidden = panel.classList.contains("phoneui-hidden");
  if (isHidden) {
    // Compute position before revealing, so it appears already in the
    // right spot instead of flashing at an old location first.
    positionPanelForOpen();
    panel.classList.remove("phoneui-hidden");
    const s = getSettings();
    s.unread = 0;
    saveSettings();
    updateToggleBadge();
    renderPanel();
  } else {
    panel.classList.add("phoneui-hidden");
    stopStoryTimer();
  }
}

// ---------------------------------------------------------------
// Init
// ---------------------------------------------------------------

function injectNotificationContainer() {
  const container = document.createElement("div");
  container.id = "phoneui-notifications";
  document.body.appendChild(container);
}

// Belt-and-suspenders: some SillyTavern layouts (especially mobile)
// apply CSS to <body> or intermediate wrappers - e.g. transforms used
// by swipe/drawer libraries - that can silently break `position:
// fixed` positioning for anything nested inside them, or can cause a
// stylesheet rule to unexpectedly win the cascade. Setting the
// critical positioning properties inline (with !important) sidesteps
// both problems: inline styles beat any external stylesheet, and
// appending straight to <html> instead of <body> keeps this element
// outside whatever wrapper ST is transforming.
// Beyond position/z-index, force every CSS property that a host page
// (or a future ST theme) could plausibly use to hide an unrelated
// element by ID/selector collision or a blanket rule: display,
// visibility, opacity, and pointer-events. Inline !important beats
// any external stylesheet rule (even one that's also !important), so
// this is a hard guarantee the button can't be silently switched off
// by CSS elsewhere on the page.
// Forces position/stacking/interactivity so host-page CSS can't bury
// or block the button/panel. Deliberately does NOT force `display` -
// that's what .phoneui-hidden (display:none !important) controls for
// showing/hiding the panel, and an inline !important display here
// would always outrank that class rule, permanently pinning the
// panel visible and breaking the open/close toggle entirely.
function forceFixedStyle(el) {
  el.style.setProperty("position", "fixed", "important");
  el.style.setProperty("z-index", "2147483000", "important");
  el.style.setProperty("visibility", "visible", "important");
  el.style.setProperty("opacity", "1", "important");
  el.style.setProperty("pointer-events", "auto", "important");
}

// A simple line-art phone glyph, drawn as inline SVG instead of an
// icon-font glyph. Icon fonts (Font Awesome here) can render as an
// empty box if the host page ships a different FA version that's
// missing the specific icon name, hasn't finished loading its
// stylesheet yet, or blocks the @font-face request entirely - in any
// of those cases the button's dark circle still shows, but with
// nothing on it, which reads as "invisible". Inline SVG has no
// external dependency: it's either in the DOM and painted, or it
// isn't there at all, which is much easier to debug if something
// still goes wrong.
const PHONE_SVG = `
  <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">
    <rect x="6.5" y="2" width="11" height="20" rx="2.6" fill="none" stroke="currentColor" stroke-width="1.6"/>
    <line x1="9" y1="4.6" x2="15" y2="4.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
    <circle cx="12" cy="18.6" r="1.1" fill="currentColor"/>
  </svg>`;

let toggleResizeListenerStarted = false;

// Keeps a dragged position on-screen after a window/viewport resize
// (e.g. rotating a phone, or resizing a desktop browser) instead of
// letting it drift off the visible area, which would be another way
// for the button to effectively "disappear".
function clampTogglePosition(left, top, w, h) {
  const maxLeft = Math.max(0, window.innerWidth - w);
  const maxTop = Math.max(0, window.innerHeight - h);
  return {
    left: Math.min(Math.max(0, left), maxLeft),
    top: Math.min(Math.max(0, top), maxTop),
  };
}

// Applies a saved drag position (if any) as inline left/top and
// clears the default right/bottom/transform positioning so they
// can't fight with it - including the mobile media-query rule, which
// inline !important always wins over.
function applyTogglePosition(wrapper) {
  const s = getSettings();
  if (!s.togglePos) return;
  const w = wrapper.offsetWidth || 52;
  const h = wrapper.offsetHeight || 52;
  const { left, top } = clampTogglePosition(s.togglePos.left, s.togglePos.top, w, h);
  wrapper.style.setProperty("left", left + "px", "important");
  wrapper.style.setProperty("top", top + "px", "important");
  wrapper.style.setProperty("right", "auto", "important");
  wrapper.style.setProperty("bottom", "auto", "important");
  wrapper.style.setProperty("transform", "none", "important");
}

// The panel used to sit at its own fixed bottom-right CSS position,
// completely independent of wherever the toggle button actually was
// (default spot, or dragged elsewhere). That's why dragging the
// button left it "behind the phone" - the panel would open in its
// old spot regardless, and could easily land right on top of the
// button instead of next to it. This anchors the panel to the
// button's *current* on-screen position instead, like a popover:
// opens above it if there's room, below it otherwise, and is clamped
// so it can never run off-screen.
function positionPanelNearButton() {
  const wrapper = document.querySelector("#phoneui-togglewrap");
  const panel = document.querySelector("#phoneui-panel");
  if (!wrapper || !panel) return;

  const btnRect = wrapper.getBoundingClientRect();

  // The panel needs real dimensions to measure, but it's normally
  // display:none while closed. Make it measurable without letting it
  // actually flash on screen mid-measurement.
  const wasHidden = panel.classList.contains("phoneui-hidden");
  if (wasHidden) {
    panel.style.setProperty("visibility", "hidden", "important");
    panel.classList.remove("phoneui-hidden");
  }
  const panelW = panel.offsetWidth;
  const panelH = panel.offsetHeight;
  if (wasHidden) {
    panel.classList.add("phoneui-hidden");
    panel.style.removeProperty("visibility");
  }
  if (!panelW || !panelH) return; // couldn't measure - leave existing position alone

  const margin = 12;
  const spaceAbove = btnRect.top;
  const spaceBelow = window.innerHeight - btnRect.bottom;

  const top =
    spaceAbove >= panelH + margin || spaceAbove > spaceBelow
      ? btnRect.top - panelH - margin
      : btnRect.bottom + margin;

  // Horizontally, hug the button's right edge like a popover, then
  // clamp fully on-screen so it can't hang off either edge.
  const left = btnRect.right - panelW;

  const clampedLeft = Math.min(Math.max(margin, left), window.innerWidth - panelW - margin);
  const clampedTop = Math.min(Math.max(margin, top), window.innerHeight - panelH - margin);

  panel.style.setProperty("left", `${clampedLeft}px`, "important");
  panel.style.setProperty("top", `${clampedTop}px`, "important");
  panel.style.setProperty("right", "auto", "important");
  panel.style.setProperty("bottom", "auto", "important");
  panel.style.setProperty("transform", "none", "important");
}

// Pointer-based dragging for the toggle button (mouse, touch, pen -
// one event set covers all three). A few pixels of movement have to
// happen before this counts as a drag rather than a tap, so the plain
// click handler that opens the panel still fires normally.
function attachToggleDragHandlers(wrapper, btn) {
  const DRAG_THRESHOLD = 6;
  let pointerId = null;
  let start = null;
  let origin = null;
  let dragging = false;

  btn.style.cursor = "grab";
  btn.style.touchAction = "none";

  btn.addEventListener("pointerdown", (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    pointerId = e.pointerId;
    const rect = wrapper.getBoundingClientRect();
    start = { x: e.clientX, y: e.clientY };
    origin = { left: rect.left, top: rect.top };
    dragging = false;
    btn.setPointerCapture(pointerId);
  });

  btn.addEventListener("pointermove", (e) => {
    if (e.pointerId !== pointerId || pointerId === null) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (!dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    dragging = true;
    btn.style.cursor = "grabbing";
    const { left, top } = clampTogglePosition(origin.left + dx, origin.top + dy, wrapper.offsetWidth, wrapper.offsetHeight);
    wrapper.style.setProperty("left", left + "px", "important");
    wrapper.style.setProperty("top", top + "px", "important");
    wrapper.style.setProperty("right", "auto", "important");
    wrapper.style.setProperty("bottom", "auto", "important");
    wrapper.style.setProperty("transform", "none", "important");
  });

  const endDrag = (e) => {
    if (e.pointerId !== pointerId || pointerId === null) return;
    btn.style.cursor = "grab";
    if (dragging) {
      // A drag shouldn't also fire the click that opens the panel.
      const swallowClick = (ce) => {
        ce.stopPropagation();
        ce.preventDefault();
        btn.removeEventListener("click", swallowClick, true);
      };
      btn.addEventListener("click", swallowClick, true);

      const rect = wrapper.getBoundingClientRect();
      const s = getSettings();
      s.togglePos = { left: rect.left, top: rect.top };
      saveSettings();
      const panel = document.querySelector("#phoneui-panel");
      if (panel && !panel.classList.contains("phoneui-hidden") && !s.panelPos) positionPanelNearButton();
    }
    pointerId = null;
    dragging = false;
  };
  btn.addEventListener("pointerup", endDrag);
  btn.addEventListener("pointercancel", endDrag);

  if (!toggleResizeListenerStarted) {
    toggleResizeListenerStarted = true;
    window.addEventListener("resize", () => {
      const w = document.querySelector("#phoneui-togglewrap");
      if (w && w.style.left) {
        applyTogglePosition(w);
      } else if (w) {
        const pos = computeDefaultTogglePosition();
        w.style.setProperty("bottom", pos.bottom, "important");
        w.style.setProperty("right", pos.right, "important");
      }
      const panel = document.querySelector("#phoneui-panel");
      if (panel && !panel.classList.contains("phoneui-hidden")) {
        const gs = getSettings();
        if (gs.panelPos) applyPanelPosition(gs.panelPos);
        else positionPanelNearButton();
      }
    });
  }
}

// Runs after mount, and again every guardian tick, to actually check
// the button ended up visible and clickable - not just assume the
// styles took. Unlike a check that only logs a console warning (which
// is invisible to anyone who never opens devtools - effectively a
// silent failure from the user's point of view), this one actively
// fixes what it finds: re-asserts the forced style properties, snaps
// back to the default corner if the button drifted off-screen, and
// only as a last resort - if the button is still missing from the DOM
// entirely after a fix attempt - surfaces an on-screen banner so the
// failure is visible without needing the console. Returns true if the
// button is confirmed healthy.
let toggleHealthBannerShown = false;
function checkAndRepairToggleHealth() {
  const wrapper = document.querySelector("#phoneui-togglewrap");
  if (!wrapper) {
    mountPhoneToggleButton();
    return false;
  }

  forceFixedStyle(wrapper);
  const btn = wrapper.querySelector(".phoneui-togglebtn");
  if (btn) forceFixedStyle(btn);

  const rect = wrapper.getBoundingClientRect();
  const offscreen =
    rect.width === 0 ||
    rect.height === 0 ||
    rect.right < 0 ||
    rect.left > window.innerWidth ||
    rect.bottom < 0 ||
    rect.top > window.innerHeight;

  if (offscreen) {
    // Drifted somewhere unreachable (e.g. a saved drag position from
    // a much larger screen) - reset to the default corner rather than
    // leaving it stuck out of view.
    const s = getSettings();
    s.togglePos = null;
    saveSettings();
    wrapper.style.removeProperty("left");
    wrapper.style.removeProperty("top");
    const pos = computeDefaultTogglePosition();
    wrapper.style.setProperty("bottom", pos.bottom, "important");
    wrapper.style.setProperty("right", pos.right, "important");
    wrapper.style.setProperty("transform", "none", "important");
  }

  // Confirm the button is actually the thing painted at its own
  // center point - if some other element sits on top of it despite
  // the z-index (a new stacking context from a host-page `filter` or
  // `transform` ancestor, most likely), bump it as high as the
  // platform allows one more time.
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const topEl = rect.width > 0 && rect.height > 0 ? document.elementFromPoint(cx, cy) : null;
  if (topEl && !wrapper.contains(topEl)) {
    wrapper.style.setProperty("z-index", "2147483647", "important");
  }

  return true;
}

// The button/panel deliberately float at a very high z-index so
// nothing in the chat UI can bury them (see forceFixedStyle above).
// That's correct for normal chat content, but it also means they'd
// sit on top of SillyTavern's *own* UI - the extensions/settings
// drawer, character panel, world info editor, confirmation popups,
// etc. - blocking clicks on it. That's specifically what was
// happening: opening ST's settings put the phone button/panel right
// over the top of it.
//
// Fix: detect when one of ST's own drawers or popups is open and
// drop the phone's stacking down near the bottom (and make it
// click-through) for as long as that's the case, restoring it the
// moment ST's UI closes again. This doesn't depend on knowing ST's
// exact z-index scheme - it works regardless of what that is.
// An element's own width/height (used below) reflect its layout box
// only - a `transform` (e.g. translateX(-100%) to slide a closed
// drawer off-screen) doesn't change that box at all, it just moves
// where it's painted. So a drawer "closed" that way still reports a
// non-zero width/height and passes a display/visibility/opacity/size
// check, while being entirely outside the viewport. Requiring actual
// viewport intersection closes that gap.
function isOnScreen(rect) {
  return rect.width > 0 && rect.height > 0 &&
    rect.right > 0 && rect.left < window.innerWidth &&
    rect.bottom > 0 && rect.top < window.innerHeight;
}

function isSillyTavernOverlayOpen() {
  // Right-nav / left-nav drawers (Extensions, User Settings, Character
  // Management, World Info, Persona, API Connections, ...) all share
  // this same "drawer-content" + "openDrawer" convention when open.
  // Some ST builds don't remove the "openDrawer" class when the
  // drawer closes - they just animate/hide it instead - so a class
  // check alone can get permanently stuck "open" the first time the
  // user ever opens one, silently burying the phone button behind
  // the page for the rest of the session. Require the matched element
  // to actually be visible, not just still carrying the class.
  //
  // Bug fix #1: "visible" used to mean display/visibility/opacity only.
  // Several ST themes collapse a closed drawer via height/max-height
  // instead of display:none, so a closed drawer still had
  // display:block, visibility:visible and opacity:1 - just zero
  // height. That made this permanently (mis)report "open" the moment
  // the user so much as glanced at a drawer once, which yields the
  // toggle button's z-index down to 1 for the rest of the session -
  // it's still in the DOM and positioned correctly, it just silently
  // renders underneath the rest of the page from then on.
  //
  // Bug fix #2: some other themes instead close a drawer by sliding it
  // off-screen with a CSS transform (e.g. translateX(-100%)), which
  // doesn't touch its width/height at all - only where it's painted.
  // That slipped past the fix above the same way: non-zero size, so
  // it still read as "open" forever after the first open/close. Now
  // checked via isOnScreen(), which additionally requires the drawer's
  // painted position to actually intersect the viewport.
  const drawer = document.querySelector(".drawer-content.openDrawer");
  if (drawer) {
    const cs = getComputedStyle(drawer);
    const rect = drawer.getBoundingClientRect();
    if (cs.display !== "none" && cs.visibility !== "hidden" && parseFloat(cs.opacity) > 0 && isOnScreen(rect)) {
      return true;
    }
  }
  // ST's popup()/confirmation-dialog system renders inside this
  // backdrop, hidden via display:none when nothing is showing.
  const shadow = document.querySelector("#shadow_popup");
  if (shadow) {
    const cs = getComputedStyle(shadow);
    const rect = shadow.getBoundingClientRect();
    if (cs.display !== "none" && cs.visibility !== "hidden" && parseFloat(cs.opacity) > 0 && isOnScreen(rect)) {
      return true;
    }
  }
  return false;
}

let stOverlayYielding = false;
function updateSTOverlayYield() {
  const shouldYield = isSillyTavernOverlayOpen();
  stOverlayYielding = shouldYield;
  const wrapper = document.querySelector("#phoneui-togglewrap");
  const panel = document.querySelector("#phoneui-panel");
  // Always (re-)apply rather than short-circuiting on "no change":
  // the toggle-button watchdog can recreate the wrapper element at
  // any time (e.g. after ST wipes and re-renders part of the DOM),
  // and a fresh element wouldn't have last tick's inline styles even
  // though our yielding/not-yielding *state* hasn't changed.
  [wrapper, panel].forEach((el) => {
    if (!el) return;
    if (shouldYield) {
      el.style.setProperty("z-index", "1", "important");
      el.style.setProperty("pointer-events", "none", "important");
    } else {
      el.style.setProperty("z-index", "2147483000", "important");
      el.style.setProperty("pointer-events", "auto", "important");
    }
  });
}

let stOverlayWatcherStarted = false;
function startSTOverlayWatcher() {
  if (stOverlayWatcherStarted) return;
  stOverlayWatcherStarted = true;
  // Polling instead of a MutationObserver here on purpose: ST's
  // drawers/popups open via a class toggle or a display-style change
  // on an element that may already exist in the DOM, which a
  // childList-based observer (like watchToggleButton's) won't catch.
  // A cheap interval sidesteps having to guess the exact attribute/
  // subtree config that would reliably catch every case.
  setInterval(updateSTOverlayYield, 250);
  updateSTOverlayYield();
}

// ---------------------------------------------------------------
// Toggle button - ground-up rewrite. The previous version built the
// button by hand out of huge inline cssText strings and only ever
// *logged* whether it ended up visible, which meant a real conflict
// left the user with no button and no on-screen sign anything was
// wrong. This version:
//   - defines its look in one real stylesheet (injected once, high-
//     specificity selectors) instead of a giant inline cssText blob
//   - uses a native <button> (proper focus/keyboard/AT support - a
//     styled <div> gets none of that for free)
//   - mounts on <html> rather than <body>, matching how the panel
//     itself is mounted (see forceFixedStyle/injectPanel), so both
//     float outside whatever container a theme might transform
//   - is watched by a MutationObserver instead of blind polling, so
//     it's put back within a frame if it's ever removed, with a
//     slower interval only as a backstop
//   - actively repairs what it finds wrong (see
//     checkAndRepairToggleHealth above) instead of only reporting it,
//     and puts up a visible banner if repair can't fix things
// ---------------------------------------------------------------

// On narrow screens ST's own compose bar and the virtual keyboard sit
// at the bottom of the screen, so the resting spot needs to be higher
// up there than on desktop.
function computeDefaultTogglePosition() {
  const isMobile = window.matchMedia && window.matchMedia("(max-width: 768px)").matches;
  return isMobile
    ? { bottom: "calc(100px + env(safe-area-inset-bottom, 0px))", right: "calc(10px + env(safe-area-inset-right, 0px))" }
    : { bottom: "calc(24px + env(safe-area-inset-bottom, 0px))", right: "calc(16px + env(safe-area-inset-right, 0px))" };
}

const TOGGLE_STYLE_ID = "phoneui-toggle-style";

// One real stylesheet, injected once, instead of repeating a giant
// inline cssText string every time the button gets (re)built. Every
// rule still carries !important + a specific selector so a host-page
// rule targeting the same class name can't quietly win.
function ensureToggleStylesInjected() {
  if (document.getElementById(TOGGLE_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = TOGGLE_STYLE_ID;
  style.textContent = `
    #phoneui-togglewrap {
      all: initial !important;
      position: fixed !important;
      z-index: 2147483000 !important;
      visibility: visible !important;
      opacity: 1 !important;
      pointer-events: auto !important;
      display: block !important;
    }
    /* Bug fix: the ID selector above always beat the plain-class
       ".phoneui-hidden" rule in style.css (display:none !important) on
       specificity, even though both used !important - an ID always
       outranks a class regardless of !important or source order. That
       meant unchecking "Enable phone panel" in the settings drawer
       could never actually hide the floating button; it just silently
       stayed on screen. Pairing the ID with the class here matches
       (and beats) that specificity so the hidden state actually wins
       when it's supposed to. */
    #phoneui-togglewrap.phoneui-hidden {
      display: none !important;
    }
    #phoneui-togglewrap .phoneui-togglebtn {
      all: initial !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      width: 52px !important;
      height: 52px !important;
      border-radius: 50% !important;
      border: none !important;
      background: #222 !important;
      color: #fff !important;
      cursor: grab !important;
      box-shadow: 0 2px 10px rgba(0,0,0,0.35) !important;
      position: relative !important;
      user-select: none !important;
      touch-action: none !important;
      box-sizing: border-box !important;
      font: inherit !important;
      padding: 0 !important;
    }
    #phoneui-togglewrap .phoneui-togglebtn:focus-visible {
      outline: 2px solid #7ab8ff !important;
      outline-offset: 2px !important;
    }
    #phoneui-togglewrap .phoneui-toggle-badge {
      all: initial !important;
      position: absolute !important;
      top: -4px !important;
      right: -4px !important;
      background: #e0393e !important;
      color: #fff !important;
      font-size: 11px !important;
      font-family: sans-serif !important;
      min-width: 18px !important;
      height: 18px !important;
      line-height: 18px !important;
      text-align: center !important;
      border-radius: 9px !important;
      padding: 0 4px !important;
      box-sizing: border-box !important;
      display: none !important;
    }
  `;
  document.head.appendChild(style);
}

function buildPhoneToggleElement() {
  const wrapper = document.createElement("div");
  wrapper.id = "phoneui-togglewrap";
  const pos = computeDefaultTogglePosition();
  wrapper.style.setProperty("bottom", pos.bottom, "important");
  wrapper.style.setProperty("right", pos.right, "important");

  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = "phoneui-togglebtn";
  btn.className = "phoneui-togglebtn";
  btn.title = "Open phone (drag to move)";
  btn.setAttribute("aria-label", "Open phone");
  btn.innerHTML = PHONE_SVG;

  const badge = document.createElement("span");
  badge.id = "phoneui-badge";
  badge.className = "phoneui-toggle-badge";
  badge.textContent = "0";
  badge.setAttribute("aria-hidden", "true");

  btn.appendChild(badge);
  wrapper.appendChild(btn);
  return wrapper;
}

let toggleGuardianStarted = false;

function mountPhoneToggleButton() {
  ensureToggleStylesInjected();

  // Drop any stale copy first (a previous failed attempt, or a
  // guardian re-mount) so two buttons can never stack on each other.
  document.querySelectorAll("#phoneui-togglewrap").forEach((el) => el.remove());

  const wrapper = buildPhoneToggleElement();
  // Mounted on <html>, not <body> - keeps it out of whatever
  // container a theme applies a transform/overflow rule to, the same
  // reasoning forceFixedStyle already uses for the panel itself.
  (document.documentElement || document.body).appendChild(wrapper);
  forceFixedStyle(wrapper);

  const btn = wrapper.querySelector(".phoneui-togglebtn");
  // Wire up interactivity BEFORE anything that touches getSettings()
  // (applyTogglePosition, updateToggleBadge). Both of those can throw
  // if settings/metadata are in a broken state on a given SillyTavern
  // build - that shouldn't be able to leave the button visible but
  // dead (no click/drag), which is worse than just falling back to
  // the default corner position and an empty badge.
  btn.addEventListener("click", togglePanel);
  // Native <button> already fires "click" on Enter/Space, so no extra
  // keydown handling is needed for keyboard activation.
  attachToggleDragHandlers(wrapper, btn);

  try {
    applyTogglePosition(wrapper);
  } catch (e) {
    console.warn("[PhoneUI] Couldn't apply saved button position, using default corner.", e);
  }
  try {
    updateToggleBadge();
  } catch (e) {
    console.warn("[PhoneUI] Couldn't update the unread badge.", e);
  }

  startToggleGuardian();
  startSTOverlayWatcher();
}

// Keeps the button alive and correctly placed for as long as the
// extension is running. A MutationObserver on <html> catches removal
// almost immediately (a theme wiping/rebuilding part of the page); a
// slow interval underneath it is a backstop for whatever a childList
// observer might not catch (a style-only change that leaves the node
// in place but visually broken), not the primary mechanism.
function startToggleGuardian() {
  if (toggleGuardianStarted) return;
  toggleGuardianStarted = true;

  const root = document.documentElement || document.body;
  const observer = new MutationObserver(() => {
    if (!document.getElementById("phoneui-togglewrap")) {
      mountPhoneToggleButton();
    }
  });
  observer.observe(root, { childList: true, subtree: true });

  setInterval(() => {
    const healthy = checkAndRepairToggleHealth();
    if (!healthy && !toggleHealthBannerShown) {
      toggleHealthBannerShown = true;
      showLoadError("The floating phone button couldn't be shown. Use the \"Open Phone\" button in Extensions > Phone UI, or type /phone in the chat box.");
    }
  }, 3000);
}

function injectPanel() {
  const div = document.createElement("div");
  div.innerHTML = panelSkeleton();
  const panelEl = div.firstElementChild;
  forceFixedStyle(panelEl);
  (document.documentElement || document.body).appendChild(panelEl);
  const statusBar = panelEl.querySelector("#phoneui-statusbar");
  if (statusBar) makePanelDraggable(panelEl, statusBar);
  panelEl.querySelector("#phoneui-homebtn")?.addEventListener("click", goHome);
  renderPanel();
}

// Shows/hides the floating button + panel to match the "enabled"
// setting, without needing a page reload.
//
// Bug fix: this used to hide things purely via the .phoneui-hidden
// class (display:none !important). That loses to the toggle button's
// own injected stylesheet rule (#phoneui-togglewrap { ... display:
// block !important }) - an ID selector always outranks a class
// selector at equal !important weight, class-toggling alone can
// never actually hide the wrapper. Setting display inline (with
// !important) sidesteps the specificity fight entirely: an inline
// style always wins over any selector-based rule from a stylesheet,
// even an !important one, so this is a hard guarantee either way.
function applyEnabledState() {
  const s = getSettings();
  const wrapper = document.querySelector("#phoneui-togglewrap");
  const panel = document.querySelector("#phoneui-panel");
  if (wrapper) {
    wrapper.classList.toggle("phoneui-hidden", !s.enabled);
    if (!s.enabled) wrapper.style.setProperty("display", "none", "important");
    else wrapper.style.removeProperty("display");
  }
  if (panel) {
    if (!s.enabled) {
      panel.classList.add("phoneui-hidden");
      panel.style.setProperty("display", "none", "important");
    } else {
      // Only clear the forced-hidden override here; whether the panel
      // is open or closed right now is togglePanel()'s job via the
      // .phoneui-hidden class, untouched by re-enabling.
      panel.style.removeProperty("display");
    }
  }
}

// Builds the settings block SillyTavern expects under Extensions ->
// this shows up as its own collapsible drawer there.
//
// This used to be a single synchronous attempt: if
// #extensions_settings2 / #extensions_settings wasn't in the DOM yet
// at the exact moment this ran, it just logged a console.error and
// gave up for good - no retry, and (unlike every other init failure
// in this file) no on-screen banner either, so the drawer would
// silently never appear with no clue why. It also never reacted to
// the container being rebuilt/cleared later, unlike the floating
// toggle button which has its own MutationObserver watcher for
// exactly that case.
//
// Now this retries (same 15s/60-attempt pattern as resolveContext)
// until the container shows up, and a watcher puts the drawer back
// if it's ever removed from the DOM after the fact.
let settingsDrawerWatcherStarted = false;
async function injectSettingsPanel() {
  let container = null;
  for (let i = 0; i < 60; i++) {
    container =
      document.querySelector("#extensions_settings2") ||
      document.querySelector("#extensions_settings");
    if (container) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!container) {
    console.error("[PhoneUI] Could not find #extensions_settings2 / #extensions_settings to mount into.");
    showLoadError(
      "Could not find the Extensions settings panel to add the Phone UI drawer to. Open the browser console for details."
    );
    return;
  }

  doInjectSettingsPanel(container);

  if (!settingsDrawerWatcherStarted) {
    settingsDrawerWatcherStarted = true;
    watchSettingsDrawer();
  }
}

// If the extensions panel ever gets rebuilt/cleared and takes our
// drawer with it, put it back instead of leaving it gone for good.
// Mirrors startToggleGuardian() above.
function watchSettingsDrawer() {
  const observer = new MutationObserver(() => {
    if (document.querySelector("#phoneui-settings-drawer")) return;
    const container =
      document.querySelector("#extensions_settings2") ||
      document.querySelector("#extensions_settings");
    if (container) doInjectSettingsPanel(container);
  });
  observer.observe(document.documentElement || document.body, { childList: true, subtree: true });
}

function doInjectSettingsPanel(container) {
  if (document.querySelector("#phoneui-settings-drawer")) return; // already injected

  const s = getSettings();
  const wrapper = document.createElement("div");
  wrapper.innerHTML = `
    <div id="phoneui-settings-drawer" class="inline-drawer">
      <div class="inline-drawer-toggle inline-drawer-header">
        <b>Phone UI - Texts &amp; Social</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>
      <div class="inline-drawer-content">
        <div class="phoneui-settings-row">
          <button id="phoneui-openbtn" class="menu_button" type="button">
            <i class="fa-solid fa-mobile-screen-button"></i> Open Phone
          </button>
        </div>
        <div class="phoneui-settings-hint">
          Use this (or type <code>/phone</code> in the chat box) any time the
          floating button isn't showing up for some reason - both open the
          same panel.
        </div>
        <label class="checkbox_label" for="phoneui-enabled-toggle">
          <input id="phoneui-enabled-toggle" type="checkbox" ${s.enabled ? "checked" : ""} />
          <span>Enable phone panel</span>
        </label>
        <div class="phoneui-settings-row">
          <button id="phoneui-open-btn" class="menu_button" type="button">
            <i class="fa-solid fa-mobile-screen-button"></i> Open Phone UI
          </button>
        </div>
        <div class="phoneui-settings-hint">
          If the floating phone button doesn't appear on your device, use this
          button (or type <code>/phone</code> in the chat box) to open the panel
          instead. Same panel either way.
        </div>
        <div class="phoneui-settings-hint">
          Adds a floating phone button for texts, a social feed, and Discord-style
          servers, driven by [TEXT:], [POST:], [DISCORD_INVITE:] and [DISCORD:] tags
          in character output. See the extension's README for the tag format.
        </div>
        <label class="phoneui-settings-label" for="phoneui-gifkey-input">
          Klipy API key <span style="opacity:0.7">(optional)</span>
        </label>
        <input
          id="phoneui-gifkey-input"
          type="text"
          class="text_pole"
          placeholder="Paste your free Klipy test key here (optional)"
          value="${escapeHtml(s.gifApiKey || "")}"
        />
        <div class="phoneui-settings-hint">
          The GIF/meme button on Texts, Discord, and Post works out of the
          box with a small built-in offline reaction library (emoji-style
          "gifs", no internet needed). Paste a free Klipy key here (from
          the Klipy Partner Panel at klipy.com) to also pull in real gifs
          from Klipy whenever you're online — the offline set is still used
          automatically if Klipy is unreachable, times out, or you're
          offline.
        </div>
        <label class="phoneui-settings-label">Your photo (persona)</label>
        <div class="phoneui-personaphoto-row">
          <div class="phoneui-avatar phoneui-avatar-sm">
            <img id="phoneui-personaphoto-preview" class="phoneui-avatarimg" src="${escapeHtml(s.personaPhoto || "")}" alt="" style="${
    s.personaPhoto ? "" : "display:none"
  }" />
          </div>
          <button id="phoneui-personaphoto-btn" class="menu_button" type="button">
            <i class="fa-solid fa-camera"></i> ${s.personaPhoto ? "Change photo" : "Set photo"}
          </button>
          <button
            id="phoneui-personaphoto-remove"
            class="menu_button ${s.personaPhoto ? "" : "phoneui-hidden"}"
            type="button"
          >
            <i class="fa-solid fa-trash"></i> Remove
          </button>
        </div>
        <div class="phoneui-settings-hint">
          Shows up as your avatar anywhere you post or message as
          yourself (Discord messages, feed posts) instead of your
          initials. Local to this install, same as the Klipy key above.
        </div>
        <div class="phoneui-settings-row">
          <button id="phoneui-reset-btn" class="menu_button">
            <i class="fa-solid fa-trash"></i> Clear all phone data
          </button>
        </div>
      </div>
    </div>`;
  container.appendChild(wrapper.firstElementChild);

  document.querySelector("#phoneui-openbtn").addEventListener("click", () => {
    openPhonePanel();
  });

  document.querySelector("#phoneui-enabled-toggle").addEventListener("change", (e) => {
    const settings = getSettings();
    settings.enabled = e.target.checked;
    saveSettings();
    applyEnabledState();
  });

  // Opens the panel directly from the settings drawer, bypassing the
  // floating button entirely. Useful on devices/layouts where that
  // button doesn't render - this drawer is SillyTavern's own UI, so
  // if you can see this checkbox, this button works too.
  document.querySelector("#phoneui-open-btn").addEventListener("click", () => {
    const settings = getSettings();
    if (!settings.enabled) {
      settings.enabled = true;
      saveSettings();
      applyEnabledState();
      const enabledToggle = document.querySelector("#phoneui-enabled-toggle");
      if (enabledToggle) enabledToggle.checked = true;
    }
    const panel = document.querySelector("#phoneui-panel");
    if (panel && panel.classList.contains("phoneui-hidden")) {
      togglePanel();
    } else if (!panel) {
      // Panel wasn't injected yet for some reason - inject then open.
      injectPanel();
      togglePanel();
    }
  });

  document.querySelector("#phoneui-gifkey-input").addEventListener("change", (e) => {
    const settings = getSettings();
    settings.gifApiKey = e.target.value.trim();
    saveSettings();
  });

  document.querySelector("#phoneui-personaphoto-btn").addEventListener("click", async () => {
    const dataUrl = await pickImageFile();
    if (!dataUrl) return;
    const settings = getSettings();
    settings.personaPhoto = dataUrl;
    saveSettings();
    const preview = document.querySelector("#phoneui-personaphoto-preview");
    if (preview) {
      preview.src = dataUrl;
      preview.style.display = "";
    }
    document.querySelector("#phoneui-personaphoto-remove")?.classList.remove("phoneui-hidden");
    const btn = document.querySelector("#phoneui-personaphoto-btn");
    if (btn) btn.innerHTML = `<i class="fa-solid fa-camera"></i> Change photo`;
    renderPanel();
  });

  document.querySelector("#phoneui-personaphoto-remove").addEventListener("click", () => {
    const settings = getSettings();
    settings.personaPhoto = "";
    saveSettings();
    const preview = document.querySelector("#phoneui-personaphoto-preview");
    if (preview) {
      preview.src = "";
      preview.style.display = "none";
    }
    document.querySelector("#phoneui-personaphoto-remove")?.classList.add("phoneui-hidden");
    const btn = document.querySelector("#phoneui-personaphoto-btn");
    if (btn) btn.innerHTML = `<i class="fa-solid fa-camera"></i> Set photo`;
    renderPanel();
  });

  document.querySelector("#phoneui-reset-btn").addEventListener("click", () => {
    if (!confirm("Clear all texts, feed posts, contacts and Discord servers? This can't be undone.")) return;
    try {
      const settings = getSettings();
      settings.contacts = {};
      settings.threads = {};
      settings.groups = {};
      settings.groupThreads = {};
      settings.feed = [];
      settings.discordServers = {};
      settings.discordInvites = [];
      settings.storiesViewed = {};
      settings.unread = 0;
      saveSettings();
      activeTab = "home";
      activeThread = null;
      activeGroup = null;
      activeServer = null;
      activeChannel = null;
      groupCreate = { open: false, name: "", selected: new Set() };
      gifPicker.open = false;
      stopStoryTimer();
      storyViewer = { open: false, author: null, index: 0, timerId: null };
      updateToggleBadge();
      renderPanel();
      // Belt-and-suspenders: re-assert the button/panel's core
      // visibility properties right after the re-render, in case
      // anything in the reset touched the DOM in a way a host-page
      // CSS rule could otherwise exploit to hide them.
      const wrapperEl = document.querySelector("#phoneui-togglewrap");
      const panelEl = document.querySelector("#phoneui-panel");
      if (wrapperEl) forceFixedStyle(wrapperEl);
      if (panelEl) forceFixedStyle(panelEl);
    } catch (e) {
      console.error("[PhoneUI] Clearing phone data failed unexpectedly.", e);
      showLoadError("Clearing phone data failed: " + e.message + ". Open the browser console for details.");
    }
  });

}

// Registers a /phone slash command that opens/closes the panel from
// the normal chat input - no floating UI involved at all, so it
// works even in whatever edge case is keeping the floating button
// from rendering (handy on mobile, where that button can be finicky
// to see). SillyTavern's slash command API has changed across
// versions - modern builds expose SlashCommandParser/SlashCommand
// either as bare globals or under `context`, older builds only have
// the deprecated registerSlashCommand (again either global or on
// `context`) - so this tries each known style in order and fails
// silently (console log only) if none match; this is a bonus
// convenience, not something init should ever abort over, and the
// settings-drawer "Open Phone UI" button still works regardless.
function registerPhoneSlashCommand() {
  const callback = () => {
    openPhonePanel();
    return "";
  };

  try {
    const parser = context.SlashCommandParser || (typeof SlashCommandParser !== "undefined" ? SlashCommandParser : null);
    const cmdClass = context.SlashCommand || (typeof SlashCommand !== "undefined" ? SlashCommand : null);
    if (parser && typeof parser.addCommandObject === "function" && cmdClass && typeof cmdClass.fromProps === "function") {
      parser.addCommandObject(
        cmdClass.fromProps({
          name: "phone",
          callback,
          helpString: "Opens (or closes) the Phone UI panel.",
        })
      );
      console.log("[PhoneUI] Registered /phone via SlashCommandParser.");
      return;
    }
  } catch (e) {
    console.warn("[PhoneUI] Modern slash command registration failed, trying legacy API.", e);
  }

  try {
    const reg = context.registerSlashCommand || (typeof registerSlashCommand !== "undefined" ? registerSlashCommand : null);
    if (typeof reg === "function") {
      reg("phone", callback, [], "- opens (or closes) the Phone UI panel", true, true);
      console.log("[PhoneUI] Registered /phone via registerSlashCommand.");
      return;
    }
  } catch (e) {
    console.warn("[PhoneUI] Legacy slash command registration failed too. /phone won't be available.", e);
  }

  console.log("[PhoneUI] Could not register /phone slash command on this SillyTavern build - use the 'Open Phone UI' button in the extension's settings drawer instead.");
}

// Shared by the settings-drawer "Open Phone" button and the /phone
// slash command: forces the panel on regardless of current state
// (auto-enabling if the whole extension was toggled off), instead of
// just calling togglePanel() and doing nothing if things are already
// in a weird state.
function openPhonePanel() {
  const settings = getSettings();
  if (!settings.enabled) {
    settings.enabled = true;
    saveSettings();
    applyEnabledState();
    const enabledToggle = document.querySelector("#phoneui-enabled-toggle");
    if (enabledToggle) enabledToggle.checked = true;
  }
  let panel = document.querySelector("#phoneui-panel");
  if (!panel) {
    injectPanel();
    panel = document.querySelector("#phoneui-panel");
  }
  if (panel.classList.contains("phoneui-hidden")) {
    togglePanel();
  } else {
    togglePanel(); // already open - toggle acts as a close, matching a normal button
  }
}

async function initPhoneUI() {
  try {
    context = await resolveContext();
    if (!context) {
      // resolveContext() already showed a banner and logged details.
      return;
    }

    // Mount the floating button FIRST, in its own try/catch, before
    // touching settings/metadata at all. Previously getSettings() ran
    // first and the whole init shared one try/catch - so any throw in
    // getSettings() (e.g. structuredClone missing on some older/
    // embedded WebViews - now mitigated via safeClone above, but this
    // guards against whatever else could go wrong there too, like an
    // unexpected context shape on a given ST build) meant
    // mountPhoneToggleButton() never ran at all and the button simply
    // never existed, with nothing but an easy-to-miss banner as a
    // clue. Now the button's existence doesn't depend on settings
    // having loaded successfully - it comes up regardless, using
    // hardcoded defaults if getSettings() itself is broken.
    try {
      mountPhoneToggleButton();
    } catch (e) {
      console.error("[PhoneUI] Floating button failed to mount.", e);
      showLoadError("Floating button failed to mount: " + e.message + ". Open the browser console for details.");
    }

    getSettings();
    // Not awaited on purpose: this now retries internally for up to
    // ~15s if ST's Extensions panel container isn't in the DOM yet
    // (see injectSettingsPanel above), and the rest of the UI - most
    // importantly the floating phone button - shouldn't be stuck
    // waiting behind that. It injects itself whenever it's ready.
    injectSettingsPanel();
    injectNotificationContainer();
    injectPanel();
    applyEnabledState();
    registerPhoneSlashCommand();

    // Hook into ST's message stream. MESSAGE_RECEIVED fires with the
    // chat array index; we read the actual message text back out.
    const { eventSource, event_types } = context;
    eventSource.on(event_types.MESSAGE_RECEIVED, (index) => {
      // Bug fix: this used to ignore the enabled toggle entirely, so
      // turning "Enable phone panel" off in settings still parsed
      // every incoming message, popped toast notifications, and kept
      // piling data into threads/feed in the background - the toggle
      // only hid the button/panel, it didn't actually turn anything
      // off. Now a disabled phone truly does nothing until re-enabled.
      if (!getSettings().enabled) return;
      const msg = context.chat[index];
      if (msg && !msg.is_user) {
        handleIncomingMessage(msg.mes);
      }
    });

    // Phone data (texts, feed, Discord, contacts) now lives in the
    // current chat's metadata, so switching chats swaps in a
    // different chat's phone state entirely. Drop any open
    // thread/channel/picker (they belonged to the old chat) and
    // refresh everything to match what's actually loaded now.
    if (event_types.CHAT_CHANGED) {
      eventSource.on(event_types.CHAT_CHANGED, () => {
        activeTab = "home";
        activeThread = null;
        activeGroup = null;
        activeServer = null;
        activeChannel = null;
        groupCreate = { open: false, name: "", selected: new Set() };
        messageDrafts = { threads: {}, groups: {} };
        gifPicker.open = false;
        stopStoryTimer();
        storyViewer = { open: false, author: null, index: 0, timerId: null };
        clearTypingState(); // cancel any in-flight "typing..." deliveries from the old chat
        getSettings(); // ensures the new chat's metadata is backfilled
        applyEnabledState();
        updateToggleBadge();
        renderPanel();
        const enabledToggle = document.querySelector("#phoneui-enabled-toggle");
        if (enabledToggle) enabledToggle.checked = getSettings().enabled;
      });
    }

    console.log("[PhoneUI] loaded");
  } catch (e) {
    console.error("[PhoneUI] Unexpected error during init.", e);
    showLoadError("Unexpected error during init: " + e.message + ". Open the browser console for details.");
  }
}

// Use jQuery if it's available (normal ST case), but don't silently
// no-op if it isn't - fall back to a plain DOM-ready listener so a
// jQuery timing/load issue can't be the reason nothing appears.
if (typeof jQuery !== "undefined") {
  jQuery(async () => initPhoneUI());
} else if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initPhoneUI);
} else {
  initPhoneUI();
}
