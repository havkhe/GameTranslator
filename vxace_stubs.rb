# Stub class definitions so that Marshal.load can instantiate RPG Maker VX Ace
# data objects in plain Ruby (no RGSS runtime required).
# Only the class names matter for marshal round-trip; no methods are needed.

module RPG
  class BaseItem; end
  class BaseItem::Feature; end
  class UsableItem < BaseItem; end
  class UsableItem::Effect; end
  class UsableItem::Damage; end
  class Actor; end
  class Class; end
  class Class::Learning; end
  class Skill < UsableItem; end
  class Item < UsableItem; end
  class Weapon < BaseItem; end
  class Armor < BaseItem; end
  class Enemy; end
  class Enemy::Action; end
  class Enemy::DropItem; end
  class Troop; end
  class Troop::Member; end
  class Troop::Page; end
  class Troop::Page::Condition; end
  class State; end
  class Animation; end
  class Animation::Frame; end
  class Animation::Timing; end
  class CommonEvent; end
  class System; end
  class System::Terms; end
  class System::TestBattler; end
  class System::Vehicle; end
  class Tileset; end
  class Map; end
  class Map::Encounter; end
  class MapInfo; end
  class Event; end
  class EventCommand; end
  class Event::Page; end
  class Event::Page::Condition; end
  class Event::Page::Graphic; end
  class EventPage; end
  class EventPage::Condition; end
  class EventPage::Graphic; end
  class MoveRoute; end
  class MoveCommand; end
  class AudioFile; end
  class BGM < AudioFile; end
  class BGS < AudioFile; end
  class ME < AudioFile; end
  class SE < AudioFile; end
end

module RGSS
  class Table; end
end

# RGSS3 runtime top-level classes with faithful _load/_dump round-trip.
class Table
  def _dump(_depth)
    [@dim || 3, @xsize, @ysize, @zsize, @xsize * @ysize * @zsize].pack("LLLLL") +
      (@data || []).map { |v| v & 0xffff }.pack("S*")
  end

  def self._load(s)
    dim, xsize, ysize, zsize, size = s[0, 20].unpack("LLLLL")
    data = s[20, size * 2].unpack("S*")
    t = allocate
    t.instance_variable_set(:@dim, dim)
    t.instance_variable_set(:@xsize, xsize)
    t.instance_variable_set(:@ysize, ysize)
    t.instance_variable_set(:@zsize, zsize)
    t.instance_variable_set(:@data, data)
    t
  end
end

class Color
  def _dump(_depth)
    [@red, @green, @blue, @alpha].pack("d4")
  end

  def self._load(s)
    r, g, b, a = s.unpack("d4")
    c = allocate
    c.instance_variable_set(:@red, r)
    c.instance_variable_set(:@green, g)
    c.instance_variable_set(:@blue, b)
    c.instance_variable_set(:@alpha, a)
    c
  end
end

class Tone
  def _dump(_depth)
    [@red, @green, @blue, @gray].pack("d4")
  end

  def self._load(s)
    r, g, b, gr = s.unpack("d4")
    t = allocate
    t.instance_variable_set(:@red, r)
    t.instance_variable_set(:@green, g)
    t.instance_variable_set(:@blue, b)
    t.instance_variable_set(:@gray, gr)
    t
  end
end
