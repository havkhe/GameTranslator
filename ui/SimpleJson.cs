// Minimal JSON reader for the pipeline's own files.
//
// Written by hand on purpose: the build uses the framework csc.exe with no NuGet
// access, so a dependency such as Newtonsoft.Json cannot be restored. It only needs
// to read the shapes the pipeline writes (arrays of flat objects, and flat objects),
// and it is defensive: malformed input yields null rather than throwing into the UI.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace GameTranslatorV3
{
    internal static class SimpleJson
    {
        /// <summary>Top-level array of objects, as games-cache.json uses. Never null.</summary>
        public static List<Dictionary<string, string>> Array(string json)
        {
            var list = new List<Dictionary<string, string>>();
            if (string.IsNullOrEmpty(json)) return list;
            int i = json.IndexOf('[');
            if (i < 0) return list;
            i++;
            while (i < json.Length)
            {
                while (i < json.Length && (char.IsWhiteSpace(json[i]) || json[i] == ',')) i++;
                if (i >= json.Length || json[i] == ']') break;
                if (json[i] != '{') { i++; continue; }
                int depth = 0, start = i;
                bool inStr = false, esc = false;
                for (; i < json.Length; i++)
                {
                    char c = json[i];
                    if (inStr)
                    {
                        if (esc) esc = false;
                        else if (c == '\\') esc = true;
                        else if (c == '"') inStr = false;
                        continue;
                    }
                    if (c == '"') { inStr = true; continue; }
                    if (c == '{') depth++;
                    else if (c == '}')
                    {
                        depth--;
                        if (depth == 0) { i++; break; }
                    }
                }
                var obj = ParseFlat(json.Substring(start, i - start));
                if (obj != null) list.Add(obj);
            }
            return list;
        }

        /// <summary>Flat object: keys mapped to their raw scalar values as strings.</summary>
        public static Dictionary<string, string> ParseFlat(string json)
        {
            var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            if (string.IsNullOrEmpty(json)) return map;
            int i = 0;
            while (i < json.Length)
            {
                int q = json.IndexOf('"', i);
                if (q < 0) break;
                var key = ReadString(json, ref q);
                if (key == null) { i = q + 1; continue; }
                int colon = json.IndexOf(':', q);
                if (colon < 0) break;
                i = colon + 1;
                while (i < json.Length && char.IsWhiteSpace(json[i])) i++;
                if (i >= json.Length) break;
                string value;
                if (json[i] == '"')
                {
                    int p = i;
                    value = ReadString(json, ref p);
                    i = p;
                }
                else
                {
                    int end = i;
                    while (end < json.Length && json[end] != ',' && json[end] != '}' && json[end] != ']') end++;
                    value = json.Substring(i, end - i).Trim();
                    i = end;
                }
                map[key] = value;
            }
            return map;
        }

        /// <summary>Read a JSON string starting at the quote at <paramref name="i"/>.</summary>
        private static string ReadString(string s, ref int i)
        {
            if (i >= s.Length || s[i] != '"') return null;
            i++;
            var sb = new StringBuilder();
            while (i < s.Length)
            {
                char c = s[i];
                if (c == '\\' && i + 1 < s.Length)
                {
                    char n = s[++i];
                    switch (n)
                    {
                        case 'n': sb.Append('\n'); break;
                        case 'r': sb.Append('\r'); break;
                        case 't': sb.Append('\t'); break;
                        case 'u':
                            if (i + 4 < s.Length)
                            {
                                int code;
                                if (int.TryParse(s.Substring(i + 1, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out code))
                                {
                                    sb.Append((char)code);
                                    i += 4;
                                }
                            }
                            break;
                        default: sb.Append(n); break;
                    }
                    i++;
                    continue;
                }
                if (c == '"') { i++; return sb.ToString(); }
                sb.Append(c);
                i++;
            }
            return sb.ToString();
        }

        public static string Get(Dictionary<string, string> obj, string key)
        {
            if (obj == null) return null;
            string v;
            return obj.TryGetValue(key, out v) ? v : null;
        }

        public static int GetInt(string json, string key)
        {
            if (string.IsNullOrEmpty(json)) return -1;
            int idx = json.IndexOf("\"" + key + "\"", StringComparison.OrdinalIgnoreCase);
            if (idx < 0) return -1;
            int colon = json.IndexOf(':', idx);
            if (colon < 0) return -1;
            int i = colon + 1;
            while (i < json.Length && char.IsWhiteSpace(json[i])) i++;
            int start = i;
            while (i < json.Length && (char.IsDigit(json[i]) || json[i] == '-')) i++;
            int value;
            return int.TryParse(json.Substring(start, i - start), out value) ? value : -1;
        }

        public static int GetInt(Dictionary<string, string> obj, string key)
        {
            var v = Get(obj, key);
            int value;
            return int.TryParse(v, out value) ? value : -1;
        }

        public static bool GetBool(Dictionary<string, string> obj, string key)
        {
            var v = Get(obj, key);
            return string.Equals(v, "true", StringComparison.OrdinalIgnoreCase);
        }
    }
}
