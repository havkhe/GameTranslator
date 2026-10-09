# Build the synthetic VX data files for the e2e test, using Ruby's own Marshal
# so the bytes are correct by construction.
#   ruby make-vx-data.rb <outDir>
require_relative "vxace_stubs"

out = ARGV[0]
raise "usage: make-vx-data.rb <outDir>" unless out
require "fileutils"
FileUtils.mkdir_p(out)

def dump(path, obj)
  File.binwrite(path, Marshal.dump(obj))
end

actor = RPG::Actor.new
actor.instance_variable_set(:@name, "アイラ")
actor.instance_variable_set(:@nickname, "アイ")
actor.instance_variable_set(:@description, "剣士の少女です")
dump(File.join(out, "Actors.rvdata"), actor)

terms = RPG::System::Terms.new
terms.instance_variable_set(:@basic, ["レベル", "ＨＰ"])
terms.instance_variable_set(:@commands, ["戦う", "逃げる"])
system = RPG::System.new
system.instance_variable_set(:@terms, terms)
system.instance_variable_set(:@game_title, "テストゲーム")
dump(File.join(out, "System.rvdata"), system)

page = RPG::Event::Page.new
cmd1 = RPG::EventCommand.new
cmd1.instance_variable_set(:@code, 401)
cmd1.instance_variable_set(:@parameters, ["これはテストの台詞です"])
cmd2 = RPG::EventCommand.new
cmd2.instance_variable_set(:@code, 401)
cmd2.instance_variable_set(:@parameters, ["つづきのセリフです"])
cmd3 = RPG::EventCommand.new
cmd3.instance_variable_set(:@code, 102)
cmd3.instance_variable_set(:@parameters, [["はい", "いいえ"], 0, 0, 2])
page.instance_variable_set(:@list, [cmd1, cmd2, cmd3])
event = RPG::Event.new
event.instance_variable_set(:@pages, [page])
map = [nil, event]
dump(File.join(out, "Map001.rvdata"), map)

# plain text that must never be translated
File.binwrite(File.join(out, "Scripts.rvdata"), "ruby source \u30C6\u30B9\u30C8 never translated")

warn "wrote #{Dir.children(out).size} files to #{out}"
