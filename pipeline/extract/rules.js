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
 *
 * But an empty or whitespace-only line must NOT be queued. Measured: one blank line
 * inside a batch of eight made the model lose count — it merged two entries and
 * inserted a note like "（到这里为止5）" — so the reply had the wrong number of lines
 * and the whole batch failed and split. 45% of batches failed that way.
 */
function isTranslatable(text) {
  if (typeof text !== "string") return false;
  const t = text.trim();
  if (!t) return false;                            // empty / whitespace only
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
 *
 * Code 101 is the one entry that is not simply "the text slot":
 *
 *   MV   command101: setFaceImage(params[0], params[1]); setBackground(params[2]); setPositionType(params[3])
 *   MZ   the same, plus setSpeakerName(params[4])
 *
 * So slot 0 is the FACE IMAGE FILE NAME — a resource reference — and slot 4 is the speaker name, which
 * is the text the name box shows. The table used to say `[0]`, which was a VX Ace reading carried into
 * the MV/MZ table: in VX Ace, command 101's first parameter really is the message text. Measured across
 * the library, the consequence was both kinds of error at once:
 *
 *   * slot 0 targets a file name. 13 kana face names across 4 games ("ちんぴら", "デフォ顔１", "モブ08"),
 *     all of them present in img/faces — translating one renames nothing on disk and the face stops
 *     loading, exactly the damage the audio `name` field caused.
 *   * slot 4 is missed. 1,777 distinct Japanese speaker names across 19 games ("ダンジョン測量士
 *     ペーター", "\c[27]カエン"), so an MZ game's dialogue came out Chinese under a Japanese name box.
 *
 * MTool extracts slot 4 too (157 keys on the one game whose export is readable), which is how the
 * mismatch surfaced.
 */
const EVENT_TEXT_CODES = new Map([
  [401, [0]],        // show text (dialogue body)
  [101, [4]],        // show text header: slot 4 is the speaker name; slot 0 is the face file name
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

/**
 * Objects whose `name` is a file reference, not display text.
 *
 * The audio containers hold `{name, volume, pitch, pan}`, and that `name` is the file the engine loads
 * (`audio/bgm/<name>.ogg`). The field is called `name`, which TEXT_FIELDS matches, so without this the
 * extractor queues audio filenames for translation and the patch step renames them — measured on one
 * game: 44 map files had their BGM renamed ("夏の日差しに" → "夏日阳光") and those maps could no longer
 * load their music. Resource fields are excluded by name (characterName, faceName, …); this covers the
 * same class where the field is just `name`.
 */
const AUDIO_CONTAINER_KEYS = new Set([
  "bgm", "bgs", "me", "se", "sounds", "sound",
  "titleBgm", "battleBgm", "victoryMe", "defeatMe", "gameoverMe",
]);

/** Keys whose subtree is metadata and must stay untouched. */
const META_KEYS = new Set(["metadata", "meta", "info", "__metadata", "note"]);

/**
 * Plugin-command codes whose arguments hold text — as `key = value` lines, not as whole strings.
 *
 * A plugin command stores each argument as `パラメータ名 = 値`, where the key is the plugin's own parameter
 * name in Japanese and the value is the author's data: display text, a number, a boolean, or the name of a
 * file the plugin will load. Translating the whole line was never an option —
 *
 *   measured on one library game: 172,596 such lines, of which the key alone is Japanese in almost every
 *   one ("対象キャラ名 = 琵琶乃", "キャンセル許可 = false", "ウィンドウ画像 = "), and 10,448 have a file or
 *   resource name as the value ("リソースラベル = Hiroka_Prologue_000", "ファイル名 = オープニング_3行で_01",
 *   "取り込み元ファイル名 = message.txt"). Translating a key makes the plugin stop recognising its own
 *   argument; translating a resource name makes it load the wrong file — the same class of damage the audio
 *   `name` field and the face-image name caused (44 + 8 + 13 fields measured), but a hundred times larger.
 *
 * So only the VALUE is ever queued, and only when it really is display text: see
 * pluginArgValueTranslatable, whose filters leave 0 / 64 / 5,322 new entries on the four games measured
 * while refusing 7,596 / 5,012 / 123,692 values.
 */
const PLUGIN_ARG_CODES = new Set([356, 357, 657]);

/**
 * Keys whose value names a file or resource the plugin resolves.
 *
 * The value often looks like text — "オープニング_3行で_01" carries kana — so the key is what tells the two
 * apart. ASCII keys are included because the same plugins take both spellings.
 */
const RESOURCE_ARG_KEY = /(リソース|ファイル|フォルダ|画像|素材|パス|音声|ボイス|サウンド|スクリーン|アイコン|アニメ|モーション|タイル|グラフィック|立ち絵|bgm|bgs|voice|sound|image|img|file|path|folder|sprite|picture)/i;

/**
 * Split one `key = value` plugin argument, keeping the exact bytes around the value.
 *
 * `prefix` is everything up to and including the separator and the spaces after it, `suffix` is the
 * trailing whitespace, so patching can put a new value back without disturbing the author's spacing or the
 * full-width `＝` some plugins use.
 *
 * @returns {{prefix: string, key: string, value: string, suffix: string}|null} null when there is no
 *          `key = value` shape at all (a bare label such as "文章の表示", or a plugin name).
 */
function splitPluginArg(text) {
  const t = String(text);
  const m = t.match(/^(\s*.{1,30}?\s*[=＝]\s*)(\S(?:[\s\S]*\S)?)(\s*)$/);
  if (!m) return null;
  return { prefix: m[1], key: m[1].replace(/[=＝\s]+$/, "").trim(), value: m[2], suffix: m[3] };
}

/**
 * Is this plugin argument's value display text that a translator should see?
 *
 * Every filter here is a measured refusal, not a guess:
 *
 *   kana required        a kana-free value in a plugin argument is a name, an id or a kanji term that reads
 *                        the same in Chinese — "対象キャラ名 = 琵琶乃" (a name), "リソースラベル = ..." (an id).
 *                        Requiring kana is what removes ~60,000 no-op translations on one measured game and
 *                        all 7,596 English values on another (its choice text is English, its story lives in
 *                        text/message.txt, so it gains nothing here — correctly).
 *   resource key         "ファイル名 = オープニング_3行で_01" has kana and must still be refused.
 *   number / boolean     "結果受け取り変数 = 15", "キャンセル許可 = false", "ウィンドウ幅 = 720".
 *   JSON structure       "選択肢リスト = [{...}]" — the text is inside the structure, and rebuilding it
 *                        would corrupt the plugin's data.
 *   file / path / URL    a bare reference that survived the key test.
 */
function pluginArgValueTranslatable(key, value) {
  if (typeof key !== "string" || typeof value !== "string") return false;
  if (!value) return false;
  if (!KANA_RE.test(value)) return false;
  if (RESOURCE_ARG_KEY.test(key)) return false;
  if (/^(true|false|null|\d+([.,]\d+)?)$/i.test(value)) return false;
  if (/^[\[{]/.test(value)) return false;
  if (/\.(png|jpg|jpeg|gif|bmp|webp|ogg|m4a|mp3|wav|json|txt|csv|rpgmvp|rpgmvo|rpgmvm)$/i.test(value)) return false;
  if (/^(https?:|[A-Za-z]:[\\/]|\/)/.test(value)) return false;
  return true;
}

module.exports = {
  isTranslatable,
  EVENT_TEXT_CODES,
  TEXT_FIELDS,
  TERMS_KEYS,
  META_KEYS,
  AUDIO_CONTAINER_KEYS,
  PLUGIN_ARG_CODES,
  RESOURCE_ARG_KEY,
  splitPluginArg,
  pluginArgValueTranslatable,
  EXT_RE,
  INTERNAL_RE,
  EVENT_ID_RE,
  PATH_LIKE_RE,
  KANA_RE,
  HAN_RE,
  CJK_RE,
};
