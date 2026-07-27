const ROOM_TYPE_ALIASES = Object.freeze({
  "AC Room": "Deluxe",
  "Non AC Room": "Standard"
});

function canonicalRoomType(roomType) {
  const value = String(roomType ?? "").trim();
  return ROOM_TYPE_ALIASES[value] || value;
}

module.exports = { ROOM_TYPE_ALIASES, canonicalRoomType };
