# test-resource-ivars.rb -- regression test for translated resource filenames (VX / VX Ace).
#
# The bug it pins down: a tileset's sheet list (@tileset_names) is an Array of filenames, and a
# string reached through an Array bypassed the TEXT_IVARS gate in both vxace_extract.rb and
# vxace_patch.rb. So a map that is legitimately called 運動場 was translated to 运动场, and the very
# same dictionary entry was then written into the tileset's sheet list. The game asked for
# Graphics/Tilesets/运动场.png and refused to start.
#
# The fixture makes that collision explicit: one string, 運動場, is BOTH a map name (must be
# translated) and a sheet filename (must not be). Only the field tells them apart.
#
#   ruby test-resource-ivars.rb        [VXTEST_DIR=/some/dir to keep the fixture]
require "fileutils"
require "json"
require "tmpdir"
require_relative "vxace_stubs"

$VERBOSE = nil                     # the two scripts define the same constants; warnings are noise

DIR = __dir__
TMP = File.expand_path(ENV["VXTEST_DIR"] || File.join(Dir.tmpdir, "vxace-resource-ivar-test"))
DATA = File.join(TMP, "Data")
EXTRACT = File.join(TMP, "extract.json")
TRANS = File.join(TMP, "translations.json")
REPORT = File.join(TMP, "patch-report.json")

fails = []
def check(fails, cond, label)
  puts((cond ? "  PASS  " : "  FAIL  ") + label)
  fails << label unless cond
end

# ---------------------------------------------------------------- fixture
FileUtils.rm_rf(TMP)
FileUtils.mkdir_p(DATA)
FileUtils.mkdir_p(File.join(TMP, "Graphics", "Tilesets"))
FileUtils.touch(File.join(TMP, "Graphics", "Tilesets", "運動場.png"))   # the file the game looks for

tileset = RPG::Tileset.new
tileset.instance_variable_set(:@id, 2)
tileset.instance_variable_set(:@name, "外観")
tileset.instance_variable_set(:@tileset_names,
  ["Outside_A1", "", "", "", "", "", "", "運動場", ""])
File.binwrite(File.join(DATA, "Tilesets.rvdata2"), Marshal.dump([nil, tileset]))

mapinfo = RPG::MapInfo.new
mapinfo.instance_variable_set(:@name, "運動場")          # same text, different role
File.binwrite(File.join(DATA, "MapInfos.rvdata2"), Marshal.dump([nil, mapinfo]))

actor = RPG::Actor.new
actor.instance_variable_set(:@name, "アイラ")
actor.instance_variable_set(:@description, "剣士の少女です")
File.binwrite(File.join(DATA, "Actors.rvdata2"), Marshal.dump([nil, actor]))

File.write(TRANS, JSON.generate({ "version" => 3, "byText" => {
  "運動場" => "运动场",          # the map name translation, which must NOT reach the sheet list
  "アイラ" => "艾拉",
  "剣士の少女です" => "她是个剑士少女。",
} }), encoding: Encoding::UTF_8)

# ---------------------------------------------------------------- extract
ARGV.replace([DATA, EXTRACT])
load File.join(DIR, "vxace_extract.rb")
entries = JSON.parse(File.read(EXTRACT, encoding: Encoding::UTF_8))
texts = entries.map { |e| e["text"] }
from_tilesets = entries.select { |e| e["file"] == "Tilesets.rvdata2" }.map { |e| e["text"] }

puts "extract: #{entries.size} 条"
check(fails, !texts.include?("外観") || from_tilesets.include?("外観"),
      "@name（编辑器显示名）仍然会翻译")
check(fails, !from_tilesets.include?("運動場"),
      "Tilesets.rvdata2 的 @tileset_names 里的文件名没有被收进翻译任务")
check(fails, entries.any? { |e| e["file"] == "MapInfos.rvdata2" && e["text"] == "運動場" },
      "同名同字的地图名（MapInfos）仍然被收进翻译任务")
check(fails, texts.include?("アイラ"), "普通正文（角色名）仍然被收进翻译任务")

# ---------------------------------------------------------------- patch
ARGV.replace([DATA, EXTRACT, TRANS, REPORT])
load File.join(DIR, "vxace_patch.rb")

after = Marshal.load(File.binread(File.join(DATA, "Tilesets.rvdata2")))
sheets = after[1].instance_variable_get(:@tileset_names)
check(fails, sheets[7] == "運動場", "补丁之后 sheet 文件名仍是 運動場（实际 #{sheets[7].inspect}）")

maps = Marshal.load(File.binread(File.join(DATA, "MapInfos.rvdata2")))
check(fails, maps[1].instance_variable_get(:@name) == "运动场",
      "地图名(sheet 同名的那个)确实被翻译成 运动场（实际 #{maps[1].instance_variable_get(:@name).inspect}）")

actors = Marshal.load(File.binread(File.join(DATA, "Actors.rvdata2")))
check(fails, actors[1].instance_variable_get(:@name) == "艾拉", "普通正文确实被翻译")
check(fails, actors[1].instance_variable_get(:@description) == "她是个剑士少女。", "描述字段确实被翻译")

puts ""
if fails.empty?
  puts "全部通过"
  exit 0
else
  puts "#{fails.size} 项失败"
  exit 1
end
