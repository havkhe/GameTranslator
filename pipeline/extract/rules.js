// Extraction rules — aligned with MTool's practice, but stricter where MTool is wrong.
//
// Evidence used to design this file (see docs/重设计说明.md §4):
//   * MTool's own cache for a translated game held 2446 event-parameter strings plus
//     312 name fields; 1125 had kana, 23 were kanji-only ("神主", "杜氏", "警察官"),
//     112 were latin/internal noise ("EV001", "RPG::MoveRoute", "door").
//   * An earlier attempt to treat "no kana" as "already Chinese" measured a 24-52%
//     false-positive rate on 78,603 real translations (it would have skipped
//     "逃走成功", "地下牢獄"), so that inference is NOT used here.
//
// Three rules carried over from that analysis:
//   1. kanji-only text is kept — it is often a real name that needs translation;
//   2. internal identifiers are rejected — MTool collects them, we filter them;
//   3. every event-command text parameter is in scope (dialogue, speaker, choices,
//      branch text, name changes).

"use strict";

// Resource filenames and engine-internal identifiers never need translating, and
// translating them breaks the game (the file on disk keeps the original name).
const EXT_RE = /\.(png|jpg|jpeg|gif|bmp|webp|rpgmvp|rpgmvo|ogg|m4a|mp3|wav|rvdata2?|rxdata|json)$/i;
const INTERNAL_RE = /^(?:RPG::|Window_|Scene_|Game_|Sprite_|Bitmap$|Array$|Hash$|String$|Integer$)/;
const EVENT_ID_RE = /^[A-Z]{1,4}\d{2,}$/;          // EV001, NPC12 …
const PATH_LIKE_RE = /^[A-Za-z0-9_\-./\\%]+$/;      // ids, filenames, bare numbers

const KANA_RE = /[\u3040-\u309f\u30a0-\u30ff\uff66-\uff9f]/;
const HAN_RE = /[\u3400-\u9fff]/;
const CJK_RE = /[\u3040-\u30ff\u3400-\u9fff\uff66-\uff9f]/;

/**
 * Is this string something a translator should see?
 *
 * Deliberately permissive: MTool's experience is that a rule which is too clever
 * about "this looks like it does not need translating" silently drops dialogue.
 */
function isTranslatable(text) {
  if (typeof text !== "string") return false;
  const t = text.trim();
  if (!t) return false;
  if (!CJK_RE.test(t)) return false;               // no CJK at all -> not our target
  if (EXT_RE.test(t)) return false;                // resource filename
  if (INTERNAL_RE.test(t)) return false;           // engine class identifier
  if (EVENT_ID_RE.test(t)) return false;           // event id label
  if (PATH_LIKE_RE.test(t)) return false;          // pure ascii id/path/number
  return true;
}

/**
 * Event-command codes whose text parameters we translate.
 * Mirrors MTool's coverage of event parameters.
 *   code -> which parameter index holds the text (or a function for list params)
 */
const EVENT_TEXT_CODES = new Map([
  [401, [0]],        // show text (dialogue body)
  [101, [0]],        // show text header (speaker name box)
  [102, [0]],        // show choices (array of options)
  [402, [1]],        // when [**] (choice branch label)
  [405, [0]],        // scrolling text body
  [111, [2]],        // conditional branch: script/text operand
  [320, [1]],        // change actor name
  [324, [1]],        // change nickname
  [325, [1]],        // change class name
]);

/**
 * Database fields worth translating, by field name.
 *
 * MTool does not do this, so a game it translated keeps Japanese item and skill
 * names in its menus. We keep them: it is player-visible text.
 *
 * `note` is deliberately absent — RPG Maker plugins parse it as metadata
 * ("<CustomIcon: 5>"), so translating it breaks plugin behaviour.
 * Resource-name fields (`characterName`, `faceName`, `battlerName`, audio `name`)
 * are absent for the same reason.
 */
const TEXT_FIELDS = new Set([
  "name", "nickname", "description", "profile",
  "message1", "message2", "message3", "message4",
  "displayName", "currencyUnit", "title", "hint",
]);

/** System.json `terms` sub-objects that hold display text. */
const TERMS_KEYS = ["basic", "commands", "params", "messages", "hint"];

/** Keys whose subtree is metadata and must stay untouched. */
const META_KEYS = new Set(["metadata", "meta", "info", "__metadata", "note"]);

module.exports = {
  isTranslatable,
  EVENT_TEXT_CODES,
  TEXT_FIELDS,
  TERMS_KEYS,
  META_KEYS,
  EXT_RE,
  INTERNAL_RE,
  EVENT_ID_RE,
  PATH_LIKE_RE,
  KANA_RE,
  HAN_RE,
  CJK_RE,
};
