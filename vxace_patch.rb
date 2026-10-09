# vxace_patch.rb <dataDir> <extractJson> <translationsJson> [reportJson]
# Replace translated strings inside every *.rvdata2 (marshal round-trip).
# The translation cache is keyed by the normalized source text (v2.4+); older
# id-keyed caches are still accepted so existing progress is not lost.
require "json"
require_relative "vxace_stubs"

# Must match vxace_extract.rb exactly (see the comment there).
TEXT_IVARS = %w[@name @nickname @description @profile
                @message1 @message2 @message3 @message4 @message5
                @display_name @note]

def audio_object?(node)
  [RPG::AudioFile, RPG::BGM, RPG::BGS, RPG::ME, RPG::SE].any? { |k| node.is_a?(k) }
end

def normalize(s)
  enc = s.encoding
  if enc == Encoding::UTF_8
    return s.valid_encoding? ? s : nil
  elsif enc == Encoding::ASCII_8BIT
    u = s.dup.force_encoding(Encoding::UTF_8)
    return u if u.valid_encoding?
    begin
      u2 = s.dup.force_encoding(Encoding::Windows_31J).encode(Encoding::UTF_8)
      return u2.valid_encoding? ? u2 : nil
    rescue
      return nil
    end
  else
    begin
      u3 = s.encode(Encoding::UTF_8)
      return u3.valid_encoding? ? u3 : nil
    rescue
      return nil
    end
  end
end

def norm_key(s)
  s.to_s.gsub("\r\n", "\n").gsub("\r", "\n").sub(/\A\s+/, "").sub(/\s+\z/, "")
end

def main
  data_dir = ARGV[0].to_s.tr("\\", "/")
  extract_json = ARGV[1]
  trans_json = ARGV[2]
  report_json = ARGV[3]
  raise "usage: vxace_patch.rb <dataDir> <extractJson> <translationsJson> [reportJson]" unless data_dir && extract_json && trans_json

  extract = JSON.parse(File.read(extract_json, encoding: Encoding::UTF_8))
  raw = JSON.parse(File.read(trans_json, encoding: Encoding::UTF_8))

  # v2.4 cache: {"version":2,"byText":{...}}; v2.3 cache: {"<extract id>":"译文"}
  text_map = {}
  if raw.is_a?(Hash) && raw["byText"].is_a?(Hash)
    raw["byText"].each do |src, tr|
      text_map[norm_key(src)] = tr if tr.is_a?(String) && !tr.empty?
    end
  else
    by_id = raw.is_a?(Hash) ? raw : {}
    extract.each do |e|
      id = e["id"]
      tr = id.nil? ? nil : by_id[id.to_s]
      tr = by_id[id] if tr.nil? && !id.nil?
      text_map[norm_key(e["text"])] = tr if tr.is_a?(String) && !tr.empty?
    end
  end

  files = Dir[File.join(data_dir, "*.rvdata2")].sort.reject { |f| File.basename(f).match?(/\AScripts\.rvdata2\z/i) }
  replaced = 0
  missing = 0
  errors = []
  per_file = []

  files.each do |fp|
    begin
      obj = Marshal.load(File.binread(fp))
    rescue => e
      errors << "#{File.basename(fp)}: load failed: #{e.class}: #{e.message}"
      next
    end

    seen = {}
    before = replaced
    walk = lambda do |node|
      case node
      when nil, true, false, Integer, Float, Symbol
        next
      when String
        t = normalize(node)
        next if t.nil?
        key = norm_key(t)
        if text_map.key?(key)
          begin
            node.replace(text_map[key].dup.force_encoding(Encoding::UTF_8))
          rescue FrozenError
            # Frozen strings (game data can contain them) must be replaced in
            # place by the caller; count it so the report does not hide losses.
            errors << "#{File.basename(fp)}: frozen string skipped"
          end
          replaced += 1
        end
      when Array
        oid = node.object_id
        next if seen[oid]
        seen[oid] = true
        node.each { |v| walk.call(v) }
      when Hash
        oid = node.object_id
        next if seen[oid]
        seen[oid] = true
        node.each_value { |v| walk.call(v) }
      else
        oid = node.object_id
        next if seen[oid]
        seen[oid] = true
        if node.is_a?(RPG::EventCommand)
          code = node.instance_variable_get(:@code)
          params = node.instance_variable_get(:@parameters)
          params ||= []
          case code
          when 401, 405
            walk.call(params[0]) if params[0]
          when 102
            params[0].each { |c| walk.call(c) } if params[0].is_a?(Array)
          when 402
            walk.call(params[1]) if params[1]
          when 241, 245, 249, 250
            next # audio playback commands: parameters are audio file refs
          end
          next
        elsif node.is_a?(RPG::System::Terms)
          %w[@basic @commands @params @messages].each do |ivar|
            arr = node.instance_variable_get(ivar)
            arr.each { |v| walk.call(v) } if arr.is_a?(Array)
          end
          next
        else
          node.instance_variables.each do |ivar|
            v = node.instance_variable_get(ivar)
            if v.is_a?(String)
              if TEXT_IVARS.include?(ivar.to_s) && !(audio_object?(node) && ivar.to_s == "@name")
                t = normalize(v)
                if t && !text_map.key?(norm_key(t))
                  missing += 1 unless t.empty?
                end
                walk.call(v)
              end
            else
              walk.call(v)
            end
          end
        end
      end
    end
    walk.call(obj)
    per_file << { "file" => File.basename(fp), "replaced" => replaced - before }

    begin
      tmp = fp + ".tmp"
      File.binwrite(tmp, Marshal.dump(obj))
      File.rename(tmp, fp)
    rescue => e
      errors << "#{File.basename(fp)}: write failed: #{e.class}: #{e.message}"
    end
  end

  if report_json
    begin
      File.write(report_json, JSON.generate({
        "engine" => "VXAce",
        "replacedStrings" => replaced,
        "translatedEntries" => text_map.size,
        "entriesWithoutTextKey" => missing,
        "files" => per_file.select { |f| f["replaced"] > 0 },
        "errors" => errors,
      }))
    rescue => e
      warn "report write failed: #{e.message}"
    end
  end

  warn "ERRORS:" + errors.join("\n") unless errors.empty?
  warn "patched #{replaced} strings" unless ENV["VXACE_QUIET"]
end

main
