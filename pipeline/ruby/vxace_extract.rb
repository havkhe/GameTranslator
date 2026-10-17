# vxace_extract.rb <dataDir> <outJson>
# Load every *.rvdata2 (VX Ace) / *.rvdata (VX), walk the object graph, collect
# translatable Japanese strings, and write [{id, file, path, text}] as UTF-8 JSON.
# Both engines use the same Ruby Marshal layout (only the file extension and
# archive container differ), so one walker covers them.
require "json"
require_relative "vxace_stubs"

# Data file extensions by engine. VX Ace = .rvdata2, VX = .rvdata.
DATA_EXT_RE = /\.rvdata2?\z/i
# `Scripts` holds the game's Ruby source, never player-visible text.
def script_file?(base)
  base.match?(/\AScripts\.rvdata2?\z/i)
end

# NOTE: deliberately not `Dir[...]` globbing. Game folders routinely contain
# glob metacharacters (`[輪々処] …`), and a literal `[...]` in the path makes
# Ruby treat it as a character class, silently matching zero files.
def data_files(dir)
  return [] unless File.directory?(dir)
  Dir.children(dir)
     .select { |f| f.match?(DATA_EXT_RE) }
     .reject { |f| script_file?(f) }
     .map { |f| File.join(dir, f) }
     .sort
end

# Fields that hold player-visible text. Must stay identical to the list in
# vxace_patch.rb: a field collected here but not patched there (or vice versa)
# produces "translated but not written back" or "written back but never shown".
# MUST stay identical to the list in vxace_patch.rb.
TEXT_IVARS = %w[@name @nickname @description @profile
                @message1 @message2 @message3 @message4 @message5
                @display_name @note]

# Fields that name a file on disk. Some of them sit in an ARRAY - a tileset's sheet list
# (@tileset_names) is an Array of nine sheet filenames - and a value reached through an Array
# bypasses TEXT_IVARS entirely, so these must be denied by name instead of by value type.
#
# Measured on a real game (LewDemon Academy, VX Ace): the sheet name 運動場 reached the model, came
# back as 运动场, and was written into the data. The game then asked for
# Graphics/Tilesets/运动场.png and refused to start with "unable to find file
# graphics\Tilesets\运动场". The same game's map of the same name was translated too - which is
# correct, and is exactly why a text-keyed patch cannot tell the two apart: a map name and a sheet
# filename are the same string. Only the field tells them apart.
#
# (@name is NOT denied: on a tileset it is the editor's display name, and translating it is
# harmless - verified on that game, where the sheets broke and the display names did not.)
RESOURCE_IVARS = %w[@tileset_names @tileset_name
                    @face_name @character_name @battler_name
                    @title_name @battleback1_name @battleback2_name
                    @animation1_name @animation2_name]

# RPG::AudioFile / BGM / BGS / ME / SE: their @name is a file reference and
# must never be translated (the on-disk file keeps the original name).
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

# Which raw strings are worth handing to the JS rules.
#
# This used to require kana or Han, and that silently threw away EVERY line of an English release. Measured on
# an English VX Ace release: all 208 data files loaded fine, the maps held 15,366 message commands (code 401) whose text is
# plain English, and only 1,375 raw strings survived — the dialogue never reached the pipeline, so the run
# "finished" with the game still English and only the Japanese leftovers (names, UI) translated.
#
# extract/rules.js already tells English prose from identifiers (isTranslatableEnglish: two words or a
# sentence ending, minus paths, filenames and event ids), and vxace.js applies it to everything this file
# returns. So this gate only has to be permissive: anything with Japanese, or carrying Latin letters at all,
# goes through and the JS side decides.
def translatable?(s)
  return false if s.nil? || s.length > 2000
  return true if s =~ /[\p{Hiragana}\p{Katakana}\p{Han}]/
  s =~ /[A-Za-z]/
end

def main
  data_dir = ARGV[0].to_s.tr("\\", "/")
  out_json = ARGV[1]
  raise "usage: vxace_extract.rb <dataDir> <outJson>" unless data_dir && out_json

  files = data_files(data_dir)
  raise "no .rvdata2/.rvdata files in #{data_dir}" if files.empty?

  entries = []
  text_ids = {}
  next_id = 0
  errors = []

  files.each do |fp|
    file = File.basename(fp)
    begin
      obj = Marshal.load(File.binread(fp))
    rescue => e
      errors << "#{file}: #{e.class}: #{e.message}"
      next
    end

    seen = {}
    walk = lambda do |node, path|
      case node
      when nil, true, false, Integer, Float, Symbol
        next
      when String
        t = normalize(node)
        next unless translatable?(t)
        key = t
        unless text_ids.key?(key)
          text_ids[key] = next_id
          entries << { "id" => next_id, "file" => file, "path" => path, "text" => t }
          next_id += 1
        end
      when Array
        oid = node.object_id
        next if seen[oid]
        seen[oid] = true
        node.each_with_index { |v, i| walk.call(v, "#{path}[#{i}]") }
      when Hash
        oid = node.object_id
        next if seen[oid]
        seen[oid] = true
        node.each { |k, v| walk.call(v, "#{path}.#{k}") }
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
            walk.call(params[0], "#{path} @text") if params[0]
          when 102
            if params[0].is_a?(Array)
              params[0].each_with_index { |c, i| walk.call(c, "#{path} @choices[#{i}]") }
            end
          when 402
            walk.call(params[1], "#{path} @choice") if params[1]
          when 241, 245, 249, 250
            next # audio playback commands: parameters are audio file refs
          end
          next
        elsif node.is_a?(RPG::System::Terms)
          %w[@basic @commands @params @messages].each do |ivar|
            arr = node.instance_variable_get(ivar)
            next unless arr.is_a?(Array)
            arr.each_with_index { |v, i| walk.call(v, "#{path} #{ivar}[#{i}]") }
          end
          next
        else
          node.instance_variables.each do |ivar|
            next if RESOURCE_IVARS.include?(ivar.to_s)
            v = node.instance_variable_get(ivar)
            if v.is_a?(String)
              if TEXT_IVARS.include?(ivar.to_s) && !(audio_object?(node) && ivar.to_s == "@name")
                walk.call(v, "#{path} #{ivar}")
              end
            else
              walk.call(v, "#{path} #{ivar}")
            end
          end
        end
      end
    end
    walk.call(obj, File.basename(fp).sub(/\.rvdata2?\z/i, ""))
  end

  File.write(out_json, JSON.generate(entries), encoding: Encoding::UTF_8)
  warn "ERRORS:" + errors.join("\n") unless errors.empty?
  warn "extracted #{entries.size} unique strings from #{files.size} files" unless ENV["VXACE_QUIET"]
end

main
