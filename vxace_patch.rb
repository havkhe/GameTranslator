# vxace_patch.rb <dataDir> <extractJson> <translationsJson>
# Replace translated strings inside every *.rvdata2 (marshal round-trip).
require "json"
require_relative "vxace_stubs"

TEXT_IVARS = %w[@name @nickname @description @profile
                @message1 @message2 @message3 @message4 @message5]

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

def main
  data_dir = ARGV[0].to_s.tr("\\", "/")
  extract_json = ARGV[1]
  trans_json = ARGV[2]
  raise "usage: vxace_patch.rb <dataDir> <extractJson> <translationsJson>" unless data_dir && extract_json && trans_json

  extract = JSON.parse(File.read(extract_json, encoding: Encoding::UTF_8))
  translations = JSON.parse(File.read(trans_json, encoding: Encoding::UTF_8))
  text_map = {}
  extract.each do |e|
    tr = translations[e["id"].to_s]
    text_map[e["text"]] = tr if tr.is_a?(String) && !tr.empty?
  end

  files = Dir[File.join(data_dir, "*.rvdata2")].sort.reject { |f| File.basename(f).match?(/\AScripts\.rvdata2\z/i) }
  replaced = 0
  errors = []

  files.each do |fp|
    begin
      obj = Marshal.load(File.binread(fp))
    rescue => e
      errors << "#{File.basename(fp)}: load failed: #{e.class}: #{e.message}"
      next
    end

    seen = {}
    walk = lambda do |node|
      case node
      when nil, true, false, Integer, Float, Symbol
        next
      when String
        t = normalize(node)
        if text_map.key?(t)
          node.replace(text_map[t].dup.force_encoding(Encoding::UTF_8))
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
              walk.call(v) if TEXT_IVARS.include?(ivar.to_s)
            else
              walk.call(v)
            end
          end
        end
      end
    end
    walk.call(obj)

    begin
      tmp = fp + ".tmp"
      File.binwrite(tmp, Marshal.dump(obj))
      File.rename(tmp, fp)
    rescue => e
      errors << "#{File.basename(fp)}: write failed: #{e.class}: #{e.message}"
    end
  end

  warn "ERRORS:" + errors.join("\n") unless errors.empty?
  warn "patched #{replaced} strings" unless ENV["VXACE_QUIET"]
end

main
